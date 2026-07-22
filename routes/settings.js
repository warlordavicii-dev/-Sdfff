const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { body, validationResult } = require('express-validator');

const User = require('../models/User');
const LoginActivity = require('../models/LoginActivity');
const BackupCode = require('../models/BackupCode');
const CoinTransaction = require('../models/CoinTransaction');
const Complaint = require('../models/Complaint');
const { requireAuth } = require('../middleware/auth');
const { avatarUpload } = require('../middleware/upload');
const { describe: describeUserAgent } = require('../utils/useragent');
const {
  generateSecret,
  keyUri,
  qrCodeDataUrl,
  verifyToken: verifyTotpToken,
  generateBackupCodes
} = require('../utils/twofactor');
const { sendVerificationCodeEmail, sendComplaintEmail, sendCoinsReceivedEmail } = require('../utils/mailer');

const DAILY_COINS_AMOUNT = 5;
const REFERRAL_BONUS_AMOUNT = 10;

router.get('/settings', requireAuth, async (req, res) => {
  const activity = await LoginActivity.listForUser(req.user.id, 10);
  const backupCodesRemaining = req.user.totp_enabled
    ? await BackupCode.countRemaining(req.user.id)
    : 0;

  const referralCode = await User.ensureReferralCode(req.user.id);
  const [coinHistory, referralCount] = await Promise.all([
    CoinTransaction.listForUser(req.user.id, 15),
    User.countReferrals(req.user.id)
  ]);
  const nextDailyClaimAt = User.nextDailyClaimAt(req.user);

  res.render('settings', {
    title: 'Account settings',
    loginActivity: activity.map((a) => ({ ...a, deviceLabel: describeUserAgent(a.user_agent) })),
    backupCodesRemaining,
    referralCode,
    referralLink: `${process.env.APP_URL}/signup?ref=${referralCode}`,
    referralCount,
    referralBonusAmount: REFERRAL_BONUS_AMOUNT,
    dailyCoinsAmount: DAILY_COINS_AMOUNT,
    canClaimDaily: !nextDailyClaimAt,
    nextDailyClaimAt,
    coinHistory
  });
});

// ---------- UPDATE PROFILE (name / username / email) ----------
router.post(
  '/settings/profile',
  requireAuth,
  [
    body('name').trim().isLength({ min: 2 }).withMessage('Name must be at least 2 characters.'),
    body('username')
      .trim()
      .matches(User.USERNAME_PATTERN)
      .withMessage('Username must be 3-32 characters: letters, numbers, or underscores only.'),
    body('email').trim().isEmail().withMessage('Enter a valid email address.').normalizeEmail()
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach((e) => req.flash('error', e.msg));
      return res.redirect('/settings');
    }

    const { name, username, email } = req.body;
    try {
      if (username !== req.user.username) {
        const usernameTaken = await User.isUsernameTaken(username, req.user.id);
        if (usernameTaken) {
          req.flash('error', 'That username is already taken.');
          return res.redirect('/settings');
        }
      }

      if (email !== req.user.email) {
        const existing = await User.findByEmail(email);
        if (existing) {
          req.flash('error', 'That email is already in use by another account.');
          return res.redirect('/settings');
        }

        // Changing email requires re-verification
        const verifyToken = crypto.randomInt(0, 1000000).toString().padStart(6, '0');
        const verifyTokenExpires = new Date(Date.now() + 10 * 60 * 1000);
        await User.updateProfile(req.user.id, { name, username, email });
        await User.setVerifyToken(req.user.id, verifyToken, verifyTokenExpires);
        // mark unverified again
        const pool = require('../config/db');
        await pool.query('UPDATE users SET is_verified = 0 WHERE id = ?', [req.user.id]);

        await sendVerificationCodeEmail(email, verifyToken);

        res.clearCookie('token');
        req.flash('success', 'Profile updated. Please verify your new email address, then log in again.');
        return res.redirect(`/verify-email?email=${encodeURIComponent(email)}`);
      }

      await User.updateProfile(req.user.id, { name, username, email });
      req.flash('success', 'Profile updated successfully.');
      res.redirect('/settings');
    } catch (err) {
      console.error(err);
      req.flash('error', 'Something went wrong updating your profile.');
      res.redirect('/settings');
    }
  }
);

// ---------- CHANGE PASSWORD ----------
router.post(
  '/settings/password',
  requireAuth,
  [
    body('currentPassword').notEmpty().withMessage('Enter your current password.'),
    body('newPassword').isLength({ min: 8 }).withMessage('New password must be at least 8 characters.'),
    body('confirmPassword').custom((value, { req }) => value === req.body.newPassword).withMessage('New passwords do not match.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach((e) => req.flash('error', e.msg));
      return res.redirect('/settings');
    }

    try {
      if (!req.user.password) {
        req.flash('error', "This account doesn't have a password yet (you signed in with Google or Facebook). Set one from a fresh sign-in first.");
        return res.redirect('/settings');
      }

      const match = await bcrypt.compare(req.body.currentPassword, req.user.password);
      if (!match) {
        req.flash('error', 'Current password is incorrect.');
        return res.redirect('/settings');
      }

      const hashed = await bcrypt.hash(req.body.newPassword, 12);
      await User.updatePassword(req.user.id, hashed);
      req.flash('success', 'Password changed successfully.');
      res.redirect('/settings');
    } catch (err) {
      console.error(err);
      req.flash('error', 'Something went wrong changing your password.');
      res.redirect('/settings');
    }
  }
);

// -----------------------------------------------------
// AVATAR
// -----------------------------------------------------

function isLocalAvatarPath(url) {
  return typeof url === 'string' && url.startsWith('/uploads/avatars/');
}

function deleteLocalAvatar(url) {
  if (!isLocalAvatarPath(url)) return; // never try to delete a Google/Facebook photo URL
  const filePath = path.join(__dirname, '..', 'public', url);
  fs.unlink(filePath, (err) => {
    if (err && err.code !== 'ENOENT') console.error('Failed to delete old avatar:', err.message);
  });
}

router.post('/settings/avatar', requireAuth, (req, res) => {
  avatarUpload.single('avatar')(req, res, async (err) => {
    if (err) {
      req.flash('error', err.message || 'Could not upload that image.');
      return res.redirect('/settings');
    }
    if (!req.file) {
      req.flash('error', 'Choose an image to upload.');
      return res.redirect('/settings');
    }

    try {
      const oldAvatar = req.user.avatar_url;
      const newAvatarUrl = `/uploads/avatars/${req.file.filename}`;
      await User.setAvatar(req.user.id, newAvatarUrl);
      deleteLocalAvatar(oldAvatar);
      req.flash('success', 'Profile photo updated.');
    } catch (dbErr) {
      console.error('Avatar update failed:', dbErr.message);
      fs.unlink(req.file.path, () => {});
      req.flash('error', 'Could not save your new photo. Please try again.');
    }
    res.redirect('/settings');
  });
});

router.post('/settings/avatar/remove', requireAuth, async (req, res) => {
  try {
    const oldAvatar = await User.clearAvatar(req.user.id);
    deleteLocalAvatar(oldAvatar);
    req.flash('success', 'Profile photo removed.');
  } catch (err) {
    console.error('Avatar removal failed:', err.message);
    req.flash('error', 'Could not remove your photo.');
  }
  res.redirect('/settings');
});

// -----------------------------------------------------
// TWO-FACTOR AUTHENTICATION
// -----------------------------------------------------

// Step 1: generate a secret + QR code for the user to scan.
router.get('/settings/2fa/setup', requireAuth, async (req, res) => {
  if (req.user.totp_enabled) {
    req.flash('error', 'Two-factor authentication is already enabled.');
    return res.redirect('/settings');
  }

  try {
    const secret = generateSecret();
    await User.startTotpSetup(req.user.id, secret);

    const otpAuthUrl = keyUri(req.user.email, process.env.APP_NAME, secret);
    const qrDataUrl = await qrCodeDataUrl(otpAuthUrl);

    res.render('twofactor-setup', {
      title: 'Set up two-factor authentication',
      secret,
      qrDataUrl
    });
  } catch (err) {
    console.error('2FA setup failed:', err.message);
    req.flash('error', 'Could not start 2FA setup. Please try again.');
    res.redirect('/settings');
  }
});

// Step 2: confirm the code from the authenticator app, then show backup codes once.
router.post(
  '/settings/2fa/enable',
  requireAuth,
  [body('code').trim().isLength({ min: 6, max: 6 }).isNumeric().withMessage('Enter the 6-digit code from your app.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/settings/2fa/setup');
    }

    try {
      const user = await User.findById(req.user.id);
      if (!user.totp_secret) {
        req.flash('error', 'Start 2FA setup again before confirming a code.');
        return res.redirect('/settings/2fa/setup');
      }

      if (!verifyTotpToken(user.totp_secret, req.body.code)) {
        req.flash('error', 'That code did not match. Please try again.');
        return res.redirect('/settings/2fa/setup');
      }

      await User.enableTotp(user.id);
      const backupCodes = generateBackupCodes();
      await BackupCode.replaceAll(user.id, backupCodes);

      res.render('twofactor-backup-codes', {
        title: 'Your backup codes',
        backupCodes
      });
    } catch (err) {
      console.error('2FA enable failed:', err.message);
      req.flash('error', 'Could not enable two-factor authentication.');
      res.redirect('/settings');
    }
  }
);

// Regenerates backup codes (invalidates old ones) without touching TOTP itself.
router.post('/settings/2fa/backup-codes/regenerate', requireAuth, async (req, res) => {
  if (!req.user.totp_enabled) {
    req.flash('error', 'Enable two-factor authentication first.');
    return res.redirect('/settings');
  }

  try {
    const backupCodes = generateBackupCodes();
    await BackupCode.replaceAll(req.user.id, backupCodes);
    res.render('twofactor-backup-codes', {
      title: 'Your new backup codes',
      backupCodes
    });
  } catch (err) {
    console.error('Backup code regeneration failed:', err.message);
    req.flash('error', 'Could not generate new backup codes.');
    res.redirect('/settings');
  }
});

router.post(
  '/settings/2fa/disable',
  requireAuth,
  [body('currentPassword').custom((value, { req }) => {
    // Only require a password if the account actually has one — social-only
    // accounts (Google/Facebook, no password set) skip this check.
    if (req.user.password && !value) {
      throw new Error('Enter your current password to disable 2FA.');
    }
    return true;
  })],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/settings');
    }

    try {
      if (req.user.password) {
        const match = await bcrypt.compare(req.body.currentPassword || '', req.user.password);
        if (!match) {
          req.flash('error', 'Current password is incorrect.');
          return res.redirect('/settings');
        }
      }

      await User.disableTotp(req.user.id);
      await BackupCode.deleteAllForUser(req.user.id);
      req.flash('success', 'Two-factor authentication has been disabled.');
    } catch (err) {
      console.error('2FA disable failed:', err.message);
      req.flash('error', 'Could not disable two-factor authentication.');
    }
    res.redirect('/settings');
  }
);

// -----------------------------------------------------
// COINS: DAILY CLAIM
// -----------------------------------------------------

router.post('/settings/coins/claim-daily', requireAuth, async (req, res) => {
  try {
    const claimed = await User.claimDailyCoins(req.user.id, DAILY_COINS_AMOUNT);
    if (!claimed) {
      req.flash('error', "You've already claimed your daily coins. Come back in 24 hours.");
      return res.redirect('/settings');
    }

    await CoinTransaction.log({
      userId: req.user.id,
      type: 'daily_claim',
      amount: DAILY_COINS_AMOUNT,
      note: 'Daily coin claim'
    });

    req.flash('success', `+${DAILY_COINS_AMOUNT} coins claimed!`);
  } catch (err) {
    console.error('Daily claim failed:', err.message);
    req.flash('error', 'Could not claim your daily coins. Please try again.');
  }
  res.redirect('/settings');
});

// -----------------------------------------------------
// COINS: TRANSFER TO ANOTHER ACCOUNT (by email)
// -----------------------------------------------------

router.post(
  '/settings/coins/transfer',
  requireAuth,
  [
    body('recipientEmail').trim().isEmail().withMessage('Enter a valid recipient email.').normalizeEmail(),
    body('amount').isInt({ min: 1 }).withMessage('Enter a whole number of coins to send.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/settings');
    }

    const amount = parseInt(req.body.amount, 10);
    const recipientEmail = req.body.recipientEmail;

    try {
      if (recipientEmail === req.user.email) {
        req.flash('error', "You can't send coins to yourself.");
        return res.redirect('/settings');
      }

      const recipient = await User.findByEmail(recipientEmail);
      if (!recipient) {
        req.flash('error', 'No account found with that email.');
        return res.redirect('/settings');
      }

      if (req.user.coins < amount) {
        req.flash('error', "You don't have enough coins for that transfer.");
        return res.redirect('/settings');
      }

      const success = await User.transferCoins({ fromId: req.user.id, toId: recipient.id, amount });
      if (!success) {
        req.flash('error', "You don't have enough coins for that transfer.");
        return res.redirect('/settings');
      }

      await Promise.all([
        CoinTransaction.log({
          userId: req.user.id,
          type: 'transfer_out',
          amount,
          counterpartyUserId: recipient.id,
          note: `Sent to ${recipient.email}`
        }),
        CoinTransaction.log({
          userId: recipient.id,
          type: 'transfer_in',
          amount,
          counterpartyUserId: req.user.id,
          note: `Received from ${req.user.email}`
        })
      ]);

      // Best-effort notification — a failed email shouldn't undo a
      // successful, already-committed transfer.
      sendCoinsReceivedEmail(recipient.email, { fromName: req.user.name, amount }).catch((err) => {
        console.error('Coin transfer notification email failed:', err.message);
      });

      req.flash('success', `Sent ${amount} coins to ${recipient.username}.`);
    } catch (err) {
      console.error('Coin transfer failed:', err.message);
      req.flash('error', 'Something went wrong sending those coins.');
    }
    res.redirect('/settings');
  }
);

// -----------------------------------------------------
// COMPLAINTS
// -----------------------------------------------------

router.post(
  '/settings/complaint',
  requireAuth,
  [
    body('subject').trim().isLength({ min: 3, max: 190 }).withMessage('Enter a short subject.'),
    body('message').trim().isLength({ min: 10, max: 4000 }).withMessage('Please provide a bit more detail (10+ characters).')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/settings');
    }

    const { subject, message } = req.body;

    try {
      await Complaint.create({ userId: req.user.id, email: req.user.email, subject, message });

      try {
        await sendComplaintEmail({ fromEmail: req.user.email, fromName: req.user.name, subject, message });
      } catch (mailErr) {
        // The complaint is safely stored either way — the inbox copy is a
        // convenience, not the source of truth.
        console.error('Complaint email failed to send:', mailErr.message);
      }

      req.flash('success', "Thanks — your complaint has been sent. We'll get back to you.");
    } catch (err) {
      console.error('Complaint submission failed:', err.message);
      req.flash('error', 'Could not submit your complaint. Please try again.');
    }
    res.redirect('/settings');
  }
);

// -----------------------------------------------------
// DELETE ACCOUNT
// -----------------------------------------------------

router.post(
  '/settings/delete-account',
  requireAuth,
  [body('confirmDelete').equals('DELETE').withMessage('Type DELETE to confirm.')],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      req.flash('error', errors.array()[0].msg);
      return res.redirect('/settings');
    }

    try {
      if (req.user.password) {
        const match = await bcrypt.compare(req.body.currentPassword || '', req.user.password);
        if (!match) {
          req.flash('error', 'Current password is incorrect.');
          return res.redirect('/settings');
        }
      }

      const oldAvatar = req.user.avatar_url;
      await User.deleteAccount(req.user.id);
      deleteLocalAvatar(oldAvatar);

      res.clearCookie('token');
      req.flash('success', 'Your account has been deleted.');
      res.redirect('/login');
    } catch (err) {
      console.error('Account deletion failed:', err.message);
      req.flash('error', 'Could not delete your account. Please try again.');
      res.redirect('/settings');
    }
  }
);

module.exports = router;
