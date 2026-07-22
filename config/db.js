const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  // utf8mb4 end-to-end so 4-byte characters (emoji included) survive the
  // round trip — the table charset alone isn't enough if the connection
  // itself negotiates a narrower charset.
  charset: 'utf8mb4',
  // Treat all DATETIME columns as UTC on both read and write, regardless of
  // whatever timezone the DB host's own clock happens to be set to.
  timezone: 'Z',
  // FreeSQLDatabase and many free MySQL hosts sit behind SSL-less or
  // self-signed setups; this keeps compatibility without failing connections.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

module.exports = pool;
