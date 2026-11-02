const express = require('express');
const bcrypt = require('bcrypt');
const { createHash, randomBytes } = require('node:crypto');
const pool = require('../database/pool');

const router = express.Router();
const pageSize = 8;
const hashInvitationToken = (token) => createHash('sha256').update(token).digest('hex');

router.use((req, res, next) => {
  if (['POST', 'PUT', 'PATCH'].includes(req.method) && !req.is('application/json')) {
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
      SELECT id, subject_code AS code, subject_name AS name, is_active AS isActive
      FROM subjects
      WHERE is_active = 1
      ORDER BY subject_name
    `);

    res.json({ subjects });
  } catch (error) {
    next(error);
  }
});

router.get('/:userId/subjects', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.userId)) {
    return res.status(404).json({ error: 'Teacher not found.' });
  }

  try {
    const [teachers] = await pool.execute(
      "SELECT id FROM users WHERE id = ? AND role = 'teacher' LIMIT 1",
      [req.params.userId],
    );
    if (!teachers.length) {
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    const [subjects] = await pool.execute(`
      SELECT s.id, s.subject_code AS code, s.subject_name AS name, s.is_active AS isActive
      FROM teacher_subjects ts
      JOIN subjects s ON s.id = ts.subject_id
      WHERE ts.teacher_user_id = ?
      ORDER BY s.subject_name
    `, [req.params.userId]);

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

router.patch('/:userId', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.userId)) {
    return res.status(404).json({ error: 'Teacher not found.' });
  }

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const userChanges = {};
  const profileChanges = {};
  const textFields = {
    department: ['department', 160],
    designation: ['designation', 160],
    highestQualification: ['highest_qualification', 180],
    universityInstitution: ['university_institution', 180],
    specialization: ['specialization', 180],
    previousEmployer: ['previous_organization', 180],
    previousJobRole: ['previous_job_role', 160],
    responsibilities: ['previous_job_responsibilities', 10000],
    skills: ['skills_areas_of_expertise', 10000],
    professionalSummary: ['professional_summary', 10000],
  };
  const allowedFields = new Set([
    'name', 'teacherId', 'email', 'contactNumber', 'status',
    ...Object.keys(textFields), 'yearsOfExperience',
  ]);

  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return res.status(400).json({ error: 'The update contains unsupported fields.' });
  }

  if (Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160) {
      return res.status(400).json({ error: 'Enter a teacher name of 1–160 characters.' });
    }
    userChanges.name = body.name.trim();
  }

  if (Object.hasOwn(body, 'teacherId')) {
    const teacherId = typeof body.teacherId === 'string' ? body.teacherId.trim() : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(teacherId)) {
      return res.status(400).json({ error: 'Enter a valid Teacher ID (up to 24 letters, numbers, dashes or underscores).' });
    }
    profileChanges.teacher_id = teacherId;
  }

  if (Object.hasOwn(body, 'email')) {
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Enter a valid email address.' });
    }
    userChanges.email = email;
    userChanges.login_id = email;
  }

  if (Object.hasOwn(body, 'contactNumber')) {
    const contact = typeof body.contactNumber === 'string' ? body.contactNumber.trim() : '';
    const digits = contact.replace(/\D/g, '');
    if (contact.length > 32 || (contact && (!/^[+()\d.\s-]+$/.test(contact) || digits.length < 7 || digits.length > 15))) {
      return res.status(400).json({ error: 'Enter a valid contact number or leave it blank.' });
    }
    profileChanges.contact_number = contact || null;
  }

  for (const [field, [column, maxLength]] of Object.entries(textFields)) {
    if (!Object.hasOwn(body, field)) continue;
    if (body[field] !== null && typeof body[field] !== 'string') {
      return res.status(400).json({ error: `${field} must be text.` });
    }
    const value = typeof body[field] === 'string' ? body[field].trim() : '';
    if (value.length > maxLength) {
      return res.status(400).json({ error: `${field} must be ${maxLength} characters or fewer.` });
    }
    profileChanges[column] = value || null;
  }

  if (Object.hasOwn(body, 'yearsOfExperience')) {
    const raw = body.yearsOfExperience;
    const years = raw === '' || raw === null ? null : Number(raw);
    if (years !== null && (!Number.isFinite(years) || years < 0 || years > 999.99)) {
      return res.status(400).json({ error: 'Experience must be between 0 and 999.99 years.' });
    }
    profileChanges.years_of_experience = years;
  }

  if (Object.hasOwn(body, 'status')) {
    if (!['active', 'inactive'].includes(body.status)) {
      return res.status(400).json({ error: 'Choose Active or Inactive account status.' });
    }
    userChanges.is_active = body.status === 'active';
  }

  if (!Object.keys(userChanges).length && !Object.keys(profileChanges).length) {
    return res.status(400).json({ error: 'Make at least one change before saving.' });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [teachers] = await connection.execute(`
      SELECT u.id
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher'
      FOR UPDATE
    `, [req.params.userId]);

    if (!teachers.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    if (userChanges.email) {
      const [duplicates] = await connection.execute(`
        SELECT id FROM users
        WHERE id <> ? AND (email = ? OR login_id = ?)
        LIMIT 1
      `, [req.params.userId, userChanges.email, userChanges.email]);
      if (duplicates.length) {
        await connection.rollback();
        return res.status(409).json({ error: 'Another account already uses that email address.' });
      }
    }

    if (profileChanges.teacher_id) {
      const [duplicates] = await connection.execute(
        'SELECT user_id FROM teacher_profiles WHERE teacher_id = ? AND user_id <> ? LIMIT 1',
        [profileChanges.teacher_id, req.params.userId],
      );
      if (duplicates.length) {
        await connection.rollback();
        return res.status(409).json({ error: 'Another teacher already uses that Teacher ID.' });
      }
    }

    const userEntries = Object.entries(userChanges);
    if (userEntries.length) {
      const assignments = userEntries.map(([column]) => `${column} = ?`).join(', ');
      await connection.execute(
        `UPDATE users SET ${assignments} WHERE id = ? AND role = 'teacher'`,
        [...userEntries.map(([, value]) => value), req.params.userId],
      );
    }

    const profileEntries = Object.entries(profileChanges);
    const profileAssignments = profileEntries.map(([column]) => `${column} = ?`);
    profileAssignments.push('updated_by_user_id = ?', "updated_by_role = 'administrator'", 'updated_at = CURRENT_TIMESTAMP');
    await connection.execute(
      `UPDATE teacher_profiles SET ${profileAssignments.join(', ')} WHERE user_id = ?`,
      [...profileEntries.map(([, value]) => value), req.user.id, req.params.userId],
    );

    await connection.commit();
    const [updated] = await pool.execute(`
      SELECT u.id, u.name, u.email, u.is_active AS isActive,
        p.teacher_id AS teacherId, p.contact_number AS contactNumber,
        p.department, p.designation,
        p.highest_qualification AS highestQualification,
        p.university_institution AS universityInstitution,
        p.specialization, p.years_of_experience AS yearsOfExperience,
        p.previous_organization AS previousEmployer,
        p.previous_job_role AS previousJobRole,
        p.previous_job_responsibilities AS responsibilities,
        p.skills_areas_of_expertise AS skills,
        p.professional_summary AS professionalSummary,
        p.updated_at AS updatedAt,
        p.updated_by_user_id AS updatedByUserId,
        p.updated_by_role AS updatedByRole
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher'
      LIMIT 1
    `, [req.params.userId]);

    res.json({ message: 'Teacher details updated.', teacher: updated[0] });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'The email or Teacher ID is already in use.' });
    }
    next(error);
  } finally {
    connection.release();
  }
});

router.put('/:userId/subjects', async (req, res, next) => {
  if (!/^\d+$/.test(req.params.userId)) {
    return res.status(404).json({ error: 'Teacher not found.' });
  }

  const subjectIds = req.body?.subjectIds;
  if (
    !Array.isArray(subjectIds)
    || subjectIds.length > 250
    || subjectIds.some((id) => !Number.isSafeInteger(Number(id)) || Number(id) < 1)
    || new Set(subjectIds.map(Number)).size !== subjectIds.length
  ) {
    return res.status(400).json({ error: 'Provide a list of unique valid subject IDs.' });
  }

  const normalizedIds = subjectIds.map(Number);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [teachers] = await connection.execute(
      "SELECT id FROM users WHERE id = ? AND role = 'teacher' FOR UPDATE",
      [req.params.userId],
    );
    if (!teachers.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Teacher not found.' });
    }

    const [currentMappings] = await connection.execute(
      'SELECT subject_id AS subjectId FROM teacher_subjects WHERE teacher_user_id = ? FOR UPDATE',
      [req.params.userId],
    );
    const desired = new Set(normalizedIds);
    const removed = currentMappings.map((row) => Number(row.subjectId)).filter((subjectId) => !desired.has(subjectId));
    if (removed.length) {
      const placeholders = removed.map(() => '?').join(', ');
      const [dependents] = await connection.execute(`
        SELECT s.subject_name AS subjectName, sec.section_name AS sectionName,
          sem.label AS semesterName, ay.label AS academicYearLabel
        FROM teacher_course_assignments a
        JOIN subjects s ON s.id = a.subject_id JOIN academic_sections sec ON sec.id = a.section_id
        LEFT JOIN academic_semesters sem ON sem.id = a.semester_id
        LEFT JOIN academic_years ay ON ay.id = a.academic_year_id
        WHERE a.teacher_user_id = ? AND a.subject_id IN (${placeholders})
        ORDER BY s.subject_name, sec.section_name LIMIT 1 FOR UPDATE
      `, [req.params.userId, ...removed]);
      if (dependents.length) {
        const allocation = dependents[0];
        await connection.rollback();
        return res.status(409).json({ error: `Cannot remove ${allocation.subjectName} from this teacher's subject mappings: an existing teaching allocation is recorded for ${allocation.sectionName}, ${allocation.semesterName || 'unknown semester'} (${allocation.academicYearLabel || 'legacy/unassigned academic year'}). Reassign or remove the teaching allocation before deleting this mapping.` });
      }
    }

    if (normalizedIds.length) {
      const placeholders = normalizedIds.map(() => '?').join(', ');
      const [subjects] = await connection.execute(`
        SELECT s.id
        FROM subjects s
        WHERE s.id IN (${placeholders})
          AND (s.is_active = 1 OR EXISTS (
            SELECT 1 FROM teacher_subjects ts
            WHERE ts.teacher_user_id = ? AND ts.subject_id = s.id
          ))
      `, [...normalizedIds, req.params.userId]);
      if (subjects.length !== normalizedIds.length) {
        await connection.rollback();
        return res.status(400).json({ error: 'One or more selected subjects are unavailable.' });
      }
    }

    if (removed.length) await connection.execute(
      `DELETE FROM teacher_subjects WHERE teacher_user_id = ? AND subject_id IN (${removed.map(() => '?').join(', ')})`,
      [req.params.userId, ...removed],
    );
    const currentSet = new Set(currentMappings.map((row) => Number(row.subjectId)));
    const added = normalizedIds.filter((subjectId) => !currentSet.has(subjectId));
    if (added.length) {
      const tuples = added.map(() => '(?, ?)').join(', ');
      await connection.execute(`INSERT INTO teacher_subjects (teacher_user_id, subject_id) VALUES ${tuples}`,
        added.flatMap((subjectId) => [req.params.userId, subjectId]));
    }
    await connection.commit();

    const [subjects] = await pool.execute(`
      SELECT s.id, s.subject_code AS code, s.subject_name AS name, s.is_active AS isActive
      FROM teacher_subjects ts
      JOIN subjects s ON s.id = ts.subject_id
      WHERE ts.teacher_user_id = ?
      ORDER BY s.subject_name
    `, [req.params.userId]);
    res.json({ message: 'Teacher subject assignments updated.', subjects });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const teacherId = typeof body.teacherId === 'string' ? body.teacherId.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const contactNumber = typeof body.contactNumber === 'string'
    ? body.contactNumber.trim()
    : '';

  if (
    !name
    || name.length > 160
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/.test(teacherId)
    || !email
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    return res.status(400).json({ error: 'Enter a valid teacher name, Teacher ID, and email address.' });
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

    const [existingTeacherIds] = await pool.execute(
      'SELECT user_id FROM teacher_profiles WHERE teacher_id = ? LIMIT 1',
      [teacherId],
    );
    if (existingTeacherIds.length) {
      return res.status(409).json({ error: 'A teacher already uses that Teacher ID.' });
    }

    const invitationToken = randomBytes(32).toString('base64url');
    const temporaryPassword = randomBytes(18).toString('base64url');
    const passwordHash = await bcrypt.hash(temporaryPassword, 12);
    const connection = await pool.getConnection();
    let userId;

    try {
      await connection.beginTransaction();
      const [created] = await connection.execute(
        "INSERT INTO users (name, login_id, email, password_hash, role, is_active, must_change_password) VALUES (?, ?, ?, ?, 'teacher', TRUE, TRUE)",
        [name, email, email, passwordHash],
      );
      userId = created.insertId;

      await connection.execute(`
        INSERT INTO teacher_profiles (user_id, teacher_id, contact_number, invitation_pending, invitation_setup_required)
        VALUES (?, ?, ?, TRUE, TRUE)
      `, [userId, teacherId, contactNumber]);
      await connection.execute(`INSERT INTO user_invitation_tokens (user_id, token_hash, expires_at)
        VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))`, [userId, hashInvitationToken(invitationToken)]);
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
      invitationToken,
      temporaryPassword,
    });

    if (!invitationSent) {
      await pool.execute('UPDATE teacher_profiles SET invitation_pending = FALSE WHERE user_id = ?', [userId]);
      await pool.execute('DELETE FROM user_invitation_tokens WHERE user_id = ? AND accepted_at IS NULL', [userId]);
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
  const invitationToken = randomBytes(32).toString('base64url');
  const temporaryPassword = randomBytes(18).toString('base64url');
  const passwordHash = await bcrypt.hash(temporaryPassword, 12);

  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT u.id, u.name, u.email, u.is_active AS isActive,
        u.must_change_password AS mustChangePassword,
        u.password_hash AS currentPasswordHash,
        p.invitation_setup_required AS invitationSetupRequired,
        p.teacher_id AS teacherId
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher'
      LIMIT 1
      FOR UPDATE
    `, [req.params.userId]);

    teacher = rows[0];
    if (!teacher) {
      await connection.rollback();
      return res.status(404).json({ error: 'Active teacher account not found.' });
    }

    if (!teacher.invitationSetupRequired) {
      await connection.rollback();
      return res.status(409).json({ error: 'This account is not awaiting invitation setup.' });
    }

    await connection.execute('UPDATE users SET password_hash = ?, must_change_password = TRUE, is_active = TRUE WHERE id = ?', [passwordHash, teacher.id]);
    await connection.execute('DELETE FROM user_invitation_tokens WHERE user_id = ? AND accepted_at IS NULL', [teacher.id]);
    await connection.execute(`INSERT INTO user_invitation_tokens (user_id, token_hash, expires_at)
      VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(), INTERVAL 24 HOUR))`, [teacher.id, hashInvitationToken(invitationToken)]);
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
    invitationToken,
    temporaryPassword,
  });

  if (!invitationSent) {
    await pool.execute('UPDATE users SET password_hash = ?, must_change_password = TRUE WHERE id = ?', [teacher.currentPasswordHash, teacher.id]);
    await pool.execute(
      'UPDATE teacher_profiles SET invitation_pending = FALSE WHERE user_id = ?',
      [teacher.id],
    );
    await pool.execute('DELETE FROM user_invitation_tokens WHERE user_id = ? AND accepted_at IS NULL', [teacher.id]);
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
