function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required.' });
    if (req.user.mustChangePassword) return res.redirect('/change-password');
    if (req.user.role !== 'administrator' && !allowedRoles.includes(req.user.role)) {
      const role = req.user.role === 'administrator' ? 'admin' : req.user.role;
      return res.redirect(`/${role}/dashboard`);
    }
    next();
  };
}
module.exports = requireRole;
