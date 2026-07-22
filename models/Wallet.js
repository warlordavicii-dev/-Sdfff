const pool = require('../config/db');

const Wallet = {
  async getOrCreate(userId) {
    const [rows] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId]);
    if (rows[0]) return rows[0];

    await pool.query(
      'INSERT INTO wallets (user_id, balance_cents, currency) VALUES (?, 0, ?) ON DUPLICATE KEY UPDATE user_id = user_id',
      [userId, 'KES']
    );
    const [created] = await pool.query('SELECT * FROM wallets WHERE user_id = ?', [userId]);
    return created[0];
  },

  /**
   * Adds funds to a wallet within a row-locked transaction, so two
   * simultaneous credits (e.g. a retried webhook) can't race each other.
   */
  async credit(userId, amountCents, connection = null) {
    const conn = connection || (await pool.getConnection());
    const ownsConnection = !connection;
    try {
      if (ownsConnection) await conn.beginTransaction();
      await conn.query(
        'INSERT INTO wallets (user_id, balance_cents) VALUES (?, ?) ON DUPLICATE KEY UPDATE balance_cents = balance_cents + VALUES(balance_cents)',
        [userId, amountCents]
      );
      if (ownsConnection) await conn.commit();
    } catch (err) {
      if (ownsConnection) await conn.rollback();
      throw err;
    } finally {
      if (ownsConnection) conn.release();
    }
  },

  /**
   * Debits a wallet only if it has sufficient balance, using SELECT ... FOR UPDATE
   * to lock the row and prevent a double-withdrawal race. Returns false if
   * the balance was insufficient (and debits nothing).
   */
  async debitIfSufficient(userId, amountCents) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [rows] = await conn.query(
        'SELECT balance_cents FROM wallets WHERE user_id = ? FOR UPDATE',
        [userId]
      );
      const balance = rows[0] ? rows[0].balance_cents : 0;
      if (balance < amountCents) {
        await conn.rollback();
        return false;
      }
      await conn.query(
        'UPDATE wallets SET balance_cents = balance_cents - ? WHERE user_id = ?',
        [amountCents, userId]
      );
      await conn.commit();
      return true;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  },

  async refund(userId, amountCents) {
    return this.credit(userId, amountCents);
  }
};

module.exports = Wallet;
