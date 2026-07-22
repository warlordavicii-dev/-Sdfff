require('dotenv').config();

// -----------------------------------------------------
// Config
// -----------------------------------------------------

const fromName = process.env.SMTP_FROM_NAME || process.env.APP_NAME || 'App';
const fromEmail = process.env.SMTP_FROM_EMAIL;

if (!process.env.BREVO_API_KEY) {
  throw new Error('BREVO_API_KEY environment variable is missing');
}

console.log('📧 MAIL MODE: Brevo API (ACTIVE)');

// -----------------------------------------------------
// Core Brevo sender
// -----------------------------------------------------

async function sendMail({ to, subject, html, text }) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'content-type': 'application/json',
      accept: 'application/json'
    },
    body: JSON.stringify({
      sender: {
        name: fromName,
        email: fromEmail
      },
      to: [{ email: to }],
      subject,
      htmlContent: html,
      textContent: text
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo Error ${res.status}: ${err}`);
  }

  return res.json();
}

// -----------------------------------------------------
// OTP Verification Email (FIXED FOR YOUR SYSTEM)
// -----------------------------------------------------

async function sendVerificationCodeEmail(to, code) {
  return sendMail({
    to,
    subject: 'Your verification code',
    html: `
      <div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;">
        <h2>Verify your account</h2>

        <p>Your verification code is:</p>

        <div style="
          font-size:32px;
          font-weight:bold;
          letter-spacing:6px;
          margin:20px 0;
          padding:10px;
          background:#f3f4f6;
          display:inline-block;
        ">
          ${code}
        </div>

        <p>This code expires in 10 minutes.</p>
      </div>
    `,
    text: `Your verification code is ${code}. It expires in 10 minutes.`
  });
}

// -----------------------------------------------------
// Password Reset Email
// -----------------------------------------------------

async function sendPasswordResetEmail(to, link) {
  return sendMail({
    to,
    subject: 'Reset your password',
    html: `
      <div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;">
        <h2>Password Reset</h2>

        <p>We received a request to reset your password.</p>

        <p style="margin:30px 0;">
          <a href="${link}" style="
            background:#dc2626;
            color:white;
            padding:12px 24px;
            border-radius:6px;
            text-decoration:none;
            display:inline-block;
          ">
            Reset Password
          </a>
        </p>

        <p>If the button doesn't work:</p>
        <p>${link}</p>

        <p>This link expires in 1 hour.</p>
      </div>
    `,
    text: `Reset your password: ${link}`
  });
}

// -----------------------------------------------------
// Complaint Email (goes straight to the support inbox)
// -----------------------------------------------------

const COMPLAINTS_INBOX = 'ghostviewer99@gmail.com';

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function sendComplaintEmail({ fromEmail: reporterEmail, fromName: reporterName, subject, message }) {
  return sendMail({
    to: COMPLAINTS_INBOX,
    subject: `[Complaint] ${subject}`,
    html: `
      <div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;">
        <h2>New complaint submitted</h2>
        <p><strong>From:</strong> ${escapeHtml(reporterName)} (${escapeHtml(reporterEmail)})</p>
        <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
        <div style="margin-top:16px;padding:14px;background:#f3f4f6;border-radius:6px;white-space:pre-wrap;">${escapeHtml(message)}</div>
      </div>
    `,
    text: `New complaint from ${reporterName} (${reporterEmail})\nSubject: ${subject}\n\n${message}`
  });
}

// -----------------------------------------------------
// Coin Transfer Notification
// -----------------------------------------------------

async function sendCoinsReceivedEmail(to, { fromName, amount }) {
  return sendMail({
    to,
    subject: `You received ${amount} coins`,
    html: `
      <div style="font-family:Arial;max-width:600px;margin:auto;padding:20px;">
        <h2>Coins received 🎉</h2>
        <p><strong>${fromName}</strong> sent you <strong>${amount} coins</strong>.</p>
        <p>Log in to see your updated balance.</p>
      </div>
    `,
    text: `${fromName} sent you ${amount} coins. Log in to see your updated balance.`
  });
}

module.exports = {
  sendMail,
  sendVerificationCodeEmail,
  sendPasswordResetEmail,
  sendComplaintEmail,
  sendCoinsReceivedEmail
};
