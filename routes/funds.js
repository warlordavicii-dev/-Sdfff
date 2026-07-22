const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');

const { requireAuth } = require('../middleware/auth');
const Wallet = require('../models/Wallet');
const Transaction = require('../models/Transaction');
const isend = require('../utils/intasend');

const MIN_AMOUNT_KES = 10;
const MAX_AMOUNT_KES = 150000; // adjust to your KYC tier's limits

function toCents(kes) {
  return Math.round(Number(kes) * 100);
}

function newTxRef(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// ---------- FUNDS DASHBOARD ----------
router.get('/funds', requireAuth, async (req, res) => {
  // If the person is bouncing back from a hosted checkout redirect, confirm
  // that specific transaction now rather than waiting for the webhook.
  const { invoice_id } = req.query;
  if (invoice_id) {
    await confirmDepositByInvoice(invoice_id).catch((err) => {
      console.error('Deposit confirmation on redirect failed:', err.message);
    });
  }

  const wallet = await Wallet.getOrCreate(req.user.id);
  const transactions = await Transaction.listForUser(req.user.id, 20);

  res.render('funds', {
    title: 'Funds',
    wallet,
    transactions,
    minAmount: MIN_AMOUNT_KES,
    maxAmount: MAX_AMOUNT_KES
  });
});

// ---------- DEPOSIT ----------
router.post(
  '/funds/deposit',
  requireAuth,
  [
    body('channel').isIn(['mpesa', 'bank']),
    body('amount').isFloat({ min: MIN_AMOUNT_KES, max: MAX_AMOUNT_KES }),
    body('phone')
      .if(body('channel').equals('mpesa'))
      .matches(/^2547\d{8}$|^2541\d{8}$/)
      .withMessage('Enter phone as 2547XXXXXXXX or 2541XXXXXXXX')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach((e) => req.flash('error', e.msg));
      return res.redirect('/funds');
    }

    const { channel, phone } = req.body;
    const amountKES = Number(req.body.amount);
    const txRef = newTxRef('DEP');

    try {
      await Transaction.create({
        userId: req.user.id,
        type: 'deposit',
        channel,
        amountCents: toCents(amountKES),
        txRef,
        destination: channel === 'bank' ? 'hosted-checkout' : phone
      });

      if (channel === 'mpesa') {
        await isend.chargeMpesaSTK({
          txRef,
          amount: amountKES,
          phoneNumber: phone
        });
        req.flash('success', 'Check your phone to approve the payment prompt.');
        return res.redirect('/funds');
      }

      // Bank / card -> hosted checkout, IntaSend redirects back to /funds
      const redirectUrl = `${process.env.APP_URL}/funds`;
      const checkout = await isend.createHostedCheckout({
        txRef,
        amount: amountKES,
        email: req.user.email,
        name: req.user.name,
        redirectUrl
      });

      const checkoutUrl = checkout.url || (checkout.data && checkout.data.url);
      if (!checkoutUrl) {
        throw new Error('IntaSend did not return a checkout link');
      }

      return res.redirect(checkoutUrl);
    } catch (err) {
  console.error('Deposit initiation failed');
  console.error(err);
  console.error(err.message);

  await Transaction.markFailed(txRef, err.message);

  req.flash('error', err.message);

  return res.redirect('/funds');
}
  }
);

// ---------- WITHDRAW ----------
router.post(
  '/funds/withdraw',
  requireAuth,
  [
    body('channel').isIn(['mpesa', 'bank']),
    body('amount').isFloat({ min: MIN_AMOUNT_KES, max: MAX_AMOUNT_KES }),
    body('accountNumber').trim().notEmpty().withMessage('Enter a phone number or account number'),
    body('bankCode')
      .if(body('channel').equals('bank'))
      .trim()
      .notEmpty()
      .withMessage('Enter your bank code')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach((e) => req.flash('error', e.msg));
      return res.redirect('/funds');
    }

    const { channel, accountNumber } = req.body;
    const amountKES = Number(req.body.amount);
    const amountCents = toCents(amountKES);
    const txRef = newTxRef('WD');

    const hasFunds = await Wallet.debitIfSufficient(req.user.id, amountCents);
    if (!hasFunds) {
      req.flash('error', 'Insufficient balance for that withdrawal.');
      return res.redirect('/funds');
    }

    try {
      await Transaction.create({
        userId: req.user.id,
        type: 'withdrawal',
        channel,
        amountCents,
        txRef,
        destination: accountNumber
      });

      await isend.initiateTransfer({
        txRef,
        amount: amountKES,
        channel,
        accountNumber,
        bankCode: channel === 'bank' ? req.body.bankCode : undefined,
        beneficiaryName: req.user.name
      });

      req.flash('success', 'Withdrawal is processing — it may take a few minutes.');
    } catch (err) {
      console.error('Withdrawal failed:', err.message);
      await Transaction.markFailed(txRef, err.message);
      await Wallet.refund(req.user.id, amountCents);
      req.flash('error', 'Withdrawal could not be processed. Your balance has been restored.');
    }

    res.redirect('/funds');
  }
);

// ---------- SHARED CONFIRMATION LOGIC (deposits) ----------
// Always re-verifies against IntaSend's own record before crediting — never
// trusts a webhook payload or redirect query string by itself.
async function confirmDepositByInvoice(invoiceId) {
  const info = await isend.verifyPayment(invoiceId);
  const txRef = info.api_ref;
  if (!txRef) return;

  const txn = await Transaction.findByRef(txRef);
  if (!txn || txn.status !== 'pending') return; // already handled, or unknown ref

  const amountMatches = Math.round(Number(info.value ?? info.net_amount ?? 0) * 100) === Number(txn.amount_cents);
  const isGood = info.state === 'COMPLETE' && info.currency === 'KES' && amountMatches;

  if (isGood) {
    await Wallet.credit(txn.user_id, txn.amount_cents);
    await Transaction.markSuccessful(txRef, String(invoiceId));
  } else if (info.state === 'FAILED') {
    await Transaction.markFailed(txRef, info.failed_reason || `Payment failed with state: ${info.state}`);
  }
  // PENDING / PROCESSING states are left as-is; a later webhook call or
  // redirect check will resolve them.
}

// ---------- INTASEND WEBHOOK ----------
// Registered without requireAuth — IntaSend calls this directly.
// Mount this router's raw path in server.js BEFORE any auth-only middleware
// blocks it. IntaSend signs webhooks with a "challenge" string you set in
// your dashboard, sent back verbatim on every event — compare it here.
router.post('/webhooks/intasend', express.json(), async (req, res) => {
  const payload = req.body;

  if (!payload.challenge || payload.challenge !== process.env.INTASEND_WEBHOOK_CHALLENGE) {
    return res.status(401).send('Invalid signature');
  }

  try {
    if (payload.invoice_id && payload.state) {
      // Payment collection (deposit) event
      await confirmDepositByInvoice(payload.invoice_id);
    } else if (Array.isArray(payload.transactions)) {
      // Send money (withdrawal) event
      for (const t of payload.transactions) {
        const txRef = t.idempotency_key;
        if (!txRef) continue;

        const txn = await Transaction.findByRef(txRef);
        if (!txn || txn.status !== 'pending') continue;

        const status = String(t.status || '').toLowerCase();
        if (status === 'successful') {
          await Transaction.markSuccessful(txRef, t.transaction_id || t.provider_reference);
        } else if (status === 'failed') {
          await Transaction.markFailed(txRef, t.status_description || 'Transfer failed at provider');
          await Wallet.refund(txn.user_id, txn.amount_cents);
        }
      }
    }
    res.status(200).send('OK');
  } catch (err) {
    console.error('Webhook handling error:', err.message);
    // Still 200 so IntaSend doesn't hammer retries for a problem on our end
    // that a human needs to look at; the error is already logged above.
    res.status(200).send('logged');
  }
});

module.exports = router;
