const express = require('express');
const pool = require('../database/pool');

const router = express.Router();

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

async function readProfile(userId) {
  const [rows] = await pool.execute(`
    SELECT
      u.id, u.name, u.login_id AS loginId, u.email, u.role,
      u.is_active AS isActive,
      p.teacher_id AS teacherId,
      p.contact_number AS contactNumber,
      p.department, p.designation,
      p.highest_qualification AS highestQualification,
      p.university_institution AS universityInstitution,
      p.specialization,
      p.years_of_experience AS yearsOfExperience,
      p.previous_organization AS previousEmployer,
      p.previous_job_role AS previousJobRole,
      p.previous_job_responsibilities AS responsibilities,
      p.skills_areas_of_expertise AS skills,
      p.professional_summary AS professionalSummary,
      p.updated_at AS updatedAt,
      p.updated_by_user_id AS updatedByUserId,
      p.updated_by_role AS updatedByRole,
      editor.name AS updatedByName
    FROM users u
    JOIN teacher_profiles p ON p.user_id = u.id
    LEFT JOIN users editor ON editor.id = p.updated_by_user_id
    WHERE u.id = ? AND u.role = 'teacher'
    LIMIT 1
  `, [userId]);
  if (!rows[0]) return null;

  const [subjects] = await pool.execute(`
    SELECT s.id, s.subject_code AS code, s.subject_name AS name
    FROM teacher_subjects ts
    JOIN subjects s ON s.id = ts.subject_id AND s.is_active = 1
    WHERE ts.teacher_user_id = ?
    ORDER BY s.subject_name
  `, [userId]);
  return { ...rows[0], subjects };
}

router.get('/', async (req, res, next) => {
  try {
    const profile = await readProfile(req.user.id);
    if (!profile) return res.status(404).json({ error: 'Teacher profile not found.' });
    res.json({ profile });
  } catch (error) {
    next(error);
  }
});

router.patch('/', async (req, res, next) => {
  if (!req.is('application/json')) {
    return res.status(415).json({ error: 'Send profile changes as JSON.' });
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body
    : {};
  const allowedFields = new Set(['name', 'contactNumber', 'yearsOfExperience', ...Object.keys(textFields)]);
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return res.status(400).json({ error: 'Only permitted personal and professional fields can be changed.' });
  }

  const userChanges = {};
  const profileChanges = {};
  if (Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160) {
      return res.status(400).json({ error: 'Enter a name of 1–160 characters.' });
    }
    userChanges.name = body.name.trim();
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
    const value = raw === '' || raw === null ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 999.99)) {
      return res.status(400).json({ error: 'Experience must be between 0 and 999.99 years.' });
    }
    profileChanges.years_of_experience = value;
  }
  if (!Object.keys(userChanges).length && !Object.keys(profileChanges).length) {
    return res.status(400).json({ error: 'Make at least one change before saving.' });
  }

  const connection = await pool.getConnection();
  let transactionOpen = false;
  try {
    await connection.beginTransaction();
    transactionOpen = true;
    const [teachers] = await connection.execute(`
      SELECT u.id
      FROM users u
      JOIN teacher_profiles p ON p.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher' AND u.is_active = 1
      FOR UPDATE
    `, [req.user.id]);
    if (!teachers.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Teacher profile not found.' });
    }

    const userEntries = Object.entries(userChanges);
    if (userEntries.length) {
      const assignments = userEntries.map(([column]) => `${column} = ?`).join(', ');
      await connection.execute(`UPDATE users SET ${assignments} WHERE id = ? AND role = 'teacher'`, [
        ...userEntries.map(([, value]) => value), req.user.id,
      ]);
    }
    const profileEntries = Object.entries(profileChanges);
    const assignments = profileEntries.map(([column]) => `${column} = ?`);
    assignments.push('updated_by_user_id = ?', "updated_by_role = 'teacher'", 'updated_at = CURRENT_TIMESTAMP');
    await connection.execute(`UPDATE teacher_profiles SET ${assignments.join(', ')} WHERE user_id = ?`, [
      ...profileEntries.map(([, value]) => value), req.user.id, req.user.id,
    ]);
    await connection.commit();
    transactionOpen = false;

    const profile = await readProfile(req.user.id);
    res.json({ message: 'Profile updated successfully.', profile });
  } catch (error) {
    if (transactionOpen) await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
