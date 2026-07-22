const pool = require('../config/db');

const CoinTransaction = {
  async log({ userId, type, amount, counterpartyUserId = null, note = null }) {
    await pool.query(
      `INSERT INTO coin_transactions (user_id, type, amount, counterparty_user_id, note)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, type, amount, counterpartyUserId, note]
    );
  },

  async listForUser(userId, limit = 15) {
    const [rows] = await pool.query(
      `SELECT ct.type, ct.amount, ct.note, ct.created_at, u.username AS counterparty_username
       FROM coin_transactions ct
       LEFT JOIN users u ON u.id = ct.counterparty_user_id
       WHERE ct.user_id = ?
       ORDER BY ct.id DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows;
  }
};

module.exports = CoinTransaction;
