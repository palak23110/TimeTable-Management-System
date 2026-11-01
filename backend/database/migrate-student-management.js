const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

const programmes = [
  { code: 'BTECH', name: 'B.Tech', minYears: 4, maxYears: 4 },
  { code: 'BBA', name: 'BBA / BBA (Hons.)', minYears: 3, maxYears: 4 },
  { code: 'BCOM_HONS', name: 'B.Com (Hons.)', minYears: 3, maxYears: 4 },
  { code: 'BBA_MBA', name: 'Integrated BBA + MBA', minYears: 5, maxYears: 5 },
  { code: 'BA_LLB_HONS', name: 'B.A. LL.B. (Hons.)', minYears: 5, maxYears: 5 },
  { code: 'BBA_LLB_HONS', name: 'BBA LL.B. (Hons.)', minYears: 5, maxYears: 5 },
  { code: 'BA_LIBERAL', name: 'B.A. (Hons.) – Liberal Studies', minYears: 4, maxYears: 4 },
];

const btechBranches = [
  ['CSE', 'Computer Science and Engineering (CSE)'],
  ['ECOME', 'Electronics and Computer Engineering (EComE)'],
  ['ME', 'Mechanical Engineering (ME)'],
];
const btechSpecialisations = [
  ['DSAI', 'Data Science and Artificial Intelligence'],
  ['CYBER', 'Cyber Security'],
  ['IOT', 'Internet of Things'],
  ['VLSI', 'VLSI Design'],
  ['ROBOTICS', 'Robotics and Automation'],
  ['AUTO', 'Automobile Engineering'],
];
const bbaMajors = [
  ['MARKETING', 'Marketing'],
  ['FINANCE', 'Finance'],
  ['HR', 'Human Resources'],
  ['ENTREPRENEURSHIP', 'Entrepreneurship'],
  ['DIGITAL_MARKETING', 'Digital Marketing'],
  ['BUSINESS_ANALYTICS', 'Business Analytics'],
];
const liberalMajors = [
  ['ECONOMICS', 'Economics'],
  ['SOCIOLOGY', 'Sociology'],
  ['PSYCHOLOGY', 'Psychology'],
  ['LITERATURE', 'Literature'],
  ['HISTORY', 'History'],
];

function currentAcademicYear() {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'numeric',
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year').value);
  const month = Number(parts.find((part) => part.type === 'month').value);
  const startYear = month >= 7 ? year : year - 1;
  return {
    startYear,
    label: `${startYear}-${String(startYear + 1).slice(-2)}`,
    currentTerm: month >= 7 ? 'odd' : 'even',
  };
}

async function createTables() {
  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_programmes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(40) NOT NULL,
    name VARCHAR(180) NOT NULL,
    min_duration_years TINYINT UNSIGNED NOT NULL,
    max_duration_years TINYINT UNSIGNED NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_academic_programmes_code (code),
    UNIQUE KEY uq_academic_programmes_name (name)
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_options (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    programme_id BIGINT UNSIGNED NOT NULL,
    parent_option_id BIGINT UNSIGNED NULL,
    code VARCHAR(60) NOT NULL,
    name VARCHAR(180) NOT NULL,
    option_type ENUM('branch','major','specialisation') NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_academic_options_code (programme_id, code),
    KEY ix_academic_options_program_parent (programme_id, parent_option_id, is_active),
    CONSTRAINT fk_academic_options_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
    CONSTRAINT fk_academic_options_parent FOREIGN KEY (parent_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_years (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    label VARCHAR(24) NOT NULL,
    start_year SMALLINT UNSIGNED NOT NULL,
    end_year SMALLINT UNSIGNED NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_academic_years_label (label),
    UNIQUE KEY uq_academic_years_start (start_year)
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_terms (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    academic_year_id BIGINT UNSIGNED NOT NULL,
    term_key ENUM('odd','even') NOT NULL,
    starts_on DATE NOT NULL,
    ends_on DATE NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_academic_terms_year_key (academic_year_id, term_key),
    KEY ix_academic_terms_active (is_active),
    CONSTRAINT fk_academic_terms_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_semesters (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    semester_number TINYINT UNSIGNED NOT NULL,
    label VARCHAR(40) NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_academic_semesters_number (semester_number),
    UNIQUE KEY uq_academic_semesters_label (label),
    CONSTRAINT chk_academic_semesters_number CHECK (semester_number BETWEEN 1 AND 10)
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS academic_sections (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    programme_id BIGINT UNSIGNED NOT NULL,
    branch_option_id BIGINT UNSIGNED NULL,
    section_name VARCHAR(40) NOT NULL,
    option_group_id BIGINT UNSIGNED GENERATED ALWAYS AS (COALESCE(branch_option_id, 0)) STORED,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_academic_sections_group_name (programme_id, option_group_id, section_name),
    KEY ix_academic_sections_program_option (programme_id, branch_option_id, is_active),
    CONSTRAINT fk_academic_sections_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
    CONSTRAINT fk_academic_sections_option FOREIGN KEY (branch_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);

  await pool.execute(`CREATE TABLE IF NOT EXISTS student_profiles (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    student_id VARCHAR(32) NOT NULL,
    name VARCHAR(160) NOT NULL,
    email VARCHAR(254) NOT NULL,
    contact_number VARCHAR(32) NULL,
    programme_id BIGINT UNSIGNED NULL,
    branch_option_id BIGINT UNSIGNED NULL,
    specialisation_option_id BIGINT UNSIGNED NULL,
    enrolled_year SMALLINT UNSIGNED NULL,
    expected_graduation_year SMALLINT UNSIGNED NULL,
    current_semester_id BIGINT UNSIGNED NULL,
    section_id BIGINT UNSIGNED NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_student_profiles_user (user_id),
    UNIQUE KEY uq_student_profiles_student_id (student_id),
    UNIQUE KEY uq_student_profiles_email (email),
    KEY ix_student_profiles_academic (programme_id, branch_option_id, current_semester_id, section_id),
    CONSTRAINT fk_student_profiles_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_student_profiles_programme FOREIGN KEY (programme_id) REFERENCES academic_programmes(id) ON DELETE RESTRICT,
    CONSTRAINT fk_student_profiles_branch FOREIGN KEY (branch_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT,
    CONSTRAINT fk_student_profiles_specialisation FOREIGN KEY (specialisation_option_id) REFERENCES academic_options(id) ON DELETE RESTRICT,
    CONSTRAINT fk_student_profiles_semester FOREIGN KEY (current_semester_id) REFERENCES academic_semesters(id) ON DELETE RESTRICT,
    CONSTRAINT fk_student_profiles_section FOREIGN KEY (section_id) REFERENCES academic_sections(id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`);
}

async function insertOption(programmeId, parentId, code, name, type) {
  await pool.execute(`
    INSERT IGNORE INTO academic_options (programme_id, parent_option_id, code, name, option_type)
    VALUES (?, ?, ?, ?, ?)
  `, [programmeId, parentId, code, name, type]);
}

async function seedInitialConfiguration() {
  for (const programme of programmes) {
    await pool.execute(`
      INSERT IGNORE INTO academic_programmes (code, name, min_duration_years, max_duration_years)
      VALUES (?, ?, ?, ?)
    `, [programme.code, programme.name, programme.minYears, programme.maxYears]);
  }

  const [programmeRows] = await pool.execute('SELECT id, code FROM academic_programmes');
  const programmeIds = new Map(programmeRows.map((row) => [row.code, Number(row.id)]));

  for (const [code, name] of btechBranches) {
    await insertOption(programmeIds.get('BTECH'), null, `BTECH-${code}`, name, 'branch');
  }
  for (const [code, name] of bbaMajors) {
    await insertOption(programmeIds.get('BBA'), null, `BBA-${code}`, name, 'major');
  }
  for (const [code, name] of liberalMajors) {
    await insertOption(programmeIds.get('BA_LIBERAL'), null, `LIBERAL-${code}`, name, 'major');
  }

  const [branchRows] = await pool.execute(`
    SELECT id, code
    FROM academic_options
    WHERE programme_id = ? AND option_type = 'branch'
  `, [programmeIds.get('BTECH')]);
  for (const branch of branchRows) {
    const branchCode = branch.code.replace('BTECH-', '');
    for (const [specialisationCode, name] of btechSpecialisations) {
      await insertOption(
        programmeIds.get('BTECH'),
        branch.id,
        `${branchCode}-${specialisationCode}`,
        name,
        'specialisation',
      );
    }
  }

  for (let number = 1; number <= 10; number += 1) {
    await pool.execute(`
      INSERT IGNORE INTO academic_semesters (semester_number, label)
      VALUES (?, ?)
    `, [number, `Semester ${number}`]);
  }

  const year = currentAcademicYear();
  await pool.execute(`
    INSERT IGNORE INTO academic_years (label, start_year, end_year, is_active)
    SELECT ?, ?, ?, IF(NOT EXISTS (SELECT 1 FROM academic_years WHERE is_active = 1), TRUE, FALSE)
  `, [year.label, year.startYear, year.startYear + 1]);
  const [yearRows] = await pool.execute('SELECT id, is_active AS isActive FROM academic_years WHERE start_year = ? LIMIT 1', [year.startYear]);
  const yearId = yearRows[0].id;
  const oddStart = `${year.startYear}-07-01`;
  const oddEnd = `${year.startYear}-12-31`;
  const evenStart = `${year.startYear + 1}-01-01`;
  const evenEnd = `${year.startYear + 1}-06-30`;
  for (const term of [
    { key: 'odd', starts: oddStart, ends: oddEnd },
    { key: 'even', starts: evenStart, ends: evenEnd },
  ]) {
    await pool.execute(`
      INSERT IGNORE INTO academic_terms (academic_year_id, term_key, starts_on, ends_on, is_active)
      VALUES (?, ?, ?, ?, ?)
    `, [yearId, term.key, term.starts, term.ends, yearRows[0].isActive && term.key === year.currentTerm]);
  }
  const [activeTerms] = await pool.execute('SELECT id FROM academic_terms WHERE is_active = 1 LIMIT 1');
  if (!activeTerms.length) {
    const [term] = await pool.execute(`
      SELECT id FROM academic_terms WHERE academic_year_id = ? AND term_key = ? LIMIT 1
    `, [yearId, year.currentTerm]);
    if (yearRows[0].isActive && term.length) {
      await pool.execute('UPDATE academic_terms SET is_active = TRUE WHERE id = ?', [term[0].id]);
    }
  }

  const [cse] = await pool.execute(`
    SELECT id FROM academic_options WHERE programme_id = ? AND code = 'BTECH-CSE' LIMIT 1
  `, [programmeIds.get('BTECH')]);
  for (let number = 1; number <= 8 && cse[0]; number += 1) {
    await pool.execute(`
      INSERT IGNORE INTO academic_sections (programme_id, branch_option_id, section_name)
      VALUES (?, ?, ?)
    `, [programmeIds.get('BTECH'), cse[0].id, `CSE${number}`]);
  }
  for (let number = 1; number <= 5; number += 1) {
    await pool.execute(`
      INSERT IGNORE INTO academic_sections (programme_id, branch_option_id, section_name)
      VALUES (?, NULL, ?)
    `, [programmeIds.get('BBA'), `BBA${number}`]);
  }

  await pool.execute(`
    INSERT IGNORE INTO student_profiles (user_id, student_id, name, email, contact_number)
    SELECT u.id, CONCAT('STU-', LPAD(u.id, 6, '0')), u.name, u.email, NULL
    FROM users u
    WHERE u.role = 'student'
  `);
}

async function migrate() {
  await createTables();
  await seedInitialConfiguration();
  console.log('Student-management tables and initial academic configuration are ready.');
}

migrate()
  .catch((error) => {
    console.error(`Student-management migration failed (${error.code || 'database error'}).`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
