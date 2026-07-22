const crypto = require('crypto');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');

// A little clock drift between the user's phone and the server is normal,
// so allow one 30-second step on either side before rejecting a code.
authenticator.options = { window: 1 };

const BACKUP_CODE_COUNT = 10;

function generateSecret() {
  return authenticator.generateSecret();
}

function verifyToken(secret, token) {
  if (!token) return false;
  try {
    return authenticator.verify({ token: String(token).replace(/\s+/g, ''), secret });
  } catch (err) {
    return false;
  }
}

function keyUri(email, appName, secret) {
  return authenticator.keyuri(email, appName || 'App', secret);
}

async function qrCodeDataUrl(otpAuthUrl) {
  return QRCode.toDataURL(otpAuthUrl);
}

// Backup codes are shown to the user once in plaintext, then only the salted
// hash is ever stored — same idea as a password.
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    // 10 hex chars grouped for readability, e.g. "3f9a-2b7c1d"
    const raw = crypto.randomBytes(5).toString('hex');
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

function hashBackupCode(code) {
  return crypto.createHash('sha256').update(code.trim().toLowerCase()).digest('hex');
}

module.exports = {
  generateSecret,
  verifyToken,
  keyUri,
  qrCodeDataUrl,
  generateBackupCodes,
  hashBackupCode
};
