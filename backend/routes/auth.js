const express = require('express');
const bcrypt = require('bcrypt');
const { createHash, randomBytes } = require('node:crypto');
const pool = require('../database/pool');
const { sendPasswordResetEmail } = require('../services/mail');
const requireAuth = require('../middleware/require-auth');

const router = express.Router();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const genericResetResponse = {
  message: 'If an account matches that email, a reset link will be sent shortly.',
};

router.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Send authentication requests as JSON.' });
  }

  next();
});

router.post('/login', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const identifier = typeof body.identifier === 'string' ? body.identifier.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!identifier || !password || identifier.length > 254 || password.length > 128) {
      return res.status(400).json({ error: 'Enter your login ID or email and password.' });
    }

    const [rows] = await pool.execute(`
      SELECT id, name, login_id AS loginId, email, password_hash AS passwordHash,
        role, is_active AS isActive, must_change_password AS mustChangePassword,
        tp.invitation_setup_required AS invitationSetupRequired
      FROM users u
      LEFT JOIN teacher_profiles tp ON tp.user_id = u.id
      WHERE u.login_id = ? OR u.email = ?
      LIMIT 1
    `, [identifier, identifier]);
    const user = rows[0];

    if (!user || !user.isActive || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({ error: 'The login ID/email or password is incorrect.' });
    }
    if (user.role === 'teacher' && user.invitationSetupRequired) {
      return res.status(401).json({ error: 'Accept your teacher invitation before signing in.' });
    }

    req.session.regenerate((error) => {
      if (error) return next(error);

      req.session.userId = user.id;
      req.session.role = user.role;
      if (body.remember === true) {
        req.session.cookie.maxAge = 30 * 24 * 60 * 60 * 1000;
      } else {
        req.session.cookie.expires = false;
      }

      req.session.save((saveError) => {
        if (saveError) return next(saveError);

        const redirectTo = user.mustChangePassword
          ? '/change-password'
          : `/${user.role === 'administrator' ? 'admin' : user.role}/dashboard`;
        res.json({ redirectTo });
      });
    });
  } catch (error) {
    next(error);
  }
});

router.post('/accept-invitation', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { token } = body;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    return res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
  }

  const connection = await pool.getConnection();
  let user;
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT t.id AS tokenId, u.id, u.role, u.is_active AS isActive
      FROM user_invitation_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.accepted_at IS NULL AND t.rejected_at IS NULL
        AND t.expires_at > UTC_TIMESTAMP()
      LIMIT 1 FOR UPDATE
    `, [hash(token)]);
    user = rows[0];
    if (!user || !user.isActive) {
      await connection.rollback();
      return res.status(400).json({ error: 'This invitation link is invalid, expired, or has already been accepted or rejected.' });
    }
    if (user.role === 'teacher') {
      const [profile] = await connection.execute('SELECT invitation_setup_required AS setupRequired FROM teacher_profiles WHERE user_id = ? FOR UPDATE', [user.id]);
      if (!profile.length || !profile[0].setupRequired) {
        await connection.rollback();
        return res.status(400).json({ error: 'This invitation is no longer awaiting account setup.' });
      }
    }
    await connection.execute('UPDATE users SET is_active = TRUE, must_change_password = FALSE WHERE id = ?', [user.id]);
    if (user.role === 'teacher') {
      await connection.execute('UPDATE teacher_profiles SET invitation_pending = FALSE, invitation_setup_required = FALSE WHERE user_id = ?', [user.id]);
    }
    await connection.execute('UPDATE user_invitation_tokens SET accepted_at = UTC_TIMESTAMP() WHERE id = ?', [user.tokenId]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }

  res.json({ message: 'Invitation accepted. Sign in with the credentials in your invitation email.', redirectTo: '/login?invitation=accepted' });
});

router.post('/reject-invitation', async (req, res, next) => {
  const token = req.body?.token;
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    return res.status(400).json({ error: 'This invitation link is invalid or has expired.' });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT t.id AS tokenId, u.id, u.role
      FROM user_invitation_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.accepted_at IS NULL AND t.rejected_at IS NULL
        AND t.expires_at > UTC_TIMESTAMP()
      LIMIT 1 FOR UPDATE
    `, [hash(token)]);
    const invitation = rows[0];
    if (!invitation || invitation.role !== 'teacher') {
      await connection.rollback();
      return res.status(400).json({ error: 'This invitation link is invalid, expired, or has already been accepted or rejected.' });
    }
    await connection.execute('UPDATE user_invitation_tokens SET rejected_at = UTC_TIMESTAMP() WHERE id = ?', [invitation.tokenId]);
    await connection.execute('UPDATE users SET is_active = FALSE WHERE id = ?', [invitation.id]);
    await connection.execute('UPDATE teacher_profiles SET invitation_pending = FALSE, invitation_setup_required = FALSE WHERE user_id = ?', [invitation.id]);
    await connection.commit();
    res.json({ message: 'This teacher invitation has been rejected.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/change-password', requireAuth, async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { password, confirmPassword } = body;

  if (
    typeof password !== 'string'
    || password.length < 8
    || password.length > 128
    || password !== confirmPassword
  ) {
    return res.status(400).json({ error: 'Enter matching passwords with at least 8 characters.' });
  }

  try {
    const [rows] = await pool.execute(`
      SELECT id, password_hash AS passwordHash, role,
        is_active AS isActive, must_change_password AS mustChangePassword
      FROM users
      WHERE id = ?
      LIMIT 1
    `, [req.user.id]);
    const user = rows[0];

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Authentication required.' });
    }
    if (!user.mustChangePassword) {
      return res.status(409).json({ error: 'A first-login password change is not pending.' });
    }
    if (await bcrypt.compare(password, user.passwordHash)) {
      return res.status(400).json({ error: 'Choose a password different from your temporary password.' });
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(`
        UPDATE users
        SET password_hash = ?, must_change_password = FALSE
        WHERE id = ?
      `, [await bcrypt.hash(password, 12), user.id]);

      if (user.role === 'teacher') {
        await connection.execute(
          'UPDATE teacher_profiles SET invitation_pending = FALSE, invitation_setup_required = FALSE WHERE user_id = ?',
          [user.id],
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    res.json({
      message: 'Password updated.',
      redirectTo: `/${user.role === 'administrator' ? 'admin' : user.role}/dashboard`,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logout', (req, res, next) => {
  if (!req.session) return res.json({ redirectTo: '/login' });

  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie('bmu_ttms_session', { path: '/' });
    res.json({ redirectTo: '/login' });
  });
});

router.post('/forgot-password', async (req, res, next) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!email || email.length > 254) return res.json(genericResetResponse);

    const [rows] = await pool.execute(`
      SELECT id, email
      FROM users
      WHERE email = ? AND is_active = 1
      LIMIT 1
    `, [email]);
    const user = rows[0];

    if (user) {
      const token = randomBytes(32).toString('base64url');
      await pool.execute(`
        INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
        VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 MINUTE))
      `, [user.id, hash(token)]);

      const sendMail = req.app.locals.sendPasswordResetEmail || sendPasswordResetEmail;
      void sendMail(user.email, token).catch(() => {
        req.app.locals.logger.error('Password reset email delivery failed.');
      });
    }

    res.json(genericResetResponse);
  } catch (error) {
    next(error);
  }
});

router.post('/reset-password', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const { token, password, confirmPassword } = body;
  const validToken = typeof token === 'string' && /^[A-Za-z0-9_-]{40,60}$/.test(token);
  const validPassword = typeof password === 'string'
    && password.length >= 8
    && password.length <= 128
    && password === confirmPassword;

  if (!validToken || !validPassword) {
    return res.status(400).json({
      error: 'Check the reset link and enter matching passwords with at least 8 characters.',
    });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT id, user_id AS userId
      FROM password_reset_tokens
      WHERE token_hash = ? AND used_at IS NULL AND expires_at > UTC_TIMESTAMP()
      LIMIT 1
      FOR UPDATE
    `, [hash(token)]);
    const reset = rows[0];

    if (!reset) {
      await connection.rollback();
      return res.status(400).json({ error: 'This reset link is invalid or has expired.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await connection.execute(`
      UPDATE users
      SET password_hash = ?, must_change_password = FALSE
      WHERE id = ?
    `, [passwordHash, reset.userId]);
    await connection.execute(`UPDATE teacher_profiles
      SET invitation_pending = FALSE, invitation_setup_required = FALSE WHERE user_id = ?`, [reset.userId]);
    await connection.execute(`UPDATE user_invitation_tokens SET accepted_at = UTC_TIMESTAMP()
      WHERE user_id = ? AND accepted_at IS NULL`, [reset.userId]);
    await connection.execute(`
      UPDATE password_reset_tokens
      SET used_at = UTC_TIMESTAMP()
      WHERE user_id = ? AND used_at IS NULL
    `, [reset.userId]);
    await connection.execute(`
      UPDATE sessions
      SET revoked_at = UTC_TIMESTAMP()
      WHERE user_id = ? AND revoked_at IS NULL
    `, [reset.userId]);
    await connection.commit();

    res.json({ message: 'Your password has been updated. Sign in with your new password.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
