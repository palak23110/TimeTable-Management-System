const session = require('express-session');
const { createHash } = require('node:crypto');
const pool = require('./pool');
const hashSid = sid => createHash('sha256').update(sid).digest('hex');

class MysqlSessionStore extends session.Store {
  async get(sid, callback) {
    try {
      const [rows] = await pool.execute('SELECT session_data FROM sessions WHERE session_token_hash = ? AND revoked_at IS NULL AND expires_at > UTC_TIMESTAMP() LIMIT 1', [hashSid(sid)]);
      const stored = rows[0]?.session_data;
      callback(null, stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : null);
    } catch (error) { callback(error); }
  }
  async set(sid, value, callback = () => {}) {
    try {
      const days = Number(process.env.SESSION_DAYS || 7);
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires) : new Date(Date.now() + days * 86400000);
      await pool.execute(`INSERT INTO sessions (user_id, session_token_hash, session_data, expires_at, revoked_at)
        VALUES (?, ?, ?, ?, NULL) ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), session_data = VALUES(session_data), expires_at = VALUES(expires_at), revoked_at = NULL`,
      [value.userId || null, hashSid(sid), JSON.stringify(value), expiresAt]);
      callback(null);
    } catch (error) { callback(error); }
  }
  async touch(sid, value, callback = () => {}) {
    try {
      const days = Number(process.env.SESSION_DAYS || 7);
      const expiresAt = value.cookie?.expires ? new Date(value.cookie.expires) : new Date(Date.now() + days * 86400000);
      await pool.execute('UPDATE sessions SET expires_at = ? WHERE session_token_hash = ? AND revoked_at IS NULL', [expiresAt, hashSid(sid)]);
      callback(null);
    } catch (error) { callback(error); }
  }
  async destroy(sid, callback = () => {}) {
    try { await pool.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE session_token_hash = ? AND revoked_at IS NULL', [hashSid(sid)]); callback(null); }
    catch (error) { callback(error); }
  }
}
module.exports = MysqlSessionStore;
