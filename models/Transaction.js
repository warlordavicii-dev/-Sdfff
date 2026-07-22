const pool = require('../config/db');

const Transaction = {
  async create({ userId, type, channel, amountCents, txRef, destination }) {
    await pool.query(
      `INSERT INTO transactions (user_id, type, channel, amount_cents, tx_ref, destination, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
      [userId, type, channel, amountCents, txRef, destination || null]
    );
  },

  async findByRef(txRef) {
    const [rows] = await pool.query('SELECT * FROM transactions WHERE tx_ref = ? LIMIT 1', [txRef]);
    return rows[0] || null;
  },

  async markSuccessful(txRef, providerTransactionId) {
    await pool.query(
      `UPDATE transactions SET status = 'successful', provider_transaction_id = ? WHERE tx_ref = ? AND status = 'pending'`,
      [providerTransactionId, txRef]
    );
  },

  async markFailed(txRef, reason) {
    await pool.query(
      `UPDATE transactions SET status = 'failed', failure_reason = ? WHERE tx_ref = ? AND status = 'pending'`,
      [reason || 'Payment failed', txRef]
    );
  },

  async listForUser(userId, limit = 20) {
    const [rows] = await pool.query(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
    return rows;
  }
};

module.exports = Transaction;
