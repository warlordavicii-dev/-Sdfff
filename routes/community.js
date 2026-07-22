const express = require('express');
const router = express.Router();
const { body, query, validationResult } = require('express-validator');

const { requireAuth } = require('../middleware/auth');
const CommunityMessage = require('../models/CommunityMessage');

const MAX_MESSAGE_LENGTH = 500;
const HISTORY_LIMIT = 50;

function serialize(msg) {
  return {
    id: msg.id,
    username: msg.username,
    body: msg.body,
    createdAt: msg.created_at,
    replyToId: msg.reply_to_id,
    replyUsername: msg.reply_username || null,
    replyBody: msg.reply_body || null
  };
}

// ---------- COMMUNITY PAGE ----------
router.get('/community', requireAuth, async (req, res) => {
  const messages = await CommunityMessage.listRecent(HISTORY_LIMIT);
  res.render('community', {
    title: 'Community',
    messages,
    maxLength: MAX_MESSAGE_LENGTH
  });
});

// ---------- POST A MESSAGE (or reply) ----------
router.post(
  '/community/messages',
  requireAuth,
  [
    body('body').trim().notEmpty().withMessage('Message cannot be empty').isLength({ max: MAX_MESSAGE_LENGTH }).withMessage(`Keep messages under ${MAX_MESSAGE_LENGTH} characters`),
    body('replyToId').optional({ values: 'falsy' }).isInt().toInt()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    try {
      let replyToId = req.body.replyToId || null;
      if (replyToId) {
        // Make sure whatever's being replied to actually exists so we don't
        // store a dangling reference.
        const target = await CommunityMessage.findById(replyToId);
        if (!target) replyToId = null;
      }

      const msg = await CommunityMessage.create({
        userId: req.user.id,
        username: req.user.username,
        body: req.body.body,
        replyToId
      });

      res.json({ message: serialize(msg) });
    } catch (err) {
      console.error('Failed to post community message:', err.message);
      res.status(500).json({ error: 'Could not send your message. Please try again.' });
    }
  }
);

// ---------- POLL FOR NEW MESSAGES ----------
router.get(
  '/community/messages/poll',
  requireAuth,
  [query('after').optional().isInt().toInt()],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ error: 'Invalid request' });
    }

    try {
      const afterId = req.query.after || 0;
      const messages = await CommunityMessage.listSince(afterId, HISTORY_LIMIT);
      res.json({ messages: messages.map(serialize) });
    } catch (err) {
      console.error('Failed to poll community messages:', err.message);
      res.status(500).json({ error: 'Could not check for new messages.' });
    }
  }
);

module.exports = router;
