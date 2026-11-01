const express = require('express');
const pool = require('../database/pool');

const router = express.Router();
const pageSize = 8;
const validStudentId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const allowedFields = new Set([
  'name', 'studentId', 'email', 'contactNumber', 'programmeId',
  'branchOptionId', 'specialisationOptionId', 'enrolledYear',
  'expectedGraduationYear', 'sectionId', 'status',
]);

function asId(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null;
}

function badRequest(res, error, status = 400) {
  return res.status(status).json({ error });
}

function normalizedOptionalId(value) {
  if (value === '' || value === null || value === undefined) return null;
  return asId(value);
}

function validContact(value) {
  if (typeof value !== 'string') return false;
  const contact = value.trim();
  const digits = contact.replace(/\D/g, '');
  return contact.length > 0
    && contact.length <= 32
    && /^[+()\d.\s-]+$/.test(contact)
    && digits.length >= 7
    && digits.length <= 15;
}

async function validateAcademicPlacement(values) {
  const programmeId = asId(values.programmeId);
  const branchOptionId = normalizedOptionalId(values.branchOptionId);
  const specialisationOptionId = normalizedOptionalId(values.specialisationOptionId);
  const sectionId = asId(values.sectionId);
  const enrolledYear = Number(values.enrolledYear);
  const graduationYear = Number(values.expectedGraduationYear);
  if (!programmeId || !sectionId) return { error: 'Select a programme and section.' };
  if (values.branchOptionId && !branchOptionId) return { error: 'Select a valid branch or major.' };
  if (values.specialisationOptionId && !specialisationOptionId) return { error: 'Select a valid specialisation.' };
  if (!Number.isInteger(enrolledYear) || enrolledYear < 2000 || enrolledYear > 2200) {
    return { error: 'Enter a valid enrolled year.' };
  }
  if (!Number.isInteger(graduationYear) || graduationYear <= enrolledYear || graduationYear > 2210) {
    return { error: 'Enter a valid expected graduation year.' };
  }

  const [programmes] = await pool.execute(`
    SELECT id, min_duration_years AS minYears, max_duration_years AS maxYears
    FROM academic_programmes
    WHERE id = ? AND is_active = 1
    LIMIT 1
  `, [programmeId]);
  const programme = programmes[0];
  if (!programme) return { error: 'The selected programme is unavailable.' };
  const selectedDuration = graduationYear - enrolledYear;
  if (selectedDuration < Number(programme.minYears) || selectedDuration > Number(programme.maxYears)) {
    return { error: `Expected graduation must be ${programme.minYears}–${programme.maxYears} years after enrolment for this programme.` };
  }

  const [topOptions] = await pool.execute(`
    SELECT id, option_type AS type
    FROM academic_options
    WHERE programme_id = ? AND parent_option_id IS NULL AND is_active = 1
      AND option_type IN ('branch','major')
  `, [programmeId]);
  if (topOptions.length && !branchOptionId) {
    return { error: 'Select a branch or major for this programme.' };
  }
  if (branchOptionId) {
    const option = topOptions.find((item) => Number(item.id) === branchOptionId);
    if (!option) return { error: 'The selected branch or major does not belong to this programme.' };
  }
  if (specialisationOptionId) {
    if (!branchOptionId) return { error: 'Select a branch before choosing a specialisation.' };
    const [specialisations] = await pool.execute(`
      SELECT id FROM academic_options
      WHERE id = ? AND programme_id = ? AND parent_option_id = ?
        AND option_type = 'specialisation' AND is_active = 1
      LIMIT 1
    `, [specialisationOptionId, programmeId, branchOptionId]);
    if (!specialisations.length) return { error: 'The selected specialisation does not belong to this branch.' };
  }

  const [sections] = await pool.execute(`
    SELECT id FROM academic_sections
    WHERE id = ? AND programme_id = ? AND is_active = 1
      AND (branch_option_id IS NULL OR branch_option_id <=> ?)
    LIMIT 1
  `, [sectionId, programmeId, branchOptionId]);
  if (!sections.length) return { error: 'Select a section configured for the chosen programme and branch/major.' };

  const [calendar] = await pool.execute(`
    SELECT y.start_year AS startYear, t.term_key AS termKey
    FROM academic_years y
    JOIN academic_terms t ON t.academic_year_id = y.id
    WHERE y.is_active = 1 AND t.is_active = 1
    LIMIT 1
  `);
  if (!calendar.length) return { error: 'An administrator must configure the active academic year and semester calendar first.', status: 409 };
  const semesterNumber = (Number(calendar[0].startYear) - enrolledYear) * 2
    + (calendar[0].termKey === 'odd' ? 1 : 2);
  const maxSemester = selectedDuration * 2;
  if (semesterNumber < 1 || semesterNumber > maxSemester) {
    return { error: 'The active academic calendar places this student outside the selected programme duration.' };
  }
  const [semesters] = await pool.execute(`
    SELECT id, label, semester_number AS semesterNumber
    FROM academic_semesters
    WHERE semester_number = ? AND is_active = 1
    LIMIT 1
  `, [semesterNumber]);
  if (!semesters.length) {
    return { error: `Semester ${semesterNumber} is not configured as active in the academic structure.`, status: 409 };
  }
  return {
    programmeId,
    branchOptionId,
    specialisationOptionId,
    enrolledYear,
    graduationYear,
    semesterId: Number(semesters[0].id),
    semesterNumber,
    sectionId,
  };
}

router.use((req, res, next) => {
  if (['POST', 'PATCH'].includes(req.method) && !req.is('application/json')) {
    return badRequest(res, 'Send student data as JSON.', 415);
  }
  next();
});

router.get('/stats', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT
        COUNT(*) AS total,
        SUM(sp.user_id IS NOT NULL AND u.is_active = 1) AS activeAccounts,
        SUM(sp.user_id IS NULL) AS profilesWithoutAccounts,
        SUM(sp.programme_id IS NULL OR sp.section_id IS NULL OR sp.current_semester_id IS NULL) AS incompletePlacement
      FROM student_profiles sp
      LEFT JOIN users u ON u.id = sp.user_id AND u.role = 'student'
    `);
    res.json({ stats: Object.fromEntries(Object.entries(rows[0]).map(([key, value]) => [key, Number(value || 0)])) });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  try {
    const search = typeof req.query.search === 'string' ? req.query.search.trim().slice(0, 160) : '';
    const programmeId = asId(req.query.programme);
    const branchOptionId = asId(req.query.branch);
    const semesterId = asId(req.query.semester);
    const sectionId = asId(req.query.section);
    const status = ['active', 'inactive', 'not_linked'].includes(req.query.status) ? req.query.status : '';
    const page = Math.max(1, Math.min(10000, Number.parseInt(req.query.page, 10) || 1));
    const conditions = ['1 = 1'];
    const args = [];
    if (search) {
      conditions.push('(sp.name LIKE ? OR sp.student_id LIKE ? OR sp.email LIKE ?)');
      args.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (programmeId) { conditions.push('sp.programme_id = ?'); args.push(programmeId); }
    if (branchOptionId) { conditions.push('(sp.branch_option_id = ? OR sp.specialisation_option_id = ?)'); args.push(branchOptionId, branchOptionId); }
    if (semesterId) { conditions.push('sp.current_semester_id = ?'); args.push(semesterId); }
    if (sectionId) { conditions.push('sp.section_id = ?'); args.push(sectionId); }
    if (status === 'active') conditions.push('sp.user_id IS NOT NULL AND u.is_active = 1');
    else if (status === 'inactive') conditions.push('sp.user_id IS NOT NULL AND u.is_active = 0');
    else if (status === 'not_linked') conditions.push('sp.user_id IS NULL');
    const where = conditions.join(' AND ');
    const [[countRows], [records]] = await Promise.all([
      pool.execute(`
        SELECT COUNT(*) AS total
        FROM student_profiles sp
        LEFT JOIN users u ON u.id = sp.user_id AND u.role = 'student'
        WHERE ${where}
      `, args),
      pool.execute(`
        SELECT sp.id, sp.student_id AS studentId, sp.name, sp.email,
          sp.contact_number AS contactNumber, sp.enrolled_year AS enrolledYear,
          sp.expected_graduation_year AS expectedGraduationYear,
          sp.programme_id AS programmeId, sp.branch_option_id AS branchOptionId,
          sp.specialisation_option_id AS specialisationOptionId,
          sp.current_semester_id AS semesterId, sp.section_id AS sectionId,
          p.name AS programmeName, branch.name AS branchName,
          specialisation.name AS specialisationName,
          semester.label AS semesterName, semester.semester_number AS semesterNumber,
          section.section_name AS sectionName,
          CASE WHEN sp.user_id IS NULL THEN 'not_linked'
            WHEN u.is_active = 0 THEN 'inactive' ELSE 'active' END AS status
        FROM student_profiles sp
        LEFT JOIN users u ON u.id = sp.user_id AND u.role = 'student'
        LEFT JOIN academic_programmes p ON p.id = sp.programme_id
        LEFT JOIN academic_options branch ON branch.id = sp.branch_option_id
        LEFT JOIN academic_options specialisation ON specialisation.id = sp.specialisation_option_id
        LEFT JOIN academic_semesters semester ON semester.id = sp.current_semester_id
        LEFT JOIN academic_sections section ON section.id = sp.section_id
        WHERE ${where}
        ORDER BY sp.name, sp.id
        LIMIT ? OFFSET ?
      `, [...args, pageSize, (page - 1) * pageSize]),
    ]);
    const total = Number(countRows[0].total);
    res.json({
      students: records,
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    });
  } catch (error) {
    next(error);
  }
});

router.get('/:studentProfileId', async (req, res, next) => {
  const studentProfileId = asId(req.params.studentProfileId);
  if (!studentProfileId) return badRequest(res, 'Student not found.', 404);
  try {
    const [records] = await pool.execute(`
      SELECT sp.id, sp.user_id AS userId, sp.student_id AS studentId,
        sp.name, sp.email, sp.contact_number AS contactNumber,
        sp.programme_id AS programmeId, p.name AS programmeName,
        sp.branch_option_id AS branchOptionId, branch.name AS branchName,
        sp.specialisation_option_id AS specialisationOptionId,
        specialisation.name AS specialisationName,
        sp.enrolled_year AS enrolledYear,
        sp.expected_graduation_year AS expectedGraduationYear,
        sp.current_semester_id AS semesterId,
        semester.label AS semesterName, semester.semester_number AS semesterNumber,
        sp.section_id AS sectionId, section.section_name AS sectionName,
        CASE WHEN sp.user_id IS NULL THEN 'not_linked'
          WHEN u.is_active = 0 THEN 'inactive' ELSE 'active' END AS status,
        sp.created_at AS createdAt, sp.updated_at AS updatedAt
      FROM student_profiles sp
      LEFT JOIN users u ON u.id = sp.user_id AND u.role = 'student'
      LEFT JOIN academic_programmes p ON p.id = sp.programme_id
      LEFT JOIN academic_options branch ON branch.id = sp.branch_option_id
      LEFT JOIN academic_options specialisation ON specialisation.id = sp.specialisation_option_id
      LEFT JOIN academic_semesters semester ON semester.id = sp.current_semester_id
      LEFT JOIN academic_sections section ON section.id = sp.section_id
      WHERE sp.id = ?
      LIMIT 1
    `, [studentProfileId]);
    if (!records[0]) return badRequest(res, 'Student not found.', 404);
    res.json({ student: records[0] });
  } catch (error) {
    next(error);
  }
});

function validatePersonalFields(body, requireAll = true) {
  const result = {};
  if (requireAll || Object.hasOwn(body, 'name')) {
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 160) {
      return { error: 'Enter a student name of 1–160 characters.' };
    }
    result.name = body.name.trim();
  }
  if (requireAll || Object.hasOwn(body, 'studentId')) {
    if (typeof body.studentId !== 'string' || !validStudentId.test(body.studentId.trim())) {
      return { error: 'Enter a valid Student ID of up to 32 letters, numbers, dashes or underscores.' };
    }
    result.studentId = body.studentId.trim();
  }
  if (requireAll || Object.hasOwn(body, 'email')) {
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (email.length > 254 || !validEmail.test(email)) return { error: 'Enter a valid email address.' };
    result.email = email;
  }
  if (requireAll || Object.hasOwn(body, 'contactNumber')) {
    if (!validContact(body.contactNumber)) return { error: 'Enter a valid contact number.' };
    result.contactNumber = body.contactNumber.trim();
  }
  return result;
}

router.post('/', async (req, res, next) => {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some((field) => !allowedFields.has(field)) || Object.hasOwn(body, 'status')) {
    return badRequest(res, 'The student record contains unsupported fields.');
  }
  const personal = validatePersonalFields(body);
  if (personal.error) return badRequest(res, personal.error);
  const academic = await validateAcademicPlacement(body);
  if (academic.error) return badRequest(res, academic.error, academic.status || 400);

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [duplicates] = await connection.execute(`
      SELECT id FROM student_profiles
      WHERE student_id = ? OR email = ?
      LIMIT 1 FOR UPDATE
    `, [personal.studentId, personal.email]);
    if (duplicates.length) {
      await connection.rollback();
      return badRequest(res, 'A student record already uses that Student ID or email address.', 409);
    }
    const [accounts] = await connection.execute(`
      SELECT id, role FROM users
      WHERE email = ? OR login_id = ?
      LIMIT 1
    `, [personal.email, personal.email]);
    if (accounts.length && accounts[0].role !== 'student') {
      await connection.rollback();
      return badRequest(res, 'That email address belongs to a non-student account.', 409);
    }
    let linkedUserId = accounts[0]?.id ?? null;
    if (linkedUserId) {
      const [linked] = await connection.execute('SELECT id FROM student_profiles WHERE user_id = ? LIMIT 1', [linkedUserId]);
      if (linked.length) {
        await connection.rollback();
        return badRequest(res, 'That student account is already linked to a student record.', 409);
      }
    }
    const [created] = await connection.execute(`
      INSERT INTO student_profiles (
        user_id, student_id, name, email, contact_number,
        programme_id, branch_option_id, specialisation_option_id,
        enrolled_year, expected_graduation_year, current_semester_id, section_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      linkedUserId, personal.studentId, personal.name, personal.email, personal.contactNumber,
      academic.programmeId, academic.branchOptionId, academic.specialisationOptionId,
      academic.enrolledYear, academic.graduationYear, academic.semesterId, academic.sectionId,
    ]);
    await connection.commit();
    const [records] = await pool.execute('SELECT id, student_id AS studentId, name, email FROM student_profiles WHERE id = ?', [created.insertId]);
    res.status(201).json({ message: 'Student record added successfully.', student: records[0] });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'A student record already uses that Student ID or email address.', 409);
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/:studentProfileId', async (req, res, next) => {
  const studentProfileId = asId(req.params.studentProfileId);
  if (!studentProfileId) return badRequest(res, 'Student not found.', 404);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  if (Object.keys(body).some((field) => !allowedFields.has(field))) {
    return badRequest(res, 'The student update contains unsupported fields.');
  }
  if (!Object.keys(body).length) return badRequest(res, 'Provide at least one student change.');

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(`
      SELECT id, user_id AS userId, student_id AS studentId, name, email,
        contact_number AS contactNumber, programme_id AS programmeId,
        branch_option_id AS branchOptionId, specialisation_option_id AS specialisationOptionId,
        enrolled_year AS enrolledYear, expected_graduation_year AS expectedGraduationYear,
        section_id AS sectionId
      FROM student_profiles WHERE id = ? FOR UPDATE
    `, [studentProfileId]);
    if (!rows.length) {
      await connection.rollback();
      return badRequest(res, 'Student not found.', 404);
    }
    const current = rows[0];
    const personalInput = {};
    for (const field of ['name', 'studentId', 'email', 'contactNumber']) {
      if (Object.hasOwn(body, field)) personalInput[field] = body[field];
    }
    const personal = validatePersonalFields(personalInput, false);
    if (personal.error) {
      await connection.rollback();
      return badRequest(res, personal.error);
    }
    const merged = { ...current, ...body };
    const nextName = personal.name ?? current.name;
    const nextStudentId = personal.studentId ?? current.studentId;
    const nextEmail = personal.email ?? current.email;
    const nextContactNumber = personal.contactNumber ?? current.contactNumber;
    merged.name = nextName;
    merged.studentId = nextStudentId;
    merged.email = nextEmail;
    merged.contactNumber = nextContactNumber;

    const academicFields = ['programmeId', 'branchOptionId', 'specialisationOptionId', 'enrolledYear', 'expectedGraduationYear', 'sectionId'];
    const requiresPlacement = academicFields.some((field) => Object.hasOwn(body, field));
    let academic = null;
    if (requiresPlacement) {
      academic = await validateAcademicPlacement(merged);
      if (academic.error) {
        await connection.rollback();
        return badRequest(res, academic.error, academic.status || 400);
      }
    }

    if (nextEmail !== current.email) {
      const [duplicates] = await connection.execute(`
        SELECT id FROM student_profiles WHERE email = ? AND id <> ? LIMIT 1
      `, [nextEmail, studentProfileId]);
      const [accountDuplicates] = await connection.execute(`
        SELECT id FROM users
        WHERE (email = ? OR login_id = ?) AND (? IS NULL OR id <> ?)
        LIMIT 1
      `, [nextEmail, nextEmail, current.userId, current.userId]);
      if (duplicates.length || accountDuplicates.length) {
        await connection.rollback();
        return badRequest(res, 'Another account already uses that email address.', 409);
      }
    }
    if (nextStudentId !== current.studentId) {
      const [duplicates] = await connection.execute(`
        SELECT id FROM student_profiles WHERE student_id = ? AND id <> ? LIMIT 1
      `, [nextStudentId, studentProfileId]);
      if (duplicates.length) {
        await connection.rollback();
        return badRequest(res, 'Another student already uses that Student ID.', 409);
      }
    }

    const profileChanges = {};
    if (Object.hasOwn(body, 'name')) profileChanges.name = nextName;
    if (Object.hasOwn(body, 'studentId')) profileChanges.student_id = nextStudentId;
    if (Object.hasOwn(body, 'email')) profileChanges.email = nextEmail;
    if (Object.hasOwn(body, 'contactNumber')) profileChanges.contact_number = nextContactNumber;
    if (academic) {
      Object.assign(profileChanges, {
        programme_id: academic.programmeId,
        branch_option_id: academic.branchOptionId,
        specialisation_option_id: academic.specialisationOptionId,
        enrolled_year: academic.enrolledYear,
        expected_graduation_year: academic.graduationYear,
        current_semester_id: academic.semesterId,
        section_id: academic.sectionId,
      });
    }
    if (Object.keys(profileChanges).length) {
      const assignments = Object.keys(profileChanges).map((field) => `${field} = ?`).join(', ');
      await connection.execute(`UPDATE student_profiles SET ${assignments} WHERE id = ?`, [
        ...Object.values(profileChanges), studentProfileId,
      ]);
    }
    if (current.userId && (nextName !== current.name || nextEmail !== current.email)) {
      await connection.execute(`
        UPDATE users SET name = ?, email = ?, login_id = ?
        WHERE id = ? AND role = 'student'
      `, [nextName, nextEmail, nextEmail, current.userId]);
    }
    if (Object.hasOwn(body, 'status')) {
      if (!['active', 'inactive'].includes(body.status)) {
        await connection.rollback();
        return badRequest(res, 'Choose Active or Inactive account status.');
      }
      if (!current.userId) {
        await connection.rollback();
        return badRequest(res, 'This profile has no linked account to change status for.');
      }
      await connection.execute('UPDATE users SET is_active = ? WHERE id = ? AND role = \'student\'', [body.status === 'active', current.userId]);
    }
    await connection.commit();
    res.json({ message: 'Student record updated successfully.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'A student ID or email is already in use.', 409);
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
