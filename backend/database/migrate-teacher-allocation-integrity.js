'use strict';

const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const pool = require('./pool');

async function columns(table) {
  const [rows] = await pool.execute(`SELECT column_name AS name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
  return new Set(rows.map((row) => row.name));
}

async function indexes(table) {
  const [rows] = await pool.execute(`SELECT index_name AS name FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ?`, [table]);
  return new Set(rows.map((row) => row.name));
}

async function constraints(table) {
  const [rows] = await pool.execute(`SELECT constraint_name AS name FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = ?` , [table]);
  return new Set(rows.map((row) => row.name));
}

async function migrate() {
  const [tables] = await pool.execute(`SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('teacher_course_assignments','academic_years','academic_semesters','teacher_subjects','curriculum_subjects')`);
  const present = new Set(tables.map((row) => row.table_name));
  for (const required of ['teacher_course_assignments', 'academic_years', 'academic_semesters', 'teacher_subjects', 'curriculum_subjects']) {
    if (!present.has(required)) throw new Error(`Required table ${required} is missing. Run the existing teacher and subject migrations first.`);
  }

  let cols = await columns('teacher_course_assignments');
  if (!cols.has('academic_year_id')) await pool.execute('ALTER TABLE teacher_course_assignments ADD COLUMN academic_year_id BIGINT UNSIGNED NULL AFTER curriculum_subject_id');
  if (!cols.has('semester_id')) await pool.execute('ALTER TABLE teacher_course_assignments ADD COLUMN semester_id BIGINT UNSIGNED NULL AFTER academic_year_id');
  if (!cols.has('subject_id')) await pool.execute('ALTER TABLE teacher_course_assignments ADD COLUMN subject_id BIGINT UNSIGNED NULL AFTER semester_id');

  await pool.execute(`UPDATE teacher_course_assignments a JOIN curriculum_subjects c ON c.id = a.curriculum_subject_id
    SET a.semester_id = c.semester_id, a.subject_id = c.subject_id
    WHERE a.semester_id IS NULL OR a.subject_id IS NULL`);

  const [unmapped] = await pool.execute(`SELECT COUNT(*) AS total FROM teacher_course_assignments a
    WHERE a.subject_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM teacher_subjects ts
      WHERE ts.teacher_user_id = a.teacher_user_id AND ts.subject_id = a.subject_id)`);
  if (Number(unmapped[0].total)) throw new Error(`${unmapped[0].total} existing allocation(s) lack a matching teacher-subject mapping. Resolve these records before rerunning this migration; no rows were deleted.`);

  let idx = await indexes('teacher_course_assignments');
  if (idx.has('uq_teacher_course_assignment')) await pool.execute('ALTER TABLE teacher_course_assignments DROP INDEX uq_teacher_course_assignment');
  idx = await indexes('teacher_course_assignments');
  if (!idx.has('uq_teacher_section_year_semester')) await pool.execute('ALTER TABLE teacher_course_assignments ADD UNIQUE KEY uq_teacher_section_year_semester (teacher_user_id, section_id, academic_year_id, semester_id)');
  if (!idx.has('uq_teacher_course_year_semester')) await pool.execute('ALTER TABLE teacher_course_assignments ADD UNIQUE KEY uq_teacher_course_year_semester (teacher_user_id, section_id, curriculum_subject_id, academic_year_id, semester_id)');
  if (!idx.has('ix_teacher_course_subject')) await pool.execute('ALTER TABLE teacher_course_assignments ADD KEY ix_teacher_course_subject (teacher_user_id, subject_id)');
  if (!idx.has('ix_teacher_course_curriculum_subject')) await pool.execute('ALTER TABLE teacher_course_assignments ADD KEY ix_teacher_course_curriculum_subject (curriculum_subject_id, subject_id)');

  let courseIdx = await indexes('curriculum_subjects');
  if (!courseIdx.has('uq_curriculum_id_subject')) await pool.execute('ALTER TABLE curriculum_subjects ADD UNIQUE KEY uq_curriculum_id_subject (id, subject_id)');
  let cons = await constraints('teacher_course_assignments');
  if (!cons.has('fk_teacher_course_academic_year')) await pool.execute('ALTER TABLE teacher_course_assignments ADD CONSTRAINT fk_teacher_course_academic_year FOREIGN KEY (academic_year_id) REFERENCES academic_years(id) ON DELETE RESTRICT');
  if (!cons.has('fk_teacher_course_semester')) await pool.execute('ALTER TABLE teacher_course_assignments ADD CONSTRAINT fk_teacher_course_semester FOREIGN KEY (semester_id) REFERENCES academic_semesters(id) ON DELETE RESTRICT');
  if (!cons.has('fk_teacher_course_mapping')) await pool.execute('ALTER TABLE teacher_course_assignments ADD CONSTRAINT fk_teacher_course_mapping FOREIGN KEY (teacher_user_id, subject_id) REFERENCES teacher_subjects(teacher_user_id, subject_id) ON DELETE RESTRICT');
  if (!cons.has('fk_teacher_course_curriculum_subject')) await pool.execute('ALTER TABLE teacher_course_assignments ADD CONSTRAINT fk_teacher_course_curriculum_subject FOREIGN KEY (curriculum_subject_id, subject_id) REFERENCES curriculum_subjects(id, subject_id) ON DELETE RESTRICT');

  const [legacy] = await pool.execute('SELECT COUNT(*) AS total FROM teacher_course_assignments WHERE academic_year_id IS NULL');
  console.log(`Teacher allocation integrity migration complete. ${legacy[0].total} legacy allocation(s) remain with an unassigned academic year for admin review.`);
}

migrate().catch((error) => {
  console.error(`Teacher allocation integrity migration failed: ${error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
