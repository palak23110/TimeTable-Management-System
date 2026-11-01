const express = require('express');
const pool = require('../database/pool');

const router = express.Router();

function asId(value) {
  return /^\d+$/.test(String(value ?? '')) && Number(value) > 0 ? Number(value) : null;
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function slug(value) {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 50);
}

function normalizedName(value, maximum = 180) {
  return typeof value === 'string' && value.trim() && value.trim().length <= maximum
    ? value.trim()
    : null;
}

function validDuration(minimum, maximum) {
  return Number.isInteger(Number(minimum))
    && Number.isInteger(Number(maximum))
    && Number(minimum) >= 1
    && Number(maximum) <= 10
    && Number(minimum) <= Number(maximum);
}

function badRequest(res, message, status = 400) {
  return res.status(status).json({ error: message });
}

router.use((req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) {
    return badRequest(res, 'Send academic structure changes as JSON.', 415);
  }
  next();
});

router.get('/', async (req, res, next) => {
  try {
    const [programmes] = await pool.execute(`
      SELECT id, code, name, min_duration_years AS minDurationYears,
        max_duration_years AS maxDurationYears, is_active AS isActive
      FROM academic_programmes
      ORDER BY name
    `);
    const [options] = await pool.execute(`
      SELECT id, programme_id AS programmeId, parent_option_id AS parentOptionId,
        code, name, option_type AS type, is_active AS isActive
      FROM academic_options
      ORDER BY name
    `);
    const [years] = await pool.execute(`
      SELECT id, label, start_year AS startYear, end_year AS endYear,
        is_active AS isActive
      FROM academic_years
      ORDER BY start_year DESC
    `);
    const [terms] = await pool.execute(`
      SELECT t.id, t.academic_year_id AS academicYearId,
        y.label AS academicYearLabel, t.term_key AS termKey,
        t.starts_on AS startsOn, t.ends_on AS endsOn,
        t.is_active AS isActive
      FROM academic_terms t
      JOIN academic_years y ON y.id = t.academic_year_id
      ORDER BY y.start_year DESC, t.term_key
    `);
    const [semesters] = await pool.execute(`
      SELECT id, semester_number AS semesterNumber, label,
        is_active AS isActive
      FROM academic_semesters
      ORDER BY semester_number
    `);
    const [sections] = await pool.execute(`
      SELECT s.id, s.programme_id AS programmeId,
        s.branch_option_id AS branchOptionId, s.section_name AS name,
        s.is_active AS isActive, p.name AS programmeName,
        o.name AS branchName
      FROM academic_sections s
      JOIN academic_programmes p ON p.id = s.programme_id
      LEFT JOIN academic_options o ON o.id = s.branch_option_id
      ORDER BY p.name, o.name, s.section_name
    `);
    const [activeCalendar] = await pool.execute(`
      SELECT y.id AS academicYearId, y.label AS academicYearLabel,
        y.start_year AS startYear, t.id AS termId, t.term_key AS termKey,
        t.starts_on AS startsOn, t.ends_on AS endsOn
      FROM academic_years y
      JOIN academic_terms t ON t.academic_year_id = y.id
      WHERE y.is_active = 1 AND t.is_active = 1
      LIMIT 1
    `);
    res.json({
      programmes,
      options,
      years,
      terms,
      semesters,
      sections,
      activeCalendar: activeCalendar[0] || null,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/programmes', async (req, res, next) => {
  const name = normalizedName(req.body?.name);
  const code = typeof req.body?.code === 'string' ? slug(req.body.code) : '';
  const minYears = Number(req.body?.minDurationYears);
  const maxYears = Number(req.body?.maxDurationYears);
  if (!name || !code || !validDuration(minYears, maxYears)) {
    return badRequest(res, 'Enter a unique programme code and name, and a valid duration range.');
  }
  try {
    const [result] = await pool.execute(`
      INSERT INTO academic_programmes (code, name, min_duration_years, max_duration_years)
      VALUES (?, ?, ?, ?)
    `, [code, name, minYears, maxYears]);
    res.status(201).json({ id: result.insertId, message: 'Programme added.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That programme code or name already exists.', 409);
    next(error);
  }
});

router.patch('/programmes/:programmeId', async (req, res, next) => {
  const programmeId = asId(req.params.programmeId);
  if (!programmeId) return badRequest(res, 'Programme not found.', 404);
  const changes = [];
  const values = [];
  if (Object.hasOwn(req.body || {}, 'name')) {
    const name = normalizedName(req.body.name);
    if (!name) return badRequest(res, 'Enter a programme name of up to 180 characters.');
    changes.push('name = ?');
    values.push(name);
  }
  if (Object.hasOwn(req.body || {}, 'minDurationYears') || Object.hasOwn(req.body || {}, 'maxDurationYears')) {
    const [current] = await pool.execute(`
      SELECT min_duration_years AS minYears, max_duration_years AS maxYears
      FROM academic_programmes WHERE id = ? LIMIT 1
    `, [programmeId]);
    if (!current.length) return badRequest(res, 'Programme not found.', 404);
    const minimum = req.body.minDurationYears ?? current[0].minYears;
    const maximum = req.body.maxDurationYears ?? current[0].maxYears;
    if (!validDuration(minimum, maximum)) return badRequest(res, 'Programme duration must be between 1 and 10 years.');
    changes.push('min_duration_years = ?', 'max_duration_years = ?');
    values.push(minimum, maximum);
  }
  if (Object.hasOwn(req.body || {}, 'isActive')) {
    changes.push('is_active = ?');
    values.push(booleanValue(req.body.isActive));
  }
  if (!changes.length) return badRequest(res, 'Provide at least one programme field to update.');
  try {
    const [result] = await pool.execute(`UPDATE academic_programmes SET ${changes.join(', ')} WHERE id = ?`, [...values, programmeId]);
    if (!result.affectedRows) return badRequest(res, 'Programme not found.', 404);
    res.json({ message: 'Programme updated.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That programme name already exists.', 409);
    next(error);
  }
});

router.post('/options', async (req, res, next) => {
  const programmeId = asId(req.body?.programmeId);
  const parentOptionId = req.body?.parentOptionId === '' || req.body?.parentOptionId == null
    ? null
    : asId(req.body.parentOptionId);
  const name = normalizedName(req.body?.name);
  const type = req.body?.type;
  const code = typeof req.body?.code === 'string' && req.body.code.trim()
    ? slug(req.body.code)
    : slug(name || '');
  if (!programmeId || !name || !code || !['branch', 'major', 'specialisation'].includes(type)) {
    return badRequest(res, 'Select a programme and provide a valid option type and name.');
  }
  if ((type === 'specialisation') !== Boolean(parentOptionId)) {
    return badRequest(res, 'Specialisations need a parent branch; branches and majors are top-level.');
  }
  try {
    const [programmes] = await pool.execute('SELECT id FROM academic_programmes WHERE id = ? AND is_active = 1 LIMIT 1', [programmeId]);
    if (!programmes.length) return badRequest(res, 'The selected programme is unavailable.');
    if (parentOptionId) {
      const [parents] = await pool.execute(`
        SELECT id FROM academic_options
        WHERE id = ? AND programme_id = ? AND option_type = 'branch' AND is_active = 1
        LIMIT 1
      `, [parentOptionId, programmeId]);
      if (!parents.length) return badRequest(res, 'Select an active branch from the same programme.');
    }
    const [duplicates] = await pool.execute(`
      SELECT id FROM academic_options
      WHERE programme_id = ? AND parent_option_id <=> ?
        AND LOWER(name) = LOWER(?)
      LIMIT 1
    `, [programmeId, parentOptionId, name]);
    if (duplicates.length) return badRequest(res, 'That option already exists in this programme grouping.', 409);
    const [result] = await pool.execute(`
      INSERT INTO academic_options (programme_id, parent_option_id, code, name, option_type)
      VALUES (?, ?, ?, ?, ?)
    `, [programmeId, parentOptionId, code, name, type]);
    res.status(201).json({ id: result.insertId, message: 'Academic option added.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That option code already exists for this programme.', 409);
    next(error);
  }
});

router.patch('/options/:optionId', async (req, res, next) => {
  const optionId = asId(req.params.optionId);
  if (!optionId) return badRequest(res, 'Academic option not found.', 404);
  const changes = [];
  const values = [];
  if (Object.hasOwn(req.body || {}, 'name')) {
    const name = normalizedName(req.body.name);
    if (!name) return badRequest(res, 'Enter an option name of up to 180 characters.');
    changes.push('name = ?');
    values.push(name);
  }
  if (Object.hasOwn(req.body || {}, 'isActive')) {
    changes.push('is_active = ?');
    values.push(booleanValue(req.body.isActive));
  }
  if (!changes.length) return badRequest(res, 'Provide an option name or active state.');
  try {
    const [result] = await pool.execute(`UPDATE academic_options SET ${changes.join(', ')} WHERE id = ?`, [...values, optionId]);
    if (!result.affectedRows) return badRequest(res, 'Academic option not found.', 404);
    res.json({ message: 'Academic option updated.' });
  } catch (error) {
    next(error);
  }
});

router.post('/years', async (req, res, next) => {
  const startYear = Number(req.body?.startYear);
  if (!Number.isInteger(startYear) || startYear < 2000 || startYear > 2200) {
    return badRequest(res, 'Enter a valid academic year start (2000–2200).');
  }
  const endYear = startYear + 1;
  const label = `${startYear}-${String(endYear).slice(-2)}`;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [created] = await connection.execute(`
      INSERT INTO academic_years (label, start_year, end_year, is_active)
      VALUES (?, ?, ?, FALSE)
    `, [label, startYear, endYear]);
    const yearId = created.insertId;
    await connection.execute(`
      INSERT INTO academic_terms (academic_year_id, term_key, starts_on, ends_on, is_active)
      VALUES (?, 'odd', ?, ?, FALSE), (?, 'even', ?, ?, FALSE)
    `, [yearId, `${startYear}-07-01`, `${startYear}-12-31`, yearId, `${endYear}-01-01`, `${endYear}-06-30`]);
    if (booleanValue(req.body?.isActive)) {
      await activateYear(connection, yearId);
    }
    await connection.commit();
    res.status(201).json({ id: yearId, label, message: 'Academic year added with odd and even terms.' });
  } catch (error) {
    await connection.rollback();
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That academic year already exists.', 409);
    next(error);
  } finally {
    connection.release();
  }
});

async function activateYear(connection, yearId) {
  const [years] = await connection.execute('SELECT id, start_year AS startYear FROM academic_years WHERE id = ? LIMIT 1 FOR UPDATE', [yearId]);
  if (!years.length) return false;
  await connection.execute('UPDATE academic_years SET is_active = FALSE WHERE is_active = TRUE');
  await connection.execute('UPDATE academic_terms SET is_active = FALSE WHERE is_active = TRUE');
  await connection.execute('UPDATE academic_years SET is_active = TRUE WHERE id = ?', [yearId]);
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', month: 'numeric' }).formatToParts(new Date());
  const month = Number(parts.find((part) => part.type === 'month').value);
  const termKey = month >= 7 ? 'odd' : 'even';
  const [term] = await connection.execute(`
    SELECT id FROM academic_terms WHERE academic_year_id = ? AND term_key = ? LIMIT 1
  `, [yearId, termKey]);
  if (term.length) await connection.execute('UPDATE academic_terms SET is_active = TRUE WHERE id = ?', [term[0].id]);
  return true;
}

router.patch('/years/:yearId', async (req, res, next) => {
  const yearId = asId(req.params.yearId);
  if (!yearId || !Object.hasOwn(req.body || {}, 'isActive')) {
    return badRequest(res, 'Choose whether the academic year is active.');
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (booleanValue(req.body.isActive)) {
      const found = await activateYear(connection, yearId);
      if (!found) {
        await connection.rollback();
        return badRequest(res, 'Academic year not found.', 404);
      }
    } else {
      const [result] = await connection.execute('UPDATE academic_years SET is_active = FALSE WHERE id = ?', [yearId]);
      if (!result.affectedRows) {
        await connection.rollback();
        return badRequest(res, 'Academic year not found.', 404);
      }
      await connection.execute('UPDATE academic_terms SET is_active = FALSE WHERE academic_year_id = ?', [yearId]);
    }
    await connection.commit();
    await refreshCurrentSemesters();
    res.json({ message: 'Academic year configuration updated.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.patch('/terms/:termId', async (req, res, next) => {
  const termId = asId(req.params.termId);
  if (!termId) {
    return badRequest(res, 'Academic term not found.', 404);
  }
  const hasActiveChange = Object.hasOwn(req.body || {}, 'isActive');
  const hasStartChange = Object.hasOwn(req.body || {}, 'startsOn');
  const hasEndChange = Object.hasOwn(req.body || {}, 'endsOn');
  if (!hasActiveChange && !hasStartChange && !hasEndChange) {
    return badRequest(res, 'Provide a term date or active state.');
  }
  const isIsoDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (hasStartChange && !isIsoDate(req.body.startsOn)) return badRequest(res, 'Enter a valid term start date.');
  if (hasEndChange && !isIsoDate(req.body.endsOn)) return badRequest(res, 'Enter a valid term end date.');
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [terms] = await connection.execute(`
      SELECT t.id, t.starts_on AS startsOn, t.ends_on AS endsOn,
        y.is_active AS yearIsActive
      FROM academic_terms t
      JOIN academic_years y ON y.id = t.academic_year_id
      WHERE t.id = ? FOR UPDATE
    `, [termId]);
    if (!terms.length) {
      await connection.rollback();
      return badRequest(res, 'Academic term not found.', 404);
    }
    if (hasActiveChange && booleanValue(req.body.isActive) && !Number(terms[0].yearIsActive)) {
      await connection.rollback();
      return badRequest(res, 'Activate the academic year before activating one of its terms.');
    }
    const startsOn = hasStartChange ? req.body.startsOn : String(terms[0].startsOn).slice(0, 10);
    const endsOn = hasEndChange ? req.body.endsOn : String(terms[0].endsOn).slice(0, 10);
    if (startsOn >= endsOn) {
      await connection.rollback();
      return badRequest(res, 'The term end date must be after its start date.');
    }
    if (hasActiveChange && booleanValue(req.body.isActive)) {
      await connection.execute('UPDATE academic_terms SET is_active = FALSE WHERE is_active = TRUE');
    }
    const changes = ['starts_on = ?', 'ends_on = ?'];
    const values = [startsOn, endsOn];
    if (hasActiveChange) {
      changes.push('is_active = ?');
      values.push(booleanValue(req.body.isActive));
    }
    await connection.execute(`UPDATE academic_terms SET ${changes.join(', ')} WHERE id = ?`, [...values, termId]);
    await connection.commit();
    await refreshCurrentSemesters();
    res.json({ message: 'Academic term configuration updated.' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/semesters', async (req, res, next) => {
  const number = Number(req.body?.semesterNumber);
  const label = normalizedName(req.body?.label, 40) || (Number.isInteger(number) ? `Semester ${number}` : null);
  if (!Number.isInteger(number) || number < 1 || number > 10 || !label) {
    return badRequest(res, 'Semester number must be between 1 and 10.');
  }
  try {
    const [result] = await pool.execute(`
      INSERT INTO academic_semesters (semester_number, label)
      VALUES (?, ?)
    `, [number, label]);
    res.status(201).json({ id: result.insertId, message: 'Semester added.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That semester number or label already exists.', 409);
    next(error);
  }
});

router.patch('/semesters/:semesterId', async (req, res, next) => {
  const semesterId = asId(req.params.semesterId);
  if (!semesterId) return badRequest(res, 'Semester not found.', 404);
  const changes = [];
  const values = [];
  if (Object.hasOwn(req.body || {}, 'label')) {
    const label = normalizedName(req.body.label, 40);
    if (!label) return badRequest(res, 'Enter a semester label of up to 40 characters.');
    changes.push('label = ?');
    values.push(label);
  }
  if (Object.hasOwn(req.body || {}, 'isActive')) {
    changes.push('is_active = ?');
    values.push(booleanValue(req.body.isActive));
  }
  if (!changes.length) return badRequest(res, 'Provide a semester label or active state.');
  try {
    const [result] = await pool.execute(`UPDATE academic_semesters SET ${changes.join(', ')} WHERE id = ?`, [...values, semesterId]);
    if (!result.affectedRows) return badRequest(res, 'Semester not found.', 404);
    res.json({ message: 'Semester updated.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That semester label already exists.', 409);
    next(error);
  }
});

router.post('/sections', async (req, res, next) => {
  const programmeId = asId(req.body?.programmeId);
  const branchOptionId = req.body?.branchOptionId === '' || req.body?.branchOptionId == null
    ? null
    : asId(req.body.branchOptionId);
  const name = normalizedName(req.body?.name, 40);
  if (!programmeId || !name || (req.body?.branchOptionId && !branchOptionId)) {
    return badRequest(res, 'Select a programme, optional branch/major, and provide a section name.');
  }
  try {
    const [programmes] = await pool.execute('SELECT id FROM academic_programmes WHERE id = ? AND is_active = 1 LIMIT 1', [programmeId]);
    if (!programmes.length) return badRequest(res, 'The selected programme is unavailable.');
    if (branchOptionId) {
      const [options] = await pool.execute(`
        SELECT id FROM academic_options
        WHERE id = ? AND programme_id = ? AND parent_option_id IS NULL
          AND option_type IN ('branch','major') AND is_active = 1
        LIMIT 1
      `, [branchOptionId, programmeId]);
      if (!options.length) return badRequest(res, 'Select an active branch or major in the selected programme.');
    }
    const [duplicates] = await pool.execute(`
      SELECT id FROM academic_sections
      WHERE programme_id = ? AND branch_option_id <=> ?
        AND LOWER(section_name) = LOWER(?)
      LIMIT 1
    `, [programmeId, branchOptionId, name]);
    if (duplicates.length) return badRequest(res, 'That section already exists for this programme grouping.', 409);
    const [result] = await pool.execute(`
      INSERT INTO academic_sections (programme_id, branch_option_id, section_name)
      VALUES (?, ?, ?)
    `, [programmeId, branchOptionId, name]);
    res.status(201).json({ id: result.insertId, message: 'Section added.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That section already exists for this programme grouping.', 409);
    next(error);
  }
});

router.patch('/sections/:sectionId', async (req, res, next) => {
  const sectionId = asId(req.params.sectionId);
  if (!sectionId) return badRequest(res, 'Section not found.', 404);
  const changes = [];
  const values = [];
  if (Object.hasOwn(req.body || {}, 'name')) {
    const name = normalizedName(req.body.name, 40);
    if (!name) return badRequest(res, 'Enter a section name of up to 40 characters.');
    changes.push('section_name = ?');
    values.push(name);
  }
  if (Object.hasOwn(req.body || {}, 'isActive')) {
    changes.push('is_active = ?');
    values.push(booleanValue(req.body.isActive));
  }
  if (!changes.length) return badRequest(res, 'Provide a section name or active state.');
  try {
    const [result] = await pool.execute(`UPDATE academic_sections SET ${changes.join(', ')} WHERE id = ?`, [...values, sectionId]);
    if (!result.affectedRows) return badRequest(res, 'Section not found.', 404);
    res.json({ message: 'Section updated.' });
  } catch (error) {
    if (error.code === 'ER_DUP_ENTRY') return badRequest(res, 'That section already exists for this programme grouping.', 409);
    next(error);
  }
});

async function refreshCurrentSemesters() {
  const [active] = await pool.execute(`
    SELECT y.start_year AS startYear, t.term_key AS termKey
    FROM academic_years y
    JOIN academic_terms t ON t.academic_year_id = y.id
    WHERE y.is_active = 1 AND t.is_active = 1
    LIMIT 1
  `);
  if (!active.length) return;
  const termOffset = active[0].termKey === 'odd' ? 1 : 2;
  const [students] = await pool.execute(`
    SELECT sp.id, sp.enrolled_year AS enrolledYear,
      sp.expected_graduation_year AS graduationYear
    FROM student_profiles sp
    WHERE sp.enrolled_year IS NOT NULL
      AND sp.expected_graduation_year IS NOT NULL
  `);
  for (const student of students) {
    const semesterNumber = (Number(active[0].startYear) - Number(student.enrolledYear)) * 2 + termOffset;
    const maxNumber = (Number(student.graduationYear) - Number(student.enrolledYear)) * 2;
    let semesterId = null;
    if (semesterNumber >= 1 && semesterNumber <= maxNumber && semesterNumber <= 10) {
      const [semester] = await pool.execute(`
        SELECT id FROM academic_semesters
        WHERE semester_number = ? AND is_active = 1 LIMIT 1
      `, [semesterNumber]);
      semesterId = semester[0]?.id ?? null;
    }
    await pool.execute('UPDATE student_profiles SET current_semester_id = ? WHERE id = ?', [semesterId, student.id]);
  }
}

module.exports = router;
