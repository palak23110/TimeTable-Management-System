const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const express = require('express');
const session = require('express-session');
const MysqlSessionStore = require('./database/mysql-session-store');
const requireAuth = require('./middleware/require-auth');
const requireRole = require('./middleware/require-role');
const authRoutes = require('./routes/auth');
const { sendPasswordResetEmail, sendTeacherInvitationEmail } = require('./services/mail');
const teacherRoutes = require('./routes/teachers');
const teacherProfileRoutes = require('./routes/teacher-profile');
const studentsRoutes = require('./routes/students');
const academicStructureRoutes = require('./routes/academic-structure');
const subjectRoutes = require('./routes/subjects');

const app = express();
const frontend = path.resolve(__dirname, '../frontend');
app.locals.sendPasswordResetEmail = sendPasswordResetEmail;
app.locals.sendTeacherInvitationEmail = sendTeacherInvitationEmail;
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must be set to at least 32 characters in production.');
}
if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
app.locals.logger = console;
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use('/css', express.static(path.join(frontend, 'css'), { maxAge: '1h' }));
app.use('/js', express.static(path.join(frontend, 'js'), { maxAge: 0 }));
app.use(session({
  name: 'bmu_ttms_session',
  secret: process.env.SESSION_SECRET || 'development-only-change-this-session-secret-please',
  store: new MysqlSessionStore(), resave: false, saveUninitialized: false, rolling: true,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/' }
}));

app.get('/', (req, res) => res.sendFile(path.join(frontend, 'login.html')));
app.get('/login', (req, res) => res.sendFile(path.join(frontend, 'login.html')));
app.get('/forgot-password', (req, res) => res.sendFile(path.join(frontend, 'forgot-password.html')));
app.get('/reset-password', (req, res) => res.sendFile(path.join(frontend, 'reset-password.html')));
app.get('/change-password', requireAuth, (req, res) => {
  if (!req.user.mustChangePassword) return res.redirect(`/${req.user.role === 'administrator' ? 'admin' : req.user.role}/dashboard`);
  res.sendFile(path.join(frontend, 'change-password.html'));
});
app.use('/api/auth', authRoutes);
const dashboard = file => (req, res) => res.sendFile(path.join(frontend, 'dashboards', file));
app.get('/admin/dashboard', requireAuth, requireRole('administrator'), dashboard('admin.html'));
app.get('/admin/teachers', requireAuth, requireRole('administrator'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(frontend, 'dashboards', 'teachers.html'));
});
app.use('/api/admin/teachers', requireAuth, requireRole('administrator'), teacherRoutes);
app.get('/admin/students', requireAuth, requireRole('administrator'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(frontend, 'dashboards', 'students.html'));
});
app.get('/admin/academic-structure', requireAuth, requireRole('administrator'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(frontend, 'dashboards', 'academic-structure.html'));
});
app.get('/admin/subjects', requireAuth, requireRole('administrator'), (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(frontend, 'dashboards', 'subjects.html'));
});
app.use('/api/admin/students', requireAuth, requireRole('administrator'), studentsRoutes);
app.use('/api/admin/academic-structure', requireAuth, requireRole('administrator'), academicStructureRoutes);
app.use('/api/admin/subjects', requireAuth, requireRole('administrator'), subjectRoutes);
const requireTeacherPage = (req, res, next) => {
  if (req.user.mustChangePassword) return res.redirect('/change-password');
  if (req.user.role !== 'teacher') {
    const destination = req.user.role === 'administrator' ? '/admin/dashboard' : '/student/dashboard';
    return res.redirect(destination);
  }
  next();
};
const requireTeacherApi = (req, res, next) => {
  if (req.user.mustChangePassword) return res.redirect('/change-password');
  if (req.user.role !== 'teacher') return res.status(403).json({ error: 'Teacher access required.' });
  next();
};
app.get('/teacher/dashboard', requireAuth, requireTeacherPage, dashboard('teacher.html'));
app.get('/teacher/profile', requireAuth, requireTeacherPage, dashboard('teacher-profile.html'));
app.use('/api/teacher/profile', requireAuth, requireTeacherApi, teacherProfileRoutes);
app.get('/student/dashboard', requireAuth, requireRole('student'), dashboard('student.html'));
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: { name: req.user.name, loginId: req.user.loginId, email: req.user.email, role: req.user.role, mustChangePassword: req.user.mustChangePassword } }));

app.use((req, res) => req.path.startsWith('/api/') ? res.status(404).json({ error: 'Not found.' }) : res.status(404).send('Page not found.'));
app.use((error, req, res, next) => {
  app.locals.logger.error(error);
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});
module.exports = app;
