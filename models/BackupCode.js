const pool = require('../config/db');
const { hashBackupCode } = require('../utils/twofactor');

const BackupCode = {
  // Replaces any existing backup codes with a fresh set — used both when
  // 2FA is first enabled and if the user regenerates their codes later.
  async replaceAll(userId, plainCodes) {
    await pool.query('DELETE FROM backup_codes WHERE user_id = ?', [userId]);

    const values = plainCodes.map((code) => [userId, hashBackupCode(code)]);
    if (values.length === 0) return;

    await pool.query('INSERT INTO backup_codes (user_id, code_hash) VALUES ?', [values]);
  },

  // Verifies a code and, if valid, consumes it (marks it used) so it can't
  // be replayed. Returns true/false.
  async consume(userId, plainCode) {
    const hash = hashBackupCode(plainCode);
    const [rows] = await pool.query(
      `SELECT id FROM backup_codes WHERE user_id = ? AND code_hash = ? AND used_at IS NULL LIMIT 1`,
      [userId, hash]
    );
    const match = rows[0];
    if (!match) return false;

    await pool.query('UPDATE backup_codes SET used_at = NOW() WHERE id = ?', [match.id]);
    return true;
  },

  async countRemaining(userId) {
    const [rows] = await pool.query(
      `SELECT COUNT(*) AS cnt FROM backup_codes WHERE user_id = ? AND used_at IS NULL`,
      [userId]
    );
    return rows[0].cnt;
  },

  async deleteAllForUser(userId) {
    await pool.query('DELETE FROM backup_codes WHERE user_id = ?', [userId]);
  }
};

module.exports = BackupCode;
