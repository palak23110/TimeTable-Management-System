const pool = require('../database/pool');

async function requireAuth(req, res, next) {
  if (!req.session?.userId) return res.redirect('/login');
  try {
    const [rows] = await pool.execute('SELECT id, name, login_id AS loginId, email, role, is_active AS isActive, must_change_password AS mustChangePassword FROM users WHERE id = ? LIMIT 1', [req.session.userId]);
    const user = rows[0];
    if (!user || !user.isActive) {
      return req.session.destroy(() => { res.clearCookie('bmu_ttms_session', { path: '/' }); res.redirect('/login'); });
    }
    req.user = user;
    next();
  } catch (error) { next(error); }
}

module.exports = requireAuth;
