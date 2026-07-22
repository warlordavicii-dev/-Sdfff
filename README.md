# VaultGate — Auth Starter (Login · Signup · Email Verification · Forgot Password · Settings)

A ready-to-deploy Node.js + Express app with:

- Email/password **signup**, with a required **email verification** link sent over SMTP
- **Login** (blocked until the email is verified)
- **Forgot password** / **reset password** via emailed one-time link
- **Settings** page to update name, email (re-verifies on change), and password
- **MySQL** storage, built for a free host like [FreeSQLDatabase.com](https://www.freesqldatabase.com/)
- JWT-in-cookie sessions (no server-side session store needed)
- Deploy configs for both **Render** and **Heroku**

No visual design or branding work needed — it's ready to use as-is, and easy to reskin later.

---

## 1. Project structure

```
authapp/
├── server.js               # App entry point
├── config/db.js            # MySQL connection pool
├── scripts/initDb.js       # Creates the `users` table (run on every deploy)
├── models/User.js          # All SQL queries
├── routes/auth.js          # signup / login / verify / forgot / reset / logout
├── routes/settings.js      # profile + password update
├── middleware/auth.js      # JWT cookie auth guard
├── utils/mailer.js         # Nodemailer SMTP sender + email templates
├── views/                  # EJS templates (login, signup, settings, etc.)
├── public/css/style.css    # All styling
├── .env.example            # Copy to .env locally
├── Procfile                 # Heroku process definition
├── render.yaml              # Render blueprint (optional one-click deploy)
└── package.json
```

---

## 2. Get a free MySQL database (FreeSQLDatabase.com)

1. Go to https://www.freesqldatabase.com/ and sign up for a free database.
2. After it's provisioned, open your database's control panel and copy:
   - **Database host** → `DB_HOST`
   - **Database port** (usually `3306`) → `DB_PORT`
   - **Database name** → `DB_NAME`
   - **Database user** → `DB_USER`
   - **Database password** → `DB_PASSWORD`

You do **not** need to create any tables yourself — running `npm run initdb` (or deploying, which runs it automatically) creates the `users` table for you.

> Free MySQL hosts sometimes idle out or reset after a period of inactivity. If your database ever "disappears," just recreate it on FreeSQLDatabase.com, plug in the new credentials, and redeploy — no code changes needed.

---

## 3. Get SMTP credentials (for sending emails)

Any SMTP provider works. Easiest options:

**Gmail**
1. Enable 2-Step Verification on the Google account.
2. Create an **App Password**: Google Account → Security → App Passwords.
3. Use:
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=587`
   - `SMTP_SECURE=false`
   - `SMTP_USER=youraddress@gmail.com`
   - `SMTP_PASSWORD=<the 16-character app password>`

**Other providers** (Brevo, SendGrid, Mailgun, Zoho, Outlook, your own mail server) — just use the SMTP host/port/username/password they give you in the same environment variables.

---

## 4. Environment variables

Copy `.env.example` to `.env` for local development:

```bash
cp .env.example .env
```

Then fill in every value. Reference:

| Variable | Description |
|---|---|
| `NODE_ENV` | `production` on Render/Heroku, `development` locally |
| `PORT` | Port to run on locally (Render/Heroku set this for you automatically) |
| `APP_URL` | Full public URL of your deployed app (no trailing slash) — used to build email links |
| `APP_NAME` | Shown in the UI and email subject lines |
| `JWT_SECRET` | Long random string used to sign login tokens |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | From FreeSQLDatabase.com |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` | From your SMTP provider |
| `SMTP_FROM_NAME`, `SMTP_FROM_EMAIL` | The "From" name/address on outgoing emails |

**On Render or Heroku, set these in the dashboard's Environment Variables settings — do not upload your `.env` file.**

---

## 5. Run locally

```bash
npm install
npm run initdb   # creates the users table
npm start
```

Visit `http://localhost:3000`.

---

## 6. Deploy to Render

1. Push this project to a GitHub repo.
2. In Render, choose **New → Blueprint** and point it at the repo (it will read `render.yaml`), **or** choose **New → Web Service** manually:
   - Build command: `npm install`
   - Start command: `node scripts/initDb.js && node server.js`
3. Add all the environment variables from the table above in the Render dashboard.
4. Set `APP_URL` to the `https://your-app.onrender.com` URL Render gives you (you can update it after the first deploy).
5. Deploy. The `users` table is created automatically on every deploy/start.

---

## 7. Deploy to Heroku

```bash
heroku create your-app-name
heroku config:set NODE_ENV=production APP_NAME=VaultGate JWT_SECRET=$(openssl rand -hex 32) \
  APP_URL=https://your-app-name.herokuapp.com \
  DB_HOST=... DB_PORT=3306 DB_USER=... DB_PASSWORD=... DB_NAME=... \
  SMTP_HOST=... SMTP_PORT=587 SMTP_SECURE=false SMTP_USER=... SMTP_PASSWORD=... \
  SMTP_FROM_NAME=VaultGate SMTP_FROM_EMAIL=...
git push heroku main
```

The included `Procfile` runs `scripts/initDb.js` as a release step before every deploy, then starts the web process.

---

## 8. How the flows work

- **Signup** → row created with `is_verified = 0` and a `verify_token` → email sent with a link to `/verify-email/:token` → link sets `is_verified = 1`.
- **Login** → rejected with a clear message if the account isn't verified yet (with a "resend verification" option on the login page).
- **Forgot password** → generates a `reset_token` valid for 1 hour → emails a link to `/reset-password/:token` → submitting a new password clears the token.
- **Settings → Profile** → changing the email re-triggers verification and logs the user out until they confirm the new address; changing just the name saves immediately.
- **Settings → Password** → requires the current password before saving a new one.
- Sessions are a signed JWT stored in an `httpOnly` cookie (`token`), valid for 7 days — no separate session table needed.

---

## 9. Customizing

- Colors, fonts, and layout are all in `public/css/style.css`.
- Email copy/templates are in `utils/mailer.js`.
- To add more profile fields, extend the `users` table in `scripts/initDb.js` and `models/User.js`.

---

## 10. Account & security features (avatars, 2FA, social login)

**Profile photo** — Settings → Profile photo. Uploads go to `public/uploads/avatars/` (JPG/PNG/WEBP, max 2MB). No new env vars needed.

**Two-factor authentication (TOTP)** — Settings → Two-factor authentication → "Enable" shows a QR code (Google Authenticator, Authy, 1Password, etc.). After confirming a code, 10 one-time backup codes are shown once — save them. Codes are stored hashed (`backup_codes` table), never in plaintext. When 2FA is on, logging in (password **or** Google/Facebook) adds a `/login/2fa` step before a real session is issued.

**Recent login activity** — Settings shows the last 10 sign-ins (method, rough device/browser, IP, time) from the new `login_activity` table.

**Continue with Google / Facebook** — buttons on the login and signup pages. To enable:

1. **Google**: [Google Cloud Console](https://console.cloud.google.com/apis/credentials) → OAuth client ID (Web application) → Authorized redirect URI: `{APP_URL}/auth/google/callback`. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
2. **Facebook**: [Facebook Developers](https://developers.facebook.com/apps) → your app → Facebook Login → Valid OAuth Redirect URI: `{APP_URL}/auth/facebook/callback`. Set `FACEBOOK_APP_ID` / `FACEBOOK_APP_SECRET`.
3. Leave either pair blank to hide that button — nothing else needs to change.

Signing in with Google/Facebook links to an existing account by matching email, or creates a new (pre-verified, passwordless) account. A user who signed up this way has no password until they use "Forgot password" to set one.

**Database migration** — `npm run initdb` (or your normal deploy step) adds the new columns (`avatar_url`, `google_id`, `facebook_id`, `totp_secret`, `totp_enabled`) to an existing `users` table automatically, and creates the `login_activity` and `backup_codes` tables. Safe to run repeatedly.

---

## 11. Coins, referrals, transfers, complaints & account deletion

**Coins** are a separate in-app currency from the real-money wallet (KES) — they're for engagement/rewards, not withdrawable cash.

- **Daily claim** — Settings → Coins → "Claim +5 today" (once per 24h, enforced atomically in the DB so rapid double-clicks or concurrent requests can't double-pay).
- **Referrals** — every user gets a unique referral link (`{APP_URL}/signup?ref=CODE`) shown in Settings. When someone signs up through it and verifies their email (or signs up via Google/Facebook, which auto-verifies), the referrer gets **10 coins**, paid out exactly once per referred account.
- **Transfers** — send coins to any other user by typing their account email (Settings → Coins → Send coins). Transfers run inside a real DB transaction, so a balance can never go negative even under concurrent requests. The recipient gets a best-effort email notification.
- **Complaints** — Settings → Complaints & support. Submissions are stored in the `complaints` table and emailed directly to `ghostviewer99@gmail.com` via Brevo.
- **Delete account** — Settings → Danger zone. Requires the current password (if the account has one) and typing `DELETE` to confirm. This is permanent — wallet, transactions, community messages, coins, login activity, and 2FA data are all removed via cascading foreign keys.

**Database migration** — `npm run initdb` adds `coins`, `referral_code`, `referred_by`, `referral_bonus_awarded`, `last_daily_claim_at` to `users`, plus new `coin_transactions` and `complaints` tables. Safe to run repeatedly.

---

## 12. Security notes

- Passwords are hashed with `bcryptjs` (cost factor 12) — never stored in plain text.
- Verification and reset tokens are random 64-character hex strings with expiries, stored server-side and single-use.
- Auth and password-reset routes are rate-limited (20 requests / 15 minutes per IP) to slow down brute-force attempts.
- Set a strong, unique `JWT_SECRET` in production — treat it like a password.
