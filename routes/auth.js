const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const User = require('../models/User');
const LoginActivity = require('../models/LoginActivity');
const BackupCode = require('../models/BackupCode');
const { verifyToken: verifyTotpToken } = require('../utils/twofactor');
const { sendVerificationCodeEmail, sendPasswordResetEmail } = require('../utils/mailer');
const passport = require('../config/passport');

// -----------------------------------------------------
// Rate limiter
// -----------------------------------------------------

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please try again later.'
});

// -----------------------------------------------------
// Helpers
// -----------------------------------------------------

function issueToken(res, user) {
  const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET, {
    expiresIn: '7d'
  });

  res.cookie('token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function makeVerifyCode() {
  return crypto.randomInt(0, 1000000).toString().padStart(6, '0');
}

function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}

function getClientIp(req) {
  // req.ip respects "trust proxy" (set in server.js) so this is the real
  // client address even behind Render/Heroku's load balancer.
  return req.ip;
}

// Guards the /auth/google and /auth/facebook entry points so a missing
// GOOGLE_CLIENT_ID / FACEBOOK_APP_ID gives a clear message instead of a
// generic "Unknown authentication strategy" crash.
function requireOAuthConfigured(provider) {
  const configured =
    provider === 'google'
      ? Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET)
      : Boolean(process.env.FACEBOOK_APP_ID && process.env.FACEBOOK_APP_SECRET);

  return (req, res, next) => {
    if (!configured) {
      req.flash('error', `Sign in with ${provider === 'google' ? 'Google' : 'Facebook'} isn't set up yet.`);
      return res.redirect('/login');
    }
    next();
  };
}

// Finishes a login after either a password check or an OAuth callback has
// confirmed who the person is. If 2FA is on, this defers issuing the real
// session and sends them to the code-entry step instead.
async function completeLogin(req, res, { user, method }) {
  if (user.totp_enabled) {
    req.session.pending2FA = { userId: user.id, method };
    return res.redirect('/login/2fa');
  }

  issueToken(res, user);
  await LoginActivity.log({
    userId: user.id,
    method,
    success: true,
    ipAddress: getClientIp(req),
    userAgent: req.get('user-agent')
  });
  res.redirect('/settings');
}

// -----------------------------------------------------
// Username check
// -----------------------------------------------------

router.get('/check-username', async (req, res) => {
  const username = (req.query.username || '').trim();

  if (!User.USERNAME_PATTERN.test(username)) {
    return res.json({
      available: false,
      reason: 'Invalid username format.'
    });
  }

  try {
    const taken = await User.isUsernameTaken(username);
    res.json({
      available: !taken,
      reason: taken ? 'Username already taken' : null
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ available: false });
  }
});

// -----------------------------------------------------
// PAGE RENDERS (GET)
// -----------------------------------------------------

router.get('/login', (req, res) => {
  res.render('login', { title: 'Log in' });
});

router.get('/signup', (req, res) => {
  res.render('signup', { title: 'Sign up', referralCode: (req.query.ref || '').trim() });
});

router.get('/verify-email', (req, res) => {
  const email = req.query.email || req.session.pendingVerifyEmail || '';
  res.render('verify-email', { title: 'Verify email', email });
});

router.get('/forgot-password', (req, res) => {
  res.render('forgot-password', { title: 'Forgot password' });
});

router.get('/reset-password/:token', (req, res) => {
  res.render('reset-password', { title: 'Reset password', token: req.params.token });
});

// -----------------------------------------------------
// SIGNUP
// -----------------------------------------------------

router.post(
  '/signup',
  authLimiter,
  [
    body('name').trim().isLength({ min: 2 }),
    body('username').trim().matches(User.USERNAME_PATTERN),
    body('email').trim().isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('confirmPassword').custom((v, { req }) => v === req.body.password),
    body('agreeTerms').equals('on').withMessage('You must agree to the Terms & Conditions and Privacy Policy to create an account.')
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach(e => req.flash('error', e.msg));
      return res.redirect('/signup');
    }

    const { name, username, email, password } = req.body;
    const referredByCode = (req.body.ref || '').trim() || null;

    try {
      const existing = await User.findByEmail(email);

      if (existing && existing.is_verified) {
        req.flash('error', 'Email already exists');
        return res.redirect('/signup');
      }

      if (!existing && (await User.isUsernameTaken(username))) {
        req.flash('error', 'Username already taken');
        return res.redirect('/signup');
      }

      const hashed = await bcrypt.hash(password, 12);
      const code = makeVerifyCode();
      const expires = new Date(Date.now() + 10 * 60 * 1000);

      if (existing) {
        // Unverified account from a previous incomplete signup attempt
        // (e.g. the verification email failed to send last time).
        // Reuse it instead of blocking the person from ever retrying.
        await User.updateProfile(existing.id, { name, username, email });
        await User.setVerifyToken(existing.id, code, expires);
        const pool = require('../config/db');
        await pool.query('UPDATE users SET password = ? WHERE id = ?', [hashed, existing.id]);
      } else {
        await User.create({
          name,
          username,
          email,
          password: hashed,
          verifyToken: code,
          verifyTokenExpires: expires,
          referredByCode
        });
      }

      req.session.pendingVerifyEmail = email;

      try {
        await sendVerificationCodeEmail(email, code);
        req.flash('success', 'Check your email for the 6-digit code');
      } catch (mailErr) {
        // Account exists and has a valid code even if the email didn't arrive.
        // Don't strand the person on a "failed" signup page.
        console.error('Verification email failed to send:', mailErr);
        req.flash('error', 'Account created, but the verification email could not be sent. Tap "resend" on the next page.');
      }

      res.redirect('/verify-email');

    } catch (err) {
      console.error(err);
      req.flash('error', 'Signup failed');
      res.redirect('/signup');
    }
  }
);

// -----------------------------------------------------
// VERIFY EMAIL
// -----------------------------------------------------

router.post(
  '/verify-email',
  authLimiter,
  [
    body('email').isEmail().normalizeEmail(),
    body('code').isLength({ min: 6, max: 6 }).isNumeric()
  ],
  async (req, res) => {
    const { email, code } = req.body;

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach(e => req.flash('error', e.msg));
      return res.redirect(`/verify-email?email=${encodeURIComponent(email)}`);
    }

    try {
      const user = await User.findByEmailAndVerifyCode(email, code);

      if (!user) {
        req.flash('error', 'Invalid or expired code');
        return res.redirect(`/verify-email?email=${encodeURIComponent(email)}`);
      }

      await User.markVerified(user.id);
      req.session.pendingVerifyEmail = null;

      req.flash('success', 'Email verified. You can now log in.');
      res.redirect('/login');

    } catch (err) {
      console.error(err);
      req.flash('error', 'Verification failed');
      res.redirect(`/verify-email?email=${encodeURIComponent(email)}`);
    }
  }
);

// -----------------------------------------------------
// RESEND OTP
// -----------------------------------------------------

router.post('/resend-verification', authLimiter, async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findByEmail(email);

    req.session.pendingVerifyEmail = email;

    if (user && !user.is_verified) {
      const code = makeVerifyCode();
      const expires = new Date(Date.now() + 10 * 60 * 1000);

      await User.setVerifyToken(user.id, code, expires);
      await sendVerificationCodeEmail(email, code);
    }

    req.flash('success', 'If account exists, a new code was sent');
    res.redirect(`/verify-email?email=${encodeURIComponent(email)}`);

  } catch (err) {
    console.error(err);
    req.flash('error', 'Could not resend code');
    res.redirect('/verify-email');
  }
});

// -----------------------------------------------------
// LOGIN
// -----------------------------------------------------

router.post(
  '/login',
  authLimiter,
  [body('email').isEmail().normalizeEmail(), body('password').notEmpty()],
  async (req, res) => {
    const { email, password } = req.body;

    try {
      const user = await User.findByEmail(email);

      if (!user) {
        req.flash('error', 'Invalid credentials');
        return res.redirect('/login');
      }

      if (!user.password) {
        req.flash('error', 'This account signs in with Google or Facebook. Use the button below instead.');
        return res.redirect('/login');
      }

      const match = await bcrypt.compare(password, user.password);

      if (!match) {
        req.flash('error', 'Invalid credentials');
        return res.redirect('/login');
      }

      if (!user.is_verified) {
        const code = makeVerifyCode();
        const expires = new Date(Date.now() + 10 * 60 * 1000);

        await User.setVerifyToken(user.id, code, expires);
        await sendVerificationCodeEmail(email, code);

        req.session.pendingVerifyEmail = email;

        req.flash('error', 'Verify your email. New code sent.');
        return res.redirect(`/verify-email?email=${encodeURIComponent(email)}`);
      }

      await completeLogin(req, res, { user, method: 'password' });

    } catch (err) {
      console.error(err);
      req.flash('error', 'Login failed');
      res.redirect('/login');
    }
  }
);

// -----------------------------------------------------
// TWO-FACTOR AUTHENTICATION STEP (after password or OAuth check)
// -----------------------------------------------------

router.get('/login/2fa', (req, res) => {
  if (!req.session.pending2FA) {
    return res.redirect('/login');
  }
  res.render('login-2fa', { title: 'Two-factor verification' });
});

router.post('/login/2fa', authLimiter, async (req, res) => {
  const pending = req.session.pending2FA;
  if (!pending) {
    req.flash('error', 'Your session expired. Please log in again.');
    return res.redirect('/login');
  }

  const code = (req.body.code || '').trim();
  if (!code) {
    req.flash('error', 'Enter the 6-digit code or a backup code.');
    return res.redirect('/login/2fa');
  }

  try {
    const user = await User.findById(pending.userId);
    if (!user || !user.totp_enabled) {
      req.session.pending2FA = null;
      req.flash('error', 'Two-factor authentication is no longer enabled on this account.');
      return res.redirect('/login');
    }

    // Backup codes look like "3f9a-2b7c1d"; TOTP codes are 6 plain digits.
    const isBackupCode = code.includes('-');
    const valid = isBackupCode
      ? await BackupCode.consume(user.id, code)
      : verifyTotpToken(user.totp_secret, code);

    if (!valid) {
      req.flash('error', 'That code is incorrect or has expired.');
      return res.redirect('/login/2fa');
    }

    req.session.pending2FA = null;
    issueToken(res, user);
    await LoginActivity.log({
      userId: user.id,
      method: pending.method,
      success: true,
      ipAddress: getClientIp(req),
      userAgent: req.get('user-agent')
    });
    res.redirect('/settings');

  } catch (err) {
    console.error('2FA verification failed:', err.message);
    req.flash('error', 'Something went wrong verifying that code.');
    res.redirect('/login/2fa');
  }
});

// -----------------------------------------------------
// SOCIAL LOGIN — GOOGLE
// -----------------------------------------------------

router.get(
  '/auth/google',
  requireOAuthConfigured('google'),
  (req, res, next) => {
    req.session.pendingReferralCode = (req.query.ref || '').trim() || null;
    next();
  },
  passport.authenticate('google', { scope: ['profile', 'email'], session: false })
);

router.get(
  '/auth/google/callback',
  requireOAuthConfigured('google'),
  passport.authenticate('google', { session: false, failureRedirect: '/login' }),
  async (req, res) => {
    try {
      await completeLogin(req, res, { user: req.user, method: 'google' });
    } catch (err) {
      console.error('Google login failed:', err.message);
      req.flash('error', 'Could not sign you in with Google. Please try again.');
      res.redirect('/login');
    }
  }
);

// -----------------------------------------------------
// SOCIAL LOGIN — FACEBOOK
// -----------------------------------------------------

router.get(
  '/auth/facebook',
  requireOAuthConfigured('facebook'),
  (req, res, next) => {
    req.session.pendingReferralCode = (req.query.ref || '').trim() || null;
    next();
  },
  passport.authenticate('facebook', { scope: ['email'], session: false })
);

router.get(
  '/auth/facebook/callback',
  requireOAuthConfigured('facebook'),
  passport.authenticate('facebook', { session: false, failureRedirect: '/login' }),
  async (req, res) => {
    try {
      await completeLogin(req, res, { user: req.user, method: 'facebook' });
    } catch (err) {
      console.error('Facebook login failed:', err.message);
      req.flash('error', 'Could not sign you in with Facebook. Please try again.');
      res.redirect('/login');
    }
  }
);

// -----------------------------------------------------
// LOGOUT
// -----------------------------------------------------

router.post('/logout', (req, res) => {
  res.clearCookie('token');
  req.flash('success', 'Logged out');
  res.redirect('/login');
});

// -----------------------------------------------------
// FORGOT PASSWORD
// -----------------------------------------------------

router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;

  try {
    const user = await User.findByEmail(email);

    if (user) {
      const token = makeToken();
      const expires = new Date(Date.now() + 60 * 60 * 1000);

      await User.setResetToken(user.id, token, expires);

      const link = `${process.env.APP_URL}/reset-password/${token}`;
      await sendPasswordResetEmail(email, link);
    }

    req.flash('success', 'If email exists, reset link sent');
    res.redirect('/login');

  } catch (err) {
    console.error(err);
    req.flash('error', 'Failed request');
    res.redirect('/forgot-password');
  }
});

// -----------------------------------------------------
// RESET PASSWORD
// -----------------------------------------------------

router.post(
  '/reset-password/:token',
  authLimiter,
  [
    body('password').isLength({ min: 8 }),
    body('confirmPassword').custom((v, { req }) => v === req.body.password)
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      errors.array().forEach(e => req.flash('error', e.msg));
      return res.redirect(`/reset-password/${req.params.token}`);
    }

    try {
      const user = await User.findByResetToken(req.params.token);

      if (!user) {
        req.flash('error', 'Invalid or expired link');
        return res.redirect('/forgot-password');
      }

      const hashed = await bcrypt.hash(req.body.password, 12);
      await User.updatePassword(user.id, hashed);

      req.flash('success', 'Password updated');
      res.redirect('/login');

    } catch (err) {
      console.error(err);
      req.flash('error', 'Reset failed');
      res.redirect('/forgot-password');
    }
  }
);

module.exports = router;
