const pool = require('../config/db');

const LoginActivity = {
  async log({ userId, method, success = true, ipAddress, userAgent }) {
    await pool.query(
      `INSERT INTO login_activity (user_id, method, success, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?)`,
      [userId, method, success ? 1 : 0, ipAddress || null, (userAgent || '').slice(0, 255)]
    );
  },

  async listForUser(userId, limit = 10) {
    const [rows] = await pool.query(
      `SELECT method, success, ip_address, user_agent, created_at
       FROM login_activity
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT ?`,
      [userId, limit]
    );
    return rows;
  }
};

module.exports = LoginActivity;
