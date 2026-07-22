const pool = require('../config/db');

const Complaint = {
  async create({ userId = null, email, subject, message }) {
    const [result] = await pool.query(
      `INSERT INTO complaints (user_id, email, subject, message) VALUES (?, ?, ?, ?)`,
      [userId, email, subject, message]
    );
    return result.insertId;
  }
};

module.exports = Complaint;
