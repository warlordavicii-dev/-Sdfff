const pool = require('../config/db');

const CommunityMessage = {
  async create({ userId, username, body, replyToId }) {
    const [result] = await pool.query(
      `INSERT INTO community_messages (user_id, username, body, reply_to_id)
       VALUES (?, ?, ?, ?)`,
      [userId, username, body, replyToId || null]
    );
    return this.findById(result.insertId);
  },

  async findById(id) {
    const [rows] = await pool.query(
      `SELECT m.*, r.username AS reply_username, r.body AS reply_body
       FROM community_messages m
       LEFT JOIN community_messages r ON m.reply_to_id = r.id
       WHERE m.id = ?
       LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  },

  // Latest `limit` messages, returned oldest-first so they render top-to-bottom
  // like a normal chat thread.
  async listRecent(limit = 50) {
    const [rows] = await pool.query(
      `SELECT m.*, r.username AS reply_username, r.body AS reply_body
       FROM community_messages m
       LEFT JOIN community_messages r ON m.reply_to_id = r.id
       ORDER BY m.id DESC
       LIMIT ?`,
      [limit]
    );
    return rows.reverse();
  },

  // Used for polling: anything newer than the last message the client has seen.
  async listSince(afterId, limit = 50) {
    const [rows] = await pool.query(
      `SELECT m.*, r.username AS reply_username, r.body AS reply_body
       FROM community_messages m
       LEFT JOIN community_messages r ON m.reply_to_id = r.id
       WHERE m.id > ?
       ORDER BY m.id ASC
       LIMIT ?`,
      [afterId, limit]
    );
    return rows;
  }
};

module.exports = CommunityMessage;
