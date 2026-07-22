/**
 * Creates the `users` table if it doesn't already exist.
 * Run automatically on deploy (see Procfile / render.yaml), or manually with:
 *   npm run initdb
 */
require('dotenv').config();
const pool = require('../config/db');

const createUsersTable = `
CREATE TABLE IF NOT EXISTS users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  username VARCHAR(32) NOT NULL UNIQUE,
  email VARCHAR(190) NOT NULL UNIQUE,
  password VARCHAR(255) NULL,
  is_verified TINYINT(1) NOT NULL DEFAULT 0,
  verify_token VARCHAR(255) NULL,
  verify_token_expires DATETIME NULL,
  reset_token VARCHAR(255) NULL,
  reset_token_expires DATETIME NULL,
  avatar_url VARCHAR(255) NULL,
  google_id VARCHAR(64) NULL,
  facebook_id VARCHAR(64) NULL,
  totp_secret VARCHAR(64) NULL,
  totp_enabled TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// Tracks recent login attempts (password, Google, Facebook) so users can
// review activity on their account from Settings.
const createLoginActivityTable = `
CREATE TABLE IF NOT EXISTS login_activity (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  method ENUM('password', 'google', 'facebook') NOT NULL,
  success TINYINT(1) NOT NULL DEFAULT 1,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_login_activity_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_login_activity_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// One-time recovery codes for 2FA, stored hashed (never in plaintext) and
// consumed one at a time if someone loses access to their authenticator app.
const createBackupCodesTable = `
CREATE TABLE IF NOT EXISTS backup_codes (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  code_hash VARCHAR(255) NOT NULL,
  used_at TIMESTAMP NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_backup_codes_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_backup_codes_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// Balances are stored as integer cents (KES * 100) to avoid floating-point
// rounding errors with real money.
const createWalletsTable = `
CREATE TABLE IF NOT EXISTS wallets (
  user_id INT PRIMARY KEY,
  balance_cents BIGINT NOT NULL DEFAULT 0,
  currency VARCHAR(3) NOT NULL DEFAULT 'KES',
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_wallets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

const createTransactionsTable = `
CREATE TABLE IF NOT EXISTS transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type ENUM('deposit', 'withdrawal') NOT NULL,
  channel ENUM('mpesa', 'airtel', 'bank', 'card') NOT NULL,
  amount_cents BIGINT NOT NULL,
  currency VARCHAR(3) NOT NULL DEFAULT 'KES',
  status ENUM('pending', 'successful', 'failed') NOT NULL DEFAULT 'pending',
  tx_ref VARCHAR(64) NOT NULL UNIQUE,
  provider_transaction_id VARCHAR(64) NULL,
  destination VARCHAR(190) NULL,
  failure_reason VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_transactions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_transactions_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// utf8mb4 is required (not just plain utf8) so 4-byte characters like emoji
// can actually be stored without getting silently truncated or erroring out.
const createCommunityMessagesTable = `
CREATE TABLE IF NOT EXISTS community_messages (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  username VARCHAR(32) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  reply_to_id INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_community_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_community_reply FOREIGN KEY (reply_to_id) REFERENCES community_messages(id) ON DELETE SET NULL,
  INDEX idx_community_created (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// Adds the username column for anyone who already has this table from
// before username support existed. Older MySQL builds (like many free
// hosts) don't support "ADD COLUMN IF NOT EXISTS", so we check first.
async function ensureUsernameColumn() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'username'`
  );
  if (rows[0].cnt > 0) return;

  console.log('Adding missing "username" column...');
  await pool.query('ALTER TABLE users ADD COLUMN username VARCHAR(32) NULL AFTER name');

  // Backfill existing rows with a placeholder so the UNIQUE index can be added.
  await pool.query(
    `UPDATE users SET username = CONCAT('user', id) WHERE username IS NULL`
  );

  await pool.query('ALTER TABLE users MODIFY username VARCHAR(32) NOT NULL');
  await pool.query('ALTER TABLE users ADD UNIQUE KEY uniq_username (username)');
}

// Anyone who deployed this app while it still used Flutterwave will have a
// `flw_transaction_id` column. We've moved to a provider-agnostic name since
// switching to IntaSend; rename it in place instead of losing the history.
async function ensureProviderTransactionIdColumn() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'
       AND COLUMN_NAME IN ('provider_transaction_id', 'flw_transaction_id')`
  );
  const columns = rows.map((r) => r.COLUMN_NAME);
  if (columns.includes('provider_transaction_id')) return;

  if (columns.includes('flw_transaction_id')) {
    console.log('Renaming "flw_transaction_id" column to "provider_transaction_id"...');
    await pool.query('ALTER TABLE transactions CHANGE flw_transaction_id provider_transaction_id VARCHAR(64) NULL');
  } else {
    console.log('Adding missing "provider_transaction_id" column...');
    await pool.query('ALTER TABLE transactions ADD COLUMN provider_transaction_id VARCHAR(64) NULL AFTER tx_ref');
  }
}

// Adds the columns needed for avatars, 2FA, and social login to any `users`
// table created before those features existed. Older MySQL builds don't all
// support "ADD COLUMN IF NOT EXISTS", so each column is checked individually.
async function ensureAccountFeatureColumns() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME, IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const existing = new Map(rows.map((r) => [r.COLUMN_NAME, r.IS_NULLABLE]));

  const columnsToAdd = [
    ['avatar_url', 'ALTER TABLE users ADD COLUMN avatar_url VARCHAR(255) NULL AFTER reset_token_expires'],
    ['google_id', 'ALTER TABLE users ADD COLUMN google_id VARCHAR(64) NULL AFTER avatar_url'],
    ['facebook_id', 'ALTER TABLE users ADD COLUMN facebook_id VARCHAR(64) NULL AFTER google_id'],
    ['totp_secret', 'ALTER TABLE users ADD COLUMN totp_secret VARCHAR(64) NULL AFTER facebook_id'],
    ['totp_enabled', 'ALTER TABLE users ADD COLUMN totp_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER totp_secret']
  ];

  for (const [name, sql] of columnsToAdd) {
    if (!existing.has(name)) {
      console.log(`Adding missing "${name}" column...`);
      await pool.query(sql);
    }
  }

  // Google/Facebook sign-ins don't have a password — allow NULL if this
  // table was created back when `password` was NOT NULL.
  if (existing.get('password') === 'NO') {
    console.log('Relaxing "password" column to allow NULL (for social-only accounts)...');
    await pool.query('ALTER TABLE users MODIFY password VARCHAR(255) NULL');
  }

  // google_id / facebook_id need to be unique (but NULL-able) so the same
  // external account can't be linked to two local users.
  const [indexRows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
       AND INDEX_NAME IN ('uniq_google_id', 'uniq_facebook_id')`
  );
  const indexNames = indexRows.map((r) => r.INDEX_NAME);
  if (!indexNames.includes('uniq_google_id')) {
    await pool.query('ALTER TABLE users ADD UNIQUE KEY uniq_google_id (google_id)');
  }
  if (!indexNames.includes('uniq_facebook_id')) {
    await pool.query('ALTER TABLE users ADD UNIQUE KEY uniq_facebook_id (facebook_id)');
  }
}

// Adds the columns needed for the coins economy: balances, referrals, and
// the daily-claim cooldown.
async function ensureCoinColumns() {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`
  );
  const existing = new Set(rows.map((r) => r.COLUMN_NAME));

  const columnsToAdd = [
    ['coins', 'ALTER TABLE users ADD COLUMN coins INT NOT NULL DEFAULT 0 AFTER totp_enabled'],
    ['referral_code', 'ALTER TABLE users ADD COLUMN referral_code VARCHAR(12) NULL AFTER coins'],
    ['referred_by', 'ALTER TABLE users ADD COLUMN referred_by INT NULL AFTER referral_code'],
    ['referral_bonus_awarded', 'ALTER TABLE users ADD COLUMN referral_bonus_awarded TINYINT(1) NOT NULL DEFAULT 0 AFTER referred_by'],
    ['last_daily_claim_at', 'ALTER TABLE users ADD COLUMN last_daily_claim_at DATETIME NULL AFTER referral_bonus_awarded']
  ];

  for (const [name, sql] of columnsToAdd) {
    if (!existing.has(name)) {
      console.log(`Adding missing "${name}" column...`);
      await pool.query(sql);
    }
  }

  const [refCodeIndexRows] = await pool.query(
    `SELECT INDEX_NAME FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND INDEX_NAME = 'uniq_referral_code'`
  );
  if (refCodeIndexRows.length === 0) {
    await pool.query('ALTER TABLE users ADD UNIQUE KEY uniq_referral_code (referral_code)');
  }

  const [fkRows] = await pool.query(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND CONSTRAINT_NAME = 'fk_users_referred_by'`
  );
  if (fkRows.length === 0) {
    await pool.query(
      'ALTER TABLE users ADD CONSTRAINT fk_users_referred_by FOREIGN KEY (referred_by) REFERENCES users(id) ON DELETE SET NULL'
    );
  }
}

// Ledger of every coin movement (daily claims, referral bonuses, transfers)
// so a user's balance is always reconstructable/auditable, not just a bare
// number that silently changes.
const createCoinTransactionsTable = `
CREATE TABLE IF NOT EXISTS coin_transactions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  type ENUM('daily_claim', 'referral_bonus', 'transfer_in', 'transfer_out') NOT NULL,
  amount INT NOT NULL,
  counterparty_user_id INT NULL,
  note VARCHAR(255) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_coin_tx_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_coin_tx_counterparty FOREIGN KEY (counterparty_user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_coin_tx_user (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

// Complaints keep a snapshot of the sender's email even if the account is
// later deleted, so support has a record of what was reported.
const createComplaintsTable = `
CREATE TABLE IF NOT EXISTS complaints (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NULL,
  email VARCHAR(190) NOT NULL,
  subject VARCHAR(190) NOT NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_complaints_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
`;

(async () => {
  try {
    console.log('Connecting to database...');
    await pool.query(createUsersTable);
    await ensureUsernameColumn();
    await ensureAccountFeatureColumns();
    await ensureCoinColumns();
    await pool.query(createWalletsTable);
    await pool.query(createTransactionsTable);
    await ensureProviderTransactionIdColumn();
    await pool.query(createCommunityMessagesTable);
    await pool.query(createLoginActivityTable);
    await pool.query(createBackupCodesTable);
    await pool.query(createCoinTransactionsTable);
    await pool.query(createComplaintsTable);
    console.log('✔ users, wallets, transactions, community_messages, login_activity, backup_codes, coin_transactions, and complaints tables are ready.');
    process.exit(0);
  } catch (err) {
    console.error('✘ Failed to initialize database:', err.message);
    process.exit(1);
  }
})();
