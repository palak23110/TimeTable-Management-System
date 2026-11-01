'use strict';

const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../database/pool');

const router = express.Router();
const assignableStatuses = ['published', 'manual'];

function id(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null;
}

function badRequest(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

function normalizeName(value, max = 255) {
  return typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
}

function uniqueIds(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 250
    && value.every((item) => id(item)) && new Set(value.map(Number)).size === value.length
    ? value.map(Number)
    : null;
}

router.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) {
    return badRequest(res, 'Send subject changes as JSON.', 415);
  }
  next();
});

router.get('/import/preview', (req, res) => {
  const reportPath = path.resolve(__dirname, '../reports/curriculum-mapping-preview.json');
  if (!fs.existsSync(reportPath)) return badRequest(res, 'No curriculum mapping preview is available yet.', 404);
  res.json(JSON.parse(fs.readFileSync(reportPath, 'utf8')));
});

router.post('/import/apply', async (req, res, next) => {
  const reportPath = path.resolve(__dirname, '../reports/curriculum-mapping-preview.json');
  if (!fs.existsSync(reportPath)) return badRequest(res, 'Generate and review a curriculum mapping preview first.', 409);
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (req.body?.reportHash !== report.reportHash) return badRequest(res, 'The approval hash does not match the current mapping preview.', 409);
  if (process.env.CURRICULUM_IMPORT_APPROVED !== 'true') {
    return badRequest(res, 'Curriculum import is locked until explicit approval is configured.', 403);
  }
  try {
    const { applyApprovedImport } = require('../database/import-curriculum');
    const result = await applyApprovedImport(report, req.body.reportHash);
    const summaryPath = path.resolve(__dirname, '../reports/curriculum-import-latest.json');
    fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    res.json({ inserted: result.inserted, updated: result.updated, skipped: result.skipped, summary: 'Import summary written to the curriculum reports folder.' });
  } catch (error) {
    if (/blocked|approval/i.test(error.message)) return badRequest(res, error.message, 403);
    next(error);
  }
});

router.get('/stats', async (req, res, next) => {
  try {
    const [rows] = await pool.execute(`
      SELECT COUNT(*) AS total,
        SUM(c.is_active = 1 AND c.subject_id IS NOT NULL) AS active,
        SUM(c.record_status = 'choice_required' AND c.is_active = 1) AS choiceRequired,
        SUM(c.record_status IN ('area_only','needs_review','partial') AND c.is_active = 1) AS needsReview
      FROM curriculum_subjects c
    `);
    res.json({ stats: rows[0] });
  } catch (error) {
    next(error);
  }
});

router.get('/options', async (req, res, next) => {
  try {
    const programmeId = id(req.query.programmeId);
    const semesterId = id(req.query.semesterId);
    const [programmes] = await pool.execute(`
      SELECT id, code, name, is_active AS isActive FROM academic_programmes ORDER BY name
    `);
    const [branches] = await pool.execute(`
      SELECT id, programme_id AS programmeId, parent_option_id AS parentOptionId,
        code, name, option_type AS type, is_active AS isActive
      FROM academic_options ORDER BY name
    `);
    const [semesters] = await pool.execute(`
      SELECT id, semester_number AS semesterNumber, label, is_active AS isActive
      FROM academic_semesters ORDER BY semester_number
    `);
    const [sections] = await pool.execute(`
      SELECT s.id, s.programme_id AS programmeId, s.branch_option_id AS branchOptionId,
        s.section_name AS name, s.is_active AS isActive, p.name AS programmeName,
        o.name AS branchName
      FROM academic_sections s
      JOIN academic_programmes p ON p.id = s.programme_id
      LEFT JOIN academic_options o ON o.id = s.branch_option_id
      WHERE (? IS NULL OR s.programme_id = ?)
      ORDER BY p.name, o.name, s.section_name
    `, [programmeId, programmeId]);
    const [teachers] = await pool.execute(`
      SELECT u.id AS userId, u.name, tp.teacher_id AS teacherId, u.email
      FROM users u JOIN teacher_profiles tp ON tp.user_id = u.id
      WHERE u.role = 'teacher' AND u.is_active = 1
      ORDER BY u.name
    `);
    const [students] = await pool.execute(`
      SELECT sp.id AS studentProfileId, sp.student_id AS studentId, sp.name,
        sp.programme_id AS programmeId, sp.branch_option_id AS branchOptionId,
        sp.current_semester_id AS semesterId, sp.section_id AS sectionId,
        p.name AS programmeName, s.section_name AS sectionName
      FROM student_profiles sp
      LEFT JOIN academic_programmes p ON p.id = sp.programme_id
      LEFT JOIN academic_sections s ON s.id = sp.section_id
      ORDER BY sp.name
    `);
    const [curriculumSubjects] = await pool.execute(`
      SELECT c.id AS curriculumSubjectId, c.course_name AS courseName,
        c.course_code AS courseCode, c.credits, c.record_status AS recordStatus,
        c.programme_id AS programmeId, c.branch_option_id AS branchOptionId,
        c.semester_id AS semesterId, c.semester_label AS semesterLabel,
        p.name AS programmeName, b.name AS branchName, sem.label AS semesterName
      FROM curriculum_subjects c
      LEFT JOIN academic_programmes p ON p.id = c.programme_id
      LEFT JOIN academic_options b ON b.id = c.branch_option_id
      LEFT JOIN academic_semesters sem ON sem.id = c.semester_id
      WHERE c.is_active = 1 AND c.subject_id IS NOT NULL
        AND c.record_status IN ('published','manual')
        AND (? IS NULL OR c.programme_id = ?)
        AND (? IS NULL OR c.semester_id = ?)
      ORDER BY c.course_name
    `, [programmeId, programmeId, semesterId, semesterId]);
    res.json({ programmes, branches, semesters, sections, teachers, students, curriculumSubjects });
  } catch (error) {
    next(error);
  }
});

router.get('/assignments', async (req, res, next) => {
  const type = req.query.type;
  if (!['class', 'teacher', 'student'].includes(type)) return badRequest(res, 'Select class, teacher, or student assignments.');
  try {
    if (type === 'class') {
      const [assignments] = await pool.execute(`
        SELECT a.id, a.section_id AS sectionId, a.curriculum_subject_id AS curriculumSubjectId,
          c.course_name AS courseName, c.course_code AS courseCode, c.credits,
          p.name AS programmeName, sec.section_name AS sectionName,
          sem.label AS semesterName
        FROM class_course_assignments a
        JOIN curriculum_subjects c ON c.id = a.curriculum_subject_id
        JOIN academic_sections sec ON sec.id = a.section_id
        JOIN academic_programmes p ON p.id = sec.programme_id
        LEFT JOIN academic_semesters sem ON sem.id = c.semester_id
        ORDER BY p.name, sec.section_name, c.course_name
      `);
      return res.json({ assignments });
    }
    if (type === 'teacher') {
      const [assignments] = await pool.execute(`
        SELECT a.id, a.teacher_user_id AS teacherUserId, a.section_id AS sectionId,
          a.curriculum_subject_id AS curriculumSubjectId, u.name AS teacherName,
          tp.teacher_id AS teacherId, c.course_name AS courseName, c.course_code AS courseCode,
          p.name AS programmeName, sec.section_name AS sectionName, sem.label AS semesterName
        FROM teacher_course_assignments a
        JOIN users u ON u.id = a.teacher_user_id
        JOIN teacher_profiles tp ON tp.user_id = u.id
        JOIN curriculum_subjects c ON c.id = a.curriculum_subject_id
        JOIN academic_sections sec ON sec.id = a.section_id
        JOIN academic_programmes p ON p.id = sec.programme_id
        LEFT JOIN academic_semesters sem ON sem.id = c.semester_id
        ORDER BY u.name, c.course_name
      `);
      return res.json({ assignments });
    }
    const [assignments] = await pool.execute(`
      SELECT a.id, a.student_profile_id AS studentProfileId,
        a.curriculum_subject_id AS curriculumSubjectId, a.assignment_action AS action,
        sp.name AS studentName, sp.student_id AS studentId, c.course_name AS courseName,
        c.course_code AS courseCode, p.name AS programmeName, a.created_at AS createdAt
      FROM student_course_assignments a
      JOIN student_profiles sp ON sp.id = a.student_profile_id
      JOIN curriculum_subjects c ON c.id = a.curriculum_subject_id
      LEFT JOIN academic_programmes p ON p.id = sp.programme_id
      ORDER BY sp.name, c.course_name
    `);
    res.json({ assignments });
  } catch (error) {
    next(error);
  }
});

router.get('/assignments/effective/:studentProfileId', async (req, res, next) => {
  const studentProfileId = id(req.params.studentProfileId);
  if (!studentProfileId) return badRequest(res, 'Student record not found.', 404);
  try {
    const [subjects] = await pool.execute(`
      SELECT c.id AS curriculumSubjectId, c.course_name AS courseName,
        c.course_code AS courseCode, c.credits, c.semester_label AS semesterLabel,
        CASE
          WHEN EXISTS (SELECT 1 FROM class_course_assignments ca
            WHERE ca.section_id = sp.section_id AND ca.curriculum_subject_id = c.id)
            THEN 'class'
          ELSE 'individual'
        END AS assignmentSource
      FROM student_profiles sp
      JOIN curriculum_subjects c ON c.is_active = 1
      WHERE sp.id = ?
        AND (
          EXISTS (SELECT 1 FROM class_course_assignments ca
            WHERE ca.section_id = sp.section_id AND ca.curriculum_subject_id = c.id)
          OR EXISTS (SELECT 1 FROM student_course_assignments a
            WHERE a.student_profile_id = sp.id AND a.curriculum_subject_id = c.id
              AND a.assignment_action = 'include')
        )
        AND NOT EXISTS (SELECT 1 FROM student_course_assignments x
          WHERE x.student_profile_id = sp.id AND x.curriculum_subject_id = c.id
            AND x.assignment_action = 'exclude')
      ORDER BY c.course_name
    `, [studentProfileId]);
    res.json({ subjects });
  } catch (error) {
    next(error);
  }
});

async function getAssignableCurriculum(connection, curriculumSubjectId) {
  const [rows] = await connection.execute(`
    SELECT c.id, c.programme_id AS programmeId, c.branch_option_id AS branchOptionId,
      c.semester_id AS semesterId, c.record_status AS recordStatus, c.subject_id AS subjectId
    FROM curriculum_subjects c
    JOIN subjects s ON s.id = c.subject_id AND s.is_active = 1
    WHERE c.id = ? AND c.is_active = 1 AND c.record_status IN ('published','manual')
    LIMIT 1 FOR UPDATE
  `, [curriculumSubjectId]);
  return rows[0] || null;
}

async function validateSectionScope(connection, curriculum, sectionId) {
  const [sections] = await connection.execute(`
    SELECT id, programme_id AS programmeId, branch_option_id AS branchOptionId
    FROM academic_sections WHERE id = ? AND is_active = 1 LIMIT 1
  `, [sectionId]);
  if (!sections.length) return false;
  const section = sections[0];
  if (curriculum.programmeId && Number(curriculum.programmeId) !== Number(section.programmeId)) return false;
  if (curriculum.branchOptionId) {
    if (!section.branchOptionId) return false;
    if (Number(curriculum.branchOptionId) !== Number(section.branchOptionId)) {
      const [parents] = await connection.execute('SELECT parent_option_id AS parentId FROM academic_options WHERE id = ? LIMIT 1', [curriculum.branchOptionId]);
      if (Number(parents[0]?.parentId) !== Number(section.branchOptionId)) return false;
    }
  }
  return true;
}

router.post('/assignments/class', async (req, res, next) => {
  const sectionId = id(req.body?.sectionId);
  const semesterId = id(req.body?.semesterId);
  const subjectIds = uniqueIds(req.body?.curriculumSubjectIds);
  if (!sectionId || !semesterId || !subjectIds) return badRequest(res, 'Select a semester, class, and one or more valid courses.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const curriculumSubjectId of subjectIds) {
      const curriculum = await getAssignableCurriculum(connection, curriculumSubjectId);
      if (!curriculum || Number(curriculum.semesterId) !== semesterId || !(await validateSectionScope(connection, curriculum, sectionId))) {
        await connection.rollback();
        return badRequest(res, 'One or more courses do not belong to the selected class.', 409);
      }
      await connection.execute(`
        INSERT INTO class_course_assignments (section_id, curriculum_subject_id, created_by_user_id)
        VALUES (?, ?, ?)
      `, [sectionId, curriculumSubjectId, req.user.id]);
    }
    await connection.commit();
    res.status(201).json({ message: 'Course assignment saved.', count: subjectIds.length });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'One or more courses are already assigned to this class.', 409);
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/assignments/teacher', async (req, res, next) => {
  const teacherUserId = id(req.body?.teacherUserId);
  const sectionId = id(req.body?.sectionId);
  const semesterId = id(req.body?.semesterId);
  const subjectIds = uniqueIds(req.body?.curriculumSubjectIds);
  if (!teacherUserId || !sectionId || !semesterId || !subjectIds) return badRequest(res, 'Select an active teacher, semester, class, and one or more courses.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [teachers] = await connection.execute(`
      SELECT u.id FROM users u JOIN teacher_profiles tp ON tp.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher' AND u.is_active = 1 LIMIT 1
    `, [teacherUserId]);
    if (!teachers.length) {
      await connection.rollback();
      return badRequest(res, 'The selected teacher is unavailable.', 404);
    }
    for (const curriculumSubjectId of subjectIds) {
      const curriculum = await getAssignableCurriculum(connection, curriculumSubjectId);
      if (!curriculum || Number(curriculum.semesterId) !== semesterId || !(await validateSectionScope(connection, curriculum, sectionId))) {
        await connection.rollback();
        return badRequest(res, 'One or more courses do not belong to the selected class.', 409);
      }
      await connection.execute(`
        INSERT INTO teacher_course_assignments (
          teacher_user_id, section_id, curriculum_subject_id, created_by_user_id
        ) VALUES (?, ?, ?, ?)
      `, [teacherUserId, sectionId, curriculumSubjectId, req.user.id]);
    }
    await connection.commit();
    res.status(201).json({ message: 'Teacher course assignment saved.', count: subjectIds.length });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'One or more courses are already assigned to this teacher and class.', 409);
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/assignments/student', async (req, res, next) => {
  const studentProfileId = id(req.body?.studentProfileId);
  const curriculumSubjectId = id(req.body?.curriculumSubjectId);
  if (!studentProfileId || !curriculumSubjectId) return badRequest(res, 'Select a student and a course.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const curriculum = await getAssignableCurriculum(connection, curriculumSubjectId);
    const [students] = await connection.execute(`
      SELECT id, programme_id AS programmeId, branch_option_id AS branchOptionId,
        current_semester_id AS semesterId, section_id AS sectionId,
        specialisation_option_id AS specialisationOptionId
      FROM student_profiles WHERE id = ? LIMIT 1 FOR UPDATE
    `, [studentProfileId]);
    const student = students[0];
    let branchMatches = true;
    if (curriculum?.branchOptionId && student) {
      branchMatches = Number(curriculum.branchOptionId) === Number(student.branchOptionId)
        || Number(curriculum.branchOptionId) === Number(student.specialisationOptionId);
      if (!branchMatches) {
        const [parent] = await connection.execute('SELECT parent_option_id AS parentId FROM academic_options WHERE id = ? LIMIT 1', [curriculum.branchOptionId]);
        branchMatches = Number(parent[0]?.parentId) === Number(student.branchOptionId)
          || Number(parent[0]?.parentId) === Number(student.specialisationOptionId);
      }
    }
    if (!curriculum || !student || !student.sectionId
      || (curriculum.programmeId && Number(curriculum.programmeId) !== Number(student.programmeId))
      || !branchMatches
      || (curriculum.semesterId && Number(curriculum.semesterId) !== Number(student.semesterId))) {
      await connection.rollback();
      return badRequest(res, 'The course does not match the student’s academic placement.', 409);
    }
    await connection.execute(`
      INSERT INTO student_course_assignments (
        student_profile_id, curriculum_subject_id, assignment_action, created_by_user_id
      ) VALUES (?, ?, 'include', ?)
      ON DUPLICATE KEY UPDATE assignment_action = 'include', created_by_user_id = VALUES(created_by_user_id)
    `, [studentProfileId, curriculumSubjectId, req.user.id]);
    await connection.commit();
    res.status(201).json({ message: 'Individual course assignment saved.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/assignments/student/:assignmentId', async (req, res, next) => {
  const assignmentId = id(req.params.assignmentId);
  const action = req.body?.action;
  if (!assignmentId || !['include', 'exclude'].includes(action)) return badRequest(res, 'Choose include or exclude for this student course.');
  try {
    const [result] = await pool.execute('UPDATE student_course_assignments SET assignment_action = ? WHERE id = ?', [action, assignmentId]);
    if (!result.affectedRows) return badRequest(res, 'Student course assignment not found.', 404);
    res.json({ message: `Student course ${action === 'exclude' ? 'removed from inherited class courses' : 'included'} successfully.` });
  } catch (error) {
    next(error);
  }
});

router.delete('/assignments/:type/:assignmentId', async (req, res, next) => {
  const type = req.params.type;
  const assignmentId = id(req.params.assignmentId);
  const table = { class: 'class_course_assignments', teacher: 'teacher_course_assignments', student: 'student_course_assignments' }[type];
  if (!table || !assignmentId) return badRequest(res, 'Assignment not found.', 404);
  try {
    const [result] = await pool.execute(`DELETE FROM ${table} WHERE id = ?`, [assignmentId]);
    if (!result.affectedRows) return badRequest(res, 'Assignment not found.', 404);
    res.json({ message: 'Assignment removed.' });
  } catch (error) {
    next(error);
  }
});

router.get('/', async (req, res, next) => {
  const page = Math.max(1, Math.min(100_000, Number.parseInt(req.query.page, 10) || 1));
  const pageSize = 8;
  const offset = (page - 1) * pageSize;
  const programmeId = id(req.query.programmeId);
  const branchOptionId = id(req.query.branchOptionId);
  const semesterId = id(req.query.semesterId);
  const credits = req.query.credits === undefined || req.query.credits === '' ? null : Number(req.query.credits);
  if (credits != null && (![2, 3, 4, 5].includes(credits))) return badRequest(res, 'Choose a supported credit value.');
  const search = typeof req.query.search === 'string' ? `%${req.query.search.trim().slice(0, 100)}%` : null;
  const activeOnly = req.query.includeInactive !== 'true';
  try {
    // Search uses two placeholders, all other filters preserve empty dropdowns as unfiltered.
    const queryWhere = `
      WHERE (? IS NULL OR c.course_name LIKE ? OR c.course_code LIKE ?)
        AND (? IS NULL OR c.programme_id = ?)
        AND (? IS NULL OR c.branch_option_id = ?)
        AND (? IS NULL OR c.semester_id = ?)
        AND (? IS NULL OR c.credits = ?)
        AND (? = 0 OR c.is_active = 1)
    `;
    const args = [search, search, search, programmeId, programmeId, branchOptionId, branchOptionId, semesterId, semesterId, credits, credits, activeOnly ? 0 : 1];
    const [counts] = await pool.execute(`SELECT COUNT(*) AS total FROM curriculum_subjects c ${queryWhere}`, args);
    const [subjects] = await pool.execute(`
      SELECT c.id, c.subject_id AS subjectId, c.course_name AS courseName,
        c.course_code AS courseCode, c.credits, c.credits_raw AS creditsRaw,
        c.record_status AS recordStatus, c.category, c.semester_label AS semesterLabel,
        c.is_active AS isActive, c.programme_id AS programmeId,
        c.branch_option_id AS branchOptionId, c.semester_id AS semesterId,
        p.name AS programmeName, b.name AS branchName,
        sem.label AS semesterName, COUNT(DISTINCT ca.id) AS classAssignmentCount,
        COUNT(DISTINCT ta.id) AS teacherAssignmentCount
      FROM curriculum_subjects c
      LEFT JOIN academic_programmes p ON p.id = c.programme_id
      LEFT JOIN academic_options b ON b.id = c.branch_option_id
      LEFT JOIN academic_semesters sem ON sem.id = c.semester_id
      LEFT JOIN class_course_assignments ca ON ca.curriculum_subject_id = c.id
      LEFT JOIN teacher_course_assignments ta ON ta.curriculum_subject_id = c.id
      ${queryWhere}
      GROUP BY c.id
      ORDER BY c.course_name, c.id
      LIMIT ? OFFSET ?
    `, [...args, pageSize, offset]);
    res.json({ subjects, total: Number(counts[0].total), page, pageSize, totalPages: Math.max(1, Math.ceil(Number(counts[0].total) / pageSize)) });
  } catch (error) {
    next(error);
  }
});

router.get('/:curriculumSubjectId', async (req, res, next) => {
  const curriculumSubjectId = id(req.params.curriculumSubjectId);
  if (!curriculumSubjectId) return badRequest(res, 'Subject record not found.', 404);
  try {
    const [rows] = await pool.execute(`
      SELECT c.id, c.subject_id AS subjectId, c.course_name AS courseName,
        c.course_code AS courseCode, c.credits, c.credits_raw AS creditsRaw,
        c.category, c.record_status AS recordStatus, c.semester_id AS semesterId,
        c.semester_label AS semesterLabel, c.programme_id AS programmeId,
        c.branch_option_id AS branchOptionId, c.is_active AS isActive,
        p.name AS programmeName, b.name AS branchName, sem.label AS semesterName,
        c.source_url AS sourceUrl, c.notes
      FROM curriculum_subjects c
      LEFT JOIN academic_programmes p ON p.id = c.programme_id
      LEFT JOIN academic_options b ON b.id = c.branch_option_id
      LEFT JOIN academic_semesters sem ON sem.id = c.semester_id
      WHERE c.id = ? LIMIT 1
    `, [curriculumSubjectId]);
    if (!rows.length) return badRequest(res, 'Subject record not found.', 404);
    res.json({ subject: rows[0] });
  } catch (error) {
    next(error);
  }
});

async function validateManualFields(connection, input, existingId = null) {
  const courseName = normalizeName(input.courseName);
  const courseCode = normalizeName(input.courseCode, 60);
  const credits = Number(input.credits);
  const programmeId = input.programmeId ? id(input.programmeId) : null;
  const branchOptionId = input.branchOptionId ? id(input.branchOptionId) : null;
  const semesterId = input.semesterId ? id(input.semesterId) : null;
  const sectionId = input.sectionId ? id(input.sectionId) : null;
  const teacherUserId = input.teacherUserId ? id(input.teacherUserId) : null;
  if (!courseName || !courseCode || ![2, 3, 4, 5].includes(credits)) return { error: 'Course name, course code, and 2–5 credits are required.' };
  if (input.programmeId && !programmeId) return { error: 'Select a valid programme.' };
  if (input.branchOptionId && (!programmeId || !branchOptionId)) return { error: 'Select a programme before choosing a branch or specialisation.' };
  if (input.semesterId && !semesterId) return { error: 'Select a valid semester.' };
  if (input.sectionId && !sectionId) return { error: 'Select a valid class.' };
  if (input.teacherUserId && !teacherUserId) return { error: 'Select a valid teacher.' };
  if (programmeId) {
    const [rows] = await connection.execute('SELECT id FROM academic_programmes WHERE id = ? AND is_active = 1', [programmeId]);
    if (!rows.length) return { error: 'The selected programme is inactive or unavailable.' };
  }
  if (branchOptionId) {
    const [rows] = await connection.execute(`
      SELECT id FROM academic_options
      WHERE id = ? AND programme_id = ? AND is_active = 1 LIMIT 1
    `, [branchOptionId, programmeId]);
    if (!rows.length) return { error: 'The selected branch or specialisation does not belong to this programme.' };
  }
  if (semesterId) {
    const [rows] = await connection.execute('SELECT id FROM academic_semesters WHERE id = ? AND is_active = 1', [semesterId]);
    if (!rows.length) return { error: 'The selected semester is unavailable.' };
  }
  if (sectionId) {
    const [rows] = await connection.execute('SELECT id FROM academic_sections WHERE id = ? AND is_active = 1', [sectionId]);
    if (!rows.length) return { error: 'The selected class is unavailable.' };
  }
  if (teacherUserId) {
    const [rows] = await connection.execute(`
      SELECT u.id FROM users u JOIN teacher_profiles tp ON tp.user_id = u.id
      WHERE u.id = ? AND u.role = 'teacher' AND u.is_active = 1 LIMIT 1
    `, [teacherUserId]);
    if (!rows.length) return { error: 'The selected teacher is unavailable.' };
  }
  if (sectionId && programmeId) {
    const [rows] = await connection.execute(`
      SELECT id FROM academic_sections WHERE id = ? AND programme_id = ? AND is_active = 1
    `, [sectionId, programmeId]);
    if (!rows.length) return { error: 'The selected class is not part of this programme.' };
  }
  if (sectionId && teacherUserId == null && input.teacherUserId) return { error: 'The teacher assignment needs a valid class.' };
  const [duplicates] = await connection.execute(`
    SELECT id FROM curriculum_subjects
    WHERE is_active = 1 AND course_code = ?
      AND programme_id <=> ? AND branch_option_id <=> ? AND semester_id <=> ?
      AND (? IS NULL OR id <> ?)
    LIMIT 1
  `, [courseCode, programmeId, branchOptionId, semesterId, existingId, existingId]);
  if (duplicates.length) return { error: 'That course code already exists for the selected programme, branch, and semester.', status: 409 };
  return { courseName, courseCode, credits, programmeId, branchOptionId, semesterId, sectionId, teacherUserId };
}

router.post('/', async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const values = await validateManualFields(connection, req.body || {});
    if (values.error) {
      await connection.rollback();
      return badRequest(res, values.error, values.status || 400);
    }
    const [createdSubject] = await connection.execute(
      'INSERT INTO subjects (subject_code, subject_name, is_active) VALUES (?, ?, TRUE)',
      [values.courseCode, values.courseName],
    );
    const [createdRecord] = await connection.execute(`
      INSERT INTO curriculum_subjects (
        subject_id, programme_id, branch_option_id, semester_id,
        course_name, course_code, semester_label, credits, record_status, created_by_user_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?)
    `, [createdSubject.insertId, values.programmeId, values.branchOptionId, values.semesterId,
      values.courseName, values.courseCode, null, values.credits, req.user.id]);
    if (values.sectionId) {
      const curriculum = { programmeId: values.programmeId, branchOptionId: values.branchOptionId };
      if (!(await validateSectionScope(connection, curriculum, values.sectionId))) {
        await connection.rollback();
        return badRequest(res, 'The selected class does not match the subject programme or branch.', 400);
      }
      await connection.execute('INSERT INTO class_course_assignments (section_id, curriculum_subject_id, created_by_user_id) VALUES (?, ?, ?)', [values.sectionId, createdRecord.insertId, req.user.id]);
      if (values.teacherUserId) {
        await connection.execute('INSERT INTO teacher_course_assignments (teacher_user_id, section_id, curriculum_subject_id, created_by_user_id) VALUES (?, ?, ?, ?)', [values.teacherUserId, values.sectionId, createdRecord.insertId, req.user.id]);
      }
    } else if (values.teacherUserId) {
      await connection.rollback();
      return badRequest(res, 'Choose a class before assigning a teacher.', 400);
    }
    await connection.commit();
    res.status(201).json({ message: 'Subject saved.', id: createdRecord.insertId });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/:curriculumSubjectId', async (req, res, next) => {
  const curriculumSubjectId = id(req.params.curriculumSubjectId);
  if (!curriculumSubjectId) return badRequest(res, 'Subject record not found.', 404);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute('SELECT id, subject_id AS subjectId FROM curriculum_subjects WHERE id = ? LIMIT 1 FOR UPDATE', [curriculumSubjectId]);
    if (!existing.length) {
      await connection.rollback();
      return badRequest(res, 'Subject record not found.', 404);
    }
    const [oldValues] = await connection.execute(`
      SELECT course_name AS courseName, course_code AS courseCode, credits,
        programme_id AS programmeId, branch_option_id AS branchOptionId,
        semester_id AS semesterId
      FROM curriculum_subjects WHERE id = ? LIMIT 1
    `, [curriculumSubjectId]);
    const values = await validateManualFields(connection, { ...oldValues[0], ...req.body }, curriculumSubjectId);
    if (values.error) {
      await connection.rollback();
      return badRequest(res, values.error, values.status || 400);
    }
    await connection.execute(`
      UPDATE curriculum_subjects SET programme_id = ?, branch_option_id = ?, semester_id = ?,
        course_name = ?, course_code = ?, credits = ?, record_status = 'manual'
      WHERE id = ?
    `, [values.programmeId, values.branchOptionId, values.semesterId, values.courseName, values.courseCode, values.credits, curriculumSubjectId]);
    if (existing[0].subjectId) {
      await connection.execute('UPDATE subjects SET subject_name = ?, subject_code = ? WHERE id = ?', [values.courseName, values.courseCode, existing[0].subjectId]);
    }
    await connection.commit();
    res.json({ message: 'Subject updated.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.delete('/:curriculumSubjectId', async (req, res, next) => {
  const curriculumSubjectId = id(req.params.curriculumSubjectId);
  if (!curriculumSubjectId) return badRequest(res, 'Subject record not found.', 404);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [records] = await connection.execute('SELECT subject_id AS subjectId FROM curriculum_subjects WHERE id = ? FOR UPDATE', [curriculumSubjectId]);
    if (!records.length) {
      await connection.rollback();
      return badRequest(res, 'Subject record not found.', 404);
    }
    await connection.execute('UPDATE curriculum_subjects SET is_active = FALSE WHERE id = ?', [curriculumSubjectId]);
    if (records[0].subjectId) await connection.execute('UPDATE subjects SET is_active = FALSE WHERE id = ?', [records[0].subjectId]);
    await connection.commit();
    res.json({ message: 'Subject deactivated. Existing assignment records were preserved.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
