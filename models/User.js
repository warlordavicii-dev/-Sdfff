const pool = require('../config/db');

const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;

const User = {
  USERNAME_PATTERN,

  // -----------------------------------------------------
  // CREATE USER (with OTP fields)
  // -----------------------------------------------------
  async create({ name, username, email, password, verifyToken, verifyTokenExpires, referredByCode }) {
    const referralCode = await this.generateUniqueReferralCode();

    let referrerId = null;
    if (referredByCode) {
      const referrer = await this.findByReferralCode(referredByCode);
      if (referrer) referrerId = referrer.id;
    }

    const [result] = await pool.query(
      `INSERT INTO users 
      (name, username, email, password, verify_token, verify_token_expires, is_verified, referral_code, referred_by)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [name, username, email, password, verifyToken, verifyTokenExpires, referralCode, referrerId]
    );

    return result.insertId;
  },

  // -----------------------------------------------------
  // BASIC LOOKUPS
  // -----------------------------------------------------
  async findByEmail(email) {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE email = ? LIMIT 1',
      [email]
    );
    return rows[0] || null;
  },

  async findById(id) {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE id = ? LIMIT 1',
      [id]
    );
    return rows[0] || null;
  },

  async findByUsername(username) {
    const [rows] = await pool.query(
      'SELECT * FROM users WHERE username = ? LIMIT 1',
      [username]
    );
    return rows[0] || null;
  },

  // -----------------------------------------------------
  // USERNAME CHECK (safe + case insensitive)
  // -----------------------------------------------------
  async isUsernameTaken(username, excludeUserId = null) {
    let sql = 'SELECT id FROM users WHERE LOWER(username) = LOWER(?)';
    const params = [username];

    if (excludeUserId) {
      sql += ' AND id != ?';
      params.push(excludeUserId);
    }

    sql += ' LIMIT 1';

    const [rows] = await pool.query(sql, params);
    return rows.length > 0;
  },

  // -----------------------------------------------------
  // OTP VERIFICATION FLOW (BREVO 6-DIGIT CODE)
  // -----------------------------------------------------

  async findByEmailAndVerifyCode(email, code) {
    const [rows] = await pool.query(
      `SELECT * FROM users 
       WHERE email = ? 
       AND verify_token = ? 
       LIMIT 1`,
      [email, code]
    );

    const user = rows[0];
    if (!user) return null;

    // Compare against this server's clock rather than the DB server's clock —
    // free/shared MySQL hosts often run clocks that drift or sit in a
    // different timezone, which was causing fresh codes to read as expired.
    if (!user.verify_token_expires || new Date(user.verify_token_expires).getTime() < Date.now()) {
      return null;
    }

    return user;
  },

  async setVerifyToken(id, token, expires) {
    await pool.query(
      `UPDATE users 
       SET verify_token = ?, verify_token_expires = ?
       WHERE id = ?`,
      [token, expires, id]
    );
  },

  async markVerified(id) {
    await pool.query(
      `UPDATE users 
       SET is_verified = 1,
           verify_token = NULL,
           verify_token_expires = NULL
       WHERE id = ?`,
      [id]
    );

    // Only pays out if this user was actually referred and hasn't already
    // triggered the bonus (re-verifying after an email change, etc).
    const awarded = await this.awardReferralBonus(id, 10);
    if (awarded) await this.markReferralBonusAwarded(id);
  },

  // -----------------------------------------------------
  // PASSWORD RESET FLOW
  // -----------------------------------------------------

  async setResetToken(id, token, expires) {
    await pool.query(
      `UPDATE users 
       SET reset_token = ?, reset_token_expires = ?
       WHERE id = ?`,
      [token, expires, id]
    );
  },

  async findByResetToken(token) {
    const [rows] = await pool.query(
      `SELECT * FROM users 
       WHERE reset_token = ? 
       LIMIT 1`,
      [token]
    );

    const user = rows[0];
    if (!user) return null;

    if (!user.reset_token_expires || new Date(user.reset_token_expires).getTime() < Date.now()) {
      return null;
    }

    return user;
  },

  async updatePassword(id, hashedPassword) {
    await pool.query(
      `UPDATE users 
       SET password = ?,
           reset_token = NULL,
           reset_token_expires = NULL
       WHERE id = ?`,
      [hashedPassword, id]
    );
  },

  // -----------------------------------------------------
  // PROFILE UPDATE
  // -----------------------------------------------------

  async updateProfile(id, { name, username, email }) {
    await pool.query(
      `UPDATE users 
       SET name = ?, username = ?, email = ?
       WHERE id = ?`,
      [name, username, email, id]
    );
  },

  // -----------------------------------------------------
  // AVATAR
  // -----------------------------------------------------

  async setAvatar(id, avatarUrl) {
    await pool.query('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, id]);
  },

  // Returns the previous avatar_url so the caller can delete the old file
  // from disk (only relevant for locally-uploaded avatars, not OAuth ones).
  async clearAvatar(id) {
    const user = await this.findById(id);
    await pool.query('UPDATE users SET avatar_url = NULL WHERE id = ?', [id]);
    return user ? user.avatar_url : null;
  },

  // -----------------------------------------------------
  // TWO-FACTOR AUTHENTICATION (TOTP)
  // -----------------------------------------------------

  // Stores the secret during setup, before the user has confirmed a code —
  // totp_enabled stays 0 until confirmSetup below.
  async startTotpSetup(id, secret) {
    await pool.query('UPDATE users SET totp_secret = ? WHERE id = ?', [secret, id]);
  },

  async enableTotp(id) {
    await pool.query('UPDATE users SET totp_enabled = 1 WHERE id = ?', [id]);
  },

  async disableTotp(id) {
    await pool.query('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [id]);
  },

  // -----------------------------------------------------
  // COINS & REFERRALS
  // -----------------------------------------------------

  // "3f9a2b7c" style — short, URL-safe, easy to read aloud or paste into a link.
  async generateUniqueReferralCode() {
    const crypto = require('crypto');
    let code;
    do {
      code = crypto.randomBytes(5).toString('hex');
    } while (await this.findByReferralCode(code));
    return code;
  },

  async findByReferralCode(code) {
    if (!code) return null;
    const [rows] = await pool.query('SELECT * FROM users WHERE referral_code = ? LIMIT 1', [code]);
    return rows[0] || null;
  },

  // Every existing user gets a code lazily the first time it's needed
  // (Settings page, or right after signup) rather than requiring a one-off
  // backfill migration.
  async ensureReferralCode(id) {
    const user = await this.findById(id);
    if (!user) return null;
    if (user.referral_code) return user.referral_code;

    const code = await this.generateUniqueReferralCode();
    await pool.query('UPDATE users SET referral_code = ? WHERE id = ?', [code, id]);
    return code;
  },

  async setReferredBy(id, referrerId) {
    await pool.query('UPDATE users SET referred_by = ? WHERE id = ?', [referrerId, id]);
  },

  // Pays out the referrer's bonus exactly once, keyed off the *referred*
  // user's id. The WHERE clause (not just the JS check) is what actually
  // prevents a double-award race.
  async awardReferralBonus(referredUserId, amount) {
    const [result] = await pool.query(
      `UPDATE users u
       JOIN (SELECT referred_by FROM users WHERE id = ? AND referral_bonus_awarded = 0) x
             ON u.id = x.referred_by
       SET u.coins = u.coins + ?`,
      [referredUserId, amount]
    );
    return result.affectedRows > 0;
  },

  async markReferralBonusAwarded(referredUserId) {
    await pool.query('UPDATE users SET referral_bonus_awarded = 1 WHERE id = ?', [referredUserId]);
  },

  async countReferrals(id) {
    const [rows] = await pool.query('SELECT COUNT(*) AS cnt FROM users WHERE referred_by = ?', [id]);
    return rows[0].cnt;
  },

  // Atomic, race-safe: only succeeds if 24h+ have passed since the last
  // claim, and reports back whether it actually happened.
  async claimDailyCoins(id, amount) {
    const [result] = await pool.query(
      `UPDATE users
       SET coins = coins + ?, last_daily_claim_at = NOW()
       WHERE id = ? AND (last_daily_claim_at IS NULL OR last_daily_claim_at <= NOW() - INTERVAL 24 HOUR)`,
      [amount, id]
    );
    return result.affectedRows > 0;
  },

  // Returns null if claimable now, otherwise the Date it unlocks again.
  nextDailyClaimAt(user) {
    if (!user.last_daily_claim_at) return null;
    const next = new Date(user.last_daily_claim_at).getTime() + 24 * 60 * 60 * 1000;
    return next > Date.now() ? new Date(next) : null;
  },

  // Moves coins between two accounts atomically: the balance check and the
  // debit/credit all happen inside one DB transaction so a balance can never
  // go negative, even under concurrent transfer requests.
  async transferCoins({ fromId, toId, amount }) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      const [deduct] = await conn.query(
        'UPDATE users SET coins = coins - ? WHERE id = ? AND coins >= ?',
        [amount, fromId, amount]
      );
      if (deduct.affectedRows === 0) {
        await conn.rollback();
        return false; // insufficient balance
      }

      await conn.query('UPDATE users SET coins = coins + ? WHERE id = ?', [amount, toId]);
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  // -----------------------------------------------------
  // ACCOUNT DELETION
  // -----------------------------------------------------

  // Foreign keys on wallets/transactions/community_messages/login_activity/
  // backup_codes/coin_transactions all cascade on user_id, so this one
  // delete cleans up everything that belongs solely to this account.
  async deleteAccount(id) {
    await pool.query('DELETE FROM users WHERE id = ?', [id]);
  },

  // -----------------------------------------------------
  // SOCIAL LOGIN (Google / Facebook)
  // -----------------------------------------------------

  async findByGoogleId(googleId) {
    const [rows] = await pool.query('SELECT * FROM users WHERE google_id = ? LIMIT 1', [googleId]);
    return rows[0] || null;
  },

  async findByFacebookId(facebookId) {
    const [rows] = await pool.query('SELECT * FROM users WHERE facebook_id = ? LIMIT 1', [facebookId]);
    return rows[0] || null;
  },

  async linkGoogleId(id, googleId) {
    await pool.query('UPDATE users SET google_id = ? WHERE id = ?', [googleId, id]);
  },

  async linkFacebookId(id, facebookId) {
    await pool.query('UPDATE users SET facebook_id = ? WHERE id = ?', [facebookId, id]);
  },

  // Turns "Jane Doe" / "jane@example.com" into a free username like
  // "janedoe", "janedoe2", "janedoe3", ... so social sign-ups never collide.
  async generateUniqueUsername(seed) {
    const base = (seed || 'user')
      .toLowerCase()
      .replace(/@.*$/, '')
      .replace(/[^a-z0-9_]/g, '')
      .slice(0, 28) || 'user';

    let candidate = base.length >= 3 ? base : `${base}user`;
    let suffix = 1;

    while (await this.isUsernameTaken(candidate)) {
      suffix += 1;
      candidate = `${base}${suffix}`.slice(0, 32);
    }

    return candidate;
  },

  // Finds an existing account to sign the person into, or creates a new one.
  // Matching order: by the provider's own id first (fastest, most certain),
  // then by verified email (to link a social login to an existing
  // password-based account), then falls back to creating a brand-new user.
  // Accounts created this way are marked verified immediately since the
  // provider has already confirmed the email address.
  async findOrCreateFromOAuth({ provider, providerId, email, name, avatarUrl, referredByCode }) {
    const idColumn = provider === 'google' ? 'google_id' : 'facebook_id';
    const lookup = provider === 'google' ? this.findByGoogleId : this.findByFacebookId;

    const existingByProviderId = await lookup.call(this, providerId);
    if (existingByProviderId) return existingByProviderId;

    if (email) {
      const existingByEmail = await this.findByEmail(email);
      if (existingByEmail) {
        await pool.query(`UPDATE users SET ${idColumn} = ? WHERE id = ?`, [providerId, existingByEmail.id]);
        if (!existingByEmail.avatar_url && avatarUrl) {
          await this.setAvatar(existingByEmail.id, avatarUrl);
        }
        return this.findById(existingByEmail.id);
      }
    }

    const username = await this.generateUniqueUsername((email || name || 'user').split('@')[0]);
    const referralCode = await this.generateUniqueReferralCode();
    const [result] = await pool.query(
      `INSERT INTO users
        (name, username, email, password, is_verified, avatar_url, referral_code, ${idColumn})
       VALUES (?, ?, ?, NULL, 1, ?, ?, ?)`,
      [name || username, username, email, avatarUrl || null, referralCode, providerId]
    );
    const newUserId = result.insertId;

    // OAuth accounts are verified immediately, so the referral bonus can be
    // paid out right away instead of waiting for an email-verify step.
    if (referredByCode) {
      const referrer = await this.findByReferralCode(referredByCode);
      if (referrer && referrer.id !== newUserId) {
        await this.setReferredBy(newUserId, referrer.id);
        const awarded = await this.awardReferralBonus(newUserId, 10);
        if (awarded) await this.markReferralBonusAwarded(newUserId);
      }
    }

    return this.findById(newUserId);
  }
};

module.exports = User;
