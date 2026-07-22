const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');

const { requireAuth } = require('../middleware/auth');
const { askAssistant } = require('../utils/anthropic');

const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_MESSAGES = 16; // ~8 exchanges — keeps token usage/cost bounded
const MAX_MESSAGES_PER_SESSION = 40; // simple abuse guard

const WELCOME_MESSAGE =
  "Hi! I'm the VaultGate Assistant. Ask me anything about depositing or withdrawing funds, the Community chat, or your account settings.";

// ---------- ASSISTANT PAGE ----------
router.get('/assistant', requireAuth, (req, res) => {
  if (!req.session.assistantHistory) {
    req.session.assistantHistory = [];
  }
  res.render('assistant', {
    title: 'Assistant',
    welcomeMessage: WELCOME_MESSAGE,
    history: req.session.assistantHistory
  });
});

// ---------- SEND A MESSAGE ----------
router.post(
  '/assistant/message',
  requireAuth,
  [
    body('message')
      .trim()
      .notEmpty()
      .withMessage('Message cannot be empty')
      .isLength({ max: MAX_MESSAGE_LENGTH })
      .withMessage(`Keep messages under ${MAX_MESSAGE_LENGTH} characters`)
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(503).json({ error: 'The assistant is not configured yet. Please contact support.' });
    }

    if (!req.session.assistantHistory) req.session.assistantHistory = [];
    const history = req.session.assistantHistory;

    if (history.length >= MAX_MESSAGES_PER_SESSION) {
      return res.status(429).json({ error: 'You have reached the chat limit for this session. Please refresh to start a new one.' });
    }

    const userMessage = { role: 'user', content: req.body.message };
    history.push(userMessage);

    try {
      // Only send the trailing window of history to the API to keep
      // requests small and predictable in cost.
      const reply = await askAssistant(history.slice(-MAX_HISTORY_MESSAGES));
      history.push({ role: 'assistant', content: reply });
      req.session.assistantHistory = history.slice(-MAX_HISTORY_MESSAGES);

      res.json({ reply });
    } catch (err) {
      console.error('Assistant request failed:', err.message);
      // Don't keep a dangling user message with no reply in history.
      history.pop();
      res.status(500).json({ error: 'The assistant is temporarily unavailable. Please try again shortly.' });
    }
  }
);

// ---------- RESET CONVERSATION ----------
router.post('/assistant/reset', requireAuth, (req, res) => {
  req.session.assistantHistory = [];
  res.json({ ok: true });
});

module.exports = router;
