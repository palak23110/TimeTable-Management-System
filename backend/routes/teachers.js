const express = require('express');
const bcrypt = require('bcrypt');
const pool = require('../database/pool');
const {
  generateTeacherTemporaryPassword,
  teacherIdFromUserId,
} = require('../services/teacher-password');

const router = express.Router();
const pageSize = 8;

router.use((req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Send teacher data as JSON.' });
  }

  next();
});

router.get('/stats', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(u.is_active = 1 AND p.invitation_pending = 0) AS active,
        SUM(u.is_active = 1 AND p.invitation_pending = 1) AS invitationsPending,
        SUM(
          NOT EXISTS (
            SELECT 1
            FROM teacher_subjects ts
            WHERE ts.teacher_user_id = u.id
          )
        ) AS withoutSubjects
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.role = 'teacher'
    `);

    const stats = Object.fromEntries(
      Object.entries(rows[0]).map(([key, value]) => [key, Number(value || 0)]),
    );

    res.json({ stats });
  } catch (error) {
    next(error);
  }
});

router.get('/subjects', async (req, res, next) => {
  try {
    const [subjects] = await pool.execute(`
      SELECT id, subject_name AS name
      FROM subjects
      WHERE is_active = 1
      ORDER BY subject_name
    `);

    res.json({ subjects });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string'
      ? req.query.search.trim().slice(0, 160)
      : '';
    const allowedStatuses = ['active', 'invitation', 'delivery_failed', 'inactive'];
    const status = allowedStatuses.includes(req.query.status) ? req.query.status : '';
    const subjectId = /^\d+$/.test(String(req.query.subject || ''))
      ? Number(req.query.subject)
      : 0;
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const conditions = ["u.role = 'teacher'"];
    const args = [];

    if (search) {
      conditions.push('(u.name LIKE ? OR p.teacher_id LIKE ? OR u.email LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (status === 'active') {
      conditions.push('u.is_active = 1 AND p.invitation_pending = 0 AND u.must_change_password = 0');
    } else if (status === 'invitation') {
      conditions.push('u.is_active = 1 AND p.invitation_pending = 1');
    } else if (status === 'delivery_failed') {
      conditions.push('u.is_active = 1 AND p.invitation_pending = 0 AND u.must_change_password = 1');
    } else if (status === 'inactive') {
      conditions.push('u.is_active = 0');
    }

    if (subjectId) {
      conditions.push(`EXISTS (
        SELECT 1
        FROM teacher_subjects filtered
        WHERE filtered.teacher_user_id = u.id AND filtered.subject_id = ?
      )`);
      args.push(subjectId);
    }

    const where = conditions.join(' AND ');
    const [[countRows], [teachers]] = await Promise.all([
      pool.execute(`
        SELECT COUNT(*) AS total
        FROM users u
        JOIN teacher_profiles p ON p.user_id = u.id
        WHERE ${where}
      `, args),
      pool.execute(`
        SELECT
          u.id,
          u.name,
          u.email,
          p.teacher_id AS teacherId,
          p.contact_number AS contactNumber,
          CASE
            WHEN u.is_active = 0 THEN 'inactive'
            WHEN p.invitation_pending = 1 THEN 'invitation'
            WHEN u.must_change_password = 1 THEN 'delivery_failed'
            ELSE 'active'
          END AS status,
          (
            SELECT GROUP_CONCAT(s.subject_name ORDER BY s.subject_name SEPARATOR '||')
            FROM teacher_subjects ts
            JOIN subjects s ON s.id = ts.subject_id
            WHERE ts.teacher_user_id = u.id
          ) AS subjectNames
        FROM users u
        JOIN teacher_profiles p ON p.user_id = u.id
        WHERE ${where}
        ORDER BY u.name, u.id
        LIMIT ? OFFSET ?
      `, [...args, pageSize, (page - 1) * pageSize]),
    ]);

    const total = Number(countRows[0].total);
    res.json({
      teachers: teachers.map((teacher) => ({
        ...teacher,
        subjectNames: teacher.subjectNames ? teacher.subjectNames.split('||') : [],
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:userId', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.userId)) {
    return res.status(404).json({ error: 'Teacher not found.' });
  }

  try {
    const [rows] = await pool.execute(`
      SELECT u.id, u.name, u.email, u.is_active AS isActive, p.*
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher'
      LIMIT 1
    `, [req.params.userId]);

    if (!rows[0]) {
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    res.json({ teacher: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const contactNumber = typeof body.contactNumber === 'string'
    ? body.contactNumber.trim()
    : '';

  if (
    !name
    || name.length > 160
    || !email
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({ error: 'Enter a valid teacher name and email address.' });
  }

  const digits = contactNumber.replace(/\D/g, '');
  if (
    !contactNumber
    || contactNumber.length > 32
    || !/^[+()\d.\s-]+$/.test(contactNumber)
    || digits.length < 7
    || digits.length > 15
  ) {
    return res.status(400).json({ error: 'Enter a valid contact number.' });
  }

  try {
    const [existing] = await pool.execute(
      'SELECT id FROM users WHERE email = ? OR login_id = ? LIMIT 1',
      [email, email],
    );

    if (existing.length) {
      return res.status(409).json({ error: 'An account already uses that email address.' });
    }

    const temporaryPassword = generateTeacherTemporaryPassword(email);
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const connection = await pool.getConnection();
    let userId;
    let teacherId;

    try {
      await connection.beginTransaction();
      const [created] = await connection.execute(
        "INSERT INTO users (name, login_id, email, password_hash, role, is_active, must_change_password) VALUES (?, ?, ?, ?, 'teacher', TRUE, TRUE)",
        [name, email, email, passwordHash],
      );
      userId = created.insertId;
      teacherId = teacherIdFromUserId(userId);

      await connection.execute(`
        INSERT INTO teacher_profiles (user_id, teacher_id, contact_number, invitation_pending)
        VALUES (?, ?, ?, TRUE)
      `, [userId, teacherId, contactNumber]);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ error: 'An account already uses that email address.' });
      }
      throw error;
    } finally {
      connection.release();
    }

    const invitationSent = await deliverInvitation(req, {
      email,
      name,
      teacherId,
      temporaryPassword,
    });

    if (!invitationSent) {
      await pool.execute(
        'UPDATE teacher_profiles SET invitation_pending = FALSE WHERE user_id = ?',
        [userId],
      );
    }

    res.status(201).json({
      teacher: {
        id: userId,
        name,
        email,
        teacherId,
        contactNumber,
        status: invitationSent ? 'invitation' : 'delivery_failed',
      },
      invitationSent,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/:userId/resend-invitation', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.userId)) {
    return res.status(404).json({ error: 'Teacher not found.' });
  }

  const connection = await pool.getConnection();
  let teacher;
  let temporaryPassword;
  let passwordHash;

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT u.id, u.name, u.email, u.is_active AS isActive,
        u.must_change_password AS mustChangePassword,
        u.password_hash AS currentPasswordHash,
        p.teacher_id AS teacherId
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher'
      LIMIT 1
      FOR UPDATE
    `, [req.params.userId]);

    teacher = rows[0];
    if (!teacher || !teacher.isActive) {
      await connection.rollback();
      return res.status(404).json({ error: 'Active teacher account not found.' });
    }

    if (!teacher.mustChangePassword) {
      await connection.rollback();
      return res.status(409).json({ error: 'This teacher no longer has a temporary password.' });
    }

    temporaryPassword = generateTeacherTemporaryPassword(teacher.email);
    passwordHash = await bcrypt.hash(temporaryPassword, 12);
    await connection.execute(`
      UPDATE users
      SET password_hash = ?, must_change_password = TRUE
      WHERE id = ?
    `, [passwordHash, teacher.id]);
    await connection.execute(
      'UPDATE teacher_profiles SET invitation_pending = TRUE WHERE user_id = ?',
      [teacher.id],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    return next(error);
  } finally {
    connection.release();
  }

  const invitationSent = await deliverInvitation(req, {
    email: teacher.email,
    name: teacher.name,
    teacherId: teacher.teacherId,
    temporaryPassword,
  });

  if (!invitationSent) {
    await pool.execute(`
      UPDATE users
      SET password_hash = ?
      WHERE id = ? AND password_hash = ?
    `, [teacher.currentPasswordHash, teacher.id, passwordHash]);
    await pool.execute(
      'UPDATE teacher_profiles SET invitation_pending = FALSE WHERE user_id = ?',
      [teacher.id],
    );
  }

  res.json({ invitationSent });
});

async function deliverInvitation(req, invitation) {
  try {
    const sendMail = req.app.locals.sendTeacherInvitationEmail;
    if (typeof sendMail !== 'function') {
      throw new Error('Teacher invitation mail service is unavailable.');
    }

    await sendMail(invitation);
    return true;
  } catch {
    req.app.locals.logger.error('Teacher invitation email delivery failed.');
    return false;
  }
}

module.exports = router;
