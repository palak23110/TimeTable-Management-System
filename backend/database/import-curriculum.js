'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });
const { readWorkbook } = require('./xlsx-reader');

const FIELD_MAP = {
  'Programme': 'programme',
  'Branch / Major': 'branchOrMajor',
  'Course Code': 'courseCode',
  'Subject / Course': 'courseName',
  'Semester': 'semester',
  'Year': 'courseYear',
  'Credits': 'credits',
  'Category': 'category',
  'Data Status': 'recordStatus',
  'Source URL': 'sourceUrl',
  'Notes': 'notes',
};

const DATABASE_FIELD_MAP = {
  Programme: 'academic_programmes.id (matched by code)',
  'Branch / Major': 'academic_options.id (matched by programme and option code; programme-level for structural labels)',
  Semester: 'academic_semesters.id when numeric; original label retained in curriculum_subjects.semester_label',
  Year: 'curriculum_subjects.course_year',
  'Course Code': 'curriculum_subjects.course_code and subjects.subject_code for assignable courses',
  'Subject / Course': 'curriculum_subjects.course_name; subjects.subject_name only for assignable courses',
  Credits: 'curriculum_subjects.credits; original value retained in curriculum_subjects.credits_raw',
  Category: 'curriculum_subjects.category',
  'Data Status': 'curriculum_subjects.source_data_status (normalized value also in record_status)',
  'Source URL': 'curriculum_subjects.source_url',
  Notes: 'curriculum_subjects.notes',
};

const PROGRAMME_MAP = new Map([
  ['b.tech', { code: 'BTECH', name: 'B.Tech' }],
  ['bba / bba (hons.)', { code: 'BBA', name: 'BBA / BBA (Hons.)' }],
  ['b.com (hons.)', { code: 'BCOM_HONS', name: 'B.Com (Hons.)' }],
  ['integrated bba + mba', { code: 'BBA_MBA', name: 'Integrated BBA + MBA' }],
  ['b.a. ll.b. (hons.)', { code: 'BA_LLB_HONS', name: 'B.A. LL.B. (Hons.)' }],
  ['bba ll.b. (hons.)', { code: 'BBA_LLB_HONS', name: 'BBA LL.B. (Hons.)' }],
]);

const BTECH_BRANCHES = new Map([
  ['computer science and engineering (cse)', { code: 'BTECH-CSE', name: 'Computer Science and Engineering (CSE)' }],
  ['electronics and computer engineering (ecome)', { code: 'BTECH-ECOME', name: 'Electronics and Computer Engineering (EComE)' }],
  ['mechanical engineering', { code: 'BTECH-ME', name: 'Mechanical Engineering (ME)' }],
]);

const LIBERAL_MAJORS = new Map([
  ['economics', { code: 'LIBERAL-ECONOMICS', name: 'Economics' }],
  ['history', { code: 'LIBERAL-HISTORY', name: 'History' }],
  ['literature', { code: 'LIBERAL-LITERATURE', name: 'Literature' }],
  ['psychology', { code: 'LIBERAL-PSYCHOLOGY', name: 'Psychology' }],
  ['sociology', { code: 'LIBERAL-SOCIOLOGY', name: 'Sociology' }],
]);

function clean(value) {
  return value == null ? '' : String(value).trim();
}

function normalize(value) {
  return clean(value).toLocaleLowerCase('en').replace(/\s+/g, ' ');
}

function asRecord(row, headers) {
  const values = Object.fromEntries(headers.map((header, index) => [header, row.cells[index] ?? '']));
  return Object.fromEntries(Object.keys(FIELD_MAP).map((header) => [FIELD_MAP[header], clean(values[header])]));
}

function mapProgramme(value) {
  const normalized = normalize(value);
  if (PROGRAMME_MAP.has(normalized)) return { ...PROGRAMME_MAP.get(normalized), match: 'exact' };
  const liberalMatch = normalized.match(/^b\.a\. \(hons\.\) (economics|history|literature|psychology|sociology)$/);
  if (liberalMatch) return { code: 'BA_LIBERAL', name: 'B.A. (Hons.) – Liberal Studies', match: 'programme-derived-major', major: LIBERAL_MAJORS.get(liberalMatch[1]) };
  return null;
}

function mapBranch(programme, value, originalProgramme) {
  const normalized = normalize(value);
  if (programme?.code === 'BTECH') return BTECH_BRANCHES.get(normalized) || null;
  if (programme?.code === 'BA_LIBERAL' && normalized === 'major programme') {
    return mapProgramme(originalProgramme)?.major || null;
  }
  // These workbook values describe programme structure, not a specific branch.
  if ([
    'general / major structure',
    'general / specialisation elective structure',
    'integrated law programme',
    'integrated programme',
  ].includes(normalized)) return { code: null, name: null, match: 'programme-level' };
  return null;
}

function parseCredits(value) {
  if (!clean(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 99 ? number : NaN;
}

function parseSemester(value) {
  const text = clean(value);
  if (/^\d+$/.test(text)) {
    const number = Number(text);
    return number >= 1 && number <= 10 ? { number, label: text, status: 'numbered' } : { number: null, label: text, status: 'invalid-number' };
  }
  if (/^(st\s*[12]|summer after sem\s*[24])$/i.test(text)) return { number: null, label: text, status: 'published-special-period' };
  if (/^not published$/i.test(text)) return { number: null, label: text, status: 'not-published' };
  if (!text) return { number: null, label: null, status: 'missing' };
  if (/^programme total$/i.test(text)) return { number: null, label: text, status: 'programme-summary' };
  if (/^semesters?\s+\d/i.test(text)) return { number: null, label: text, status: 'range-or-summary' };
  return { number: null, label: text, status: 'unmapped-label' };
}

function classify(record, mappedProgramme, mappedBranch) {
  const status = normalize(record.recordStatus);
  const semester = parseSemester(record.semester);
  const credits = parseCredits(record.credits);
  const issues = [];
  if (!mappedProgramme) issues.push(`Unmapped programme: ${record.programme || '(blank)'}`);
  if (mappedProgramme && !mappedBranch) issues.push(`Unmapped or ambiguous branch/major: ${record.branchOrMajor || '(blank)'}`);
  if (!record.courseName) issues.push('Missing course name.');
  if (Number.isNaN(credits) && !/^audit$/i.test(record.credits)) issues.push(`Invalid credits value: ${record.credits}`);
  if (/^audit$/i.test(record.credits)) issues.push('Credits notation "Audit" is preserved as text; no numeric credit was inferred.');
  if (semester.status === 'invalid-number') issues.push(`Semester is outside 1–10: ${semester.label}`);
  if (semester.status === 'unmapped-label') issues.push(`Unmapped semester label: ${semester.label}`);

  let recordStatus = 'needs_review';
  let importAction = 'skip_invalid_unmapped';
  if (status.startsWith('area only')) {
    recordStatus = 'area_only';
    importAction = 'preserve_as_non_subject_area_record';
  } else if (status === 'choice required') {
    recordStatus = 'choice_required';
    importAction = 'preserve_elective_slot_not_assignable_subject';
  } else if (status === 'conditional') {
    recordStatus = 'conditional';
    importAction = 'preserve_conditional_record_not_assignable_by_default';
  } else if (status.startsWith('needs official syllabus')) {
    recordStatus = 'needs_review';
    importAction = 'preserve_note_not_subject';
  } else if (status.startsWith('basket/definition')) {
    recordStatus = 'needs_review';
    importAction = 'preserve_unresolved_basket_not_assignable';
  } else if (status.startsWith('partially published')) {
    recordStatus = 'partial';
    importAction = 'preserve_partial_structure_not_subject';
  } else if (status === 'published') {
    const isPlaceholder = /^(curriculum not available|detailed semester-wise|semester-wise .* curriculum|programme total)/i.test(record.courseName);
    const isSummary = semester.status === 'programme-summary' || normalize(record.category) === 'curriculum structure' || isPlaceholder;
    if (isSummary) {
      recordStatus = 'partial';
      importAction = 'preserve_summary_not_subject';
    } else if (mappedProgramme && mappedBranch && record.courseName && !issues.some((issue) => issue.startsWith('Invalid credits') || issue.startsWith('Semester is outside') || issue.startsWith('Unmapped semester'))) {
      recordStatus = 'published';
      importAction = 'import_named_published_course';
    } else {
      recordStatus = 'needs_review';
      importAction = 'skip_invalid_unmapped';
    }
  } else {
    issues.push(`Unrecognized data status: ${record.recordStatus || '(blank)'}`);
  }
  if (semester.status === 'not-published' || semester.status === 'missing' || semester.status === 'programme-summary' || semester.status === 'range-or-summary') {
    issues.push('No official single-semester placement is present.');
  }
  if (credits == null) issues.push('No officially supplied credit value is present.');
  return {
    recordStatus,
    sourceStatus: record.recordStatus,
    importAction,
    semesterMapping: semester,
    credits: Number.isNaN(credits) ? null : credits,
    creditsRaw: record.credits,
    issues,
  };
}

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function groupCounts(records, field) {
  const counts = new Map();
  for (const record of records) {
    const key = record[field] || '(blank)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

function inspectWorkbook(filePath) {
  const worksheets = readWorkbook(filePath);
  const main = worksheets.find((sheet) => sheet.name === 'Curriculum Master');
  if (!main?.rows.length) throw new Error("Required worksheet 'Curriculum Master' is missing or empty.");
  const headers = main.rows[0].cells.map(clean);
  const missingHeaders = Object.keys(FIELD_MAP).filter((header) => !headers.includes(header));
  const mapped = main.rows.slice(1).map((row) => {
    const record = asRecord(row, headers);
    const programme = mapProgramme(record.programme);
    const branch = mapBranch(programme, record.branchOrMajor, record.programme);
    const classification = classify(record, programme, branch);
    const identity = {
      worksheet: main.name,
      sourceRow: row.rowNumber,
      ...record,
      programmeCode: programme?.code || null,
      programmeName: programme?.name || null,
      branchCode: branch?.code || null,
      branchName: branch?.name || null,
      ...classification,
    };
    identity.mappingHash = stableHash({ sourceWorksheet: identity.worksheet, sourceRow: identity.sourceRow, record });
    return identity;
  });

  const duplicates = new Map();
  let duplicateCount = 0;
  for (const item of mapped) {
    const identity = stableHash({
      programme: normalize(item.programme), branch: normalize(item.branchOrMajor),
      semester: normalize(item.semester), code: normalize(item.courseCode),
      name: normalize(item.courseName), category: normalize(item.category),
      recordStatus: normalize(item.recordStatus), credits: item.credits,
    });
    if (duplicates.has(identity)) {
      item.duplicateOfRow = duplicates.get(identity);
      item.importAction = 'skip_duplicate_source_record';
      duplicateCount += 1;
    } else {
      duplicates.set(identity, item.sourceRow);
    }
  }
  const valid = mapped.filter((item) => item.importAction === 'import_named_published_course');
  const samples = selectSamples(mapped);
  const worksheetsSummary = worksheets.map((sheet) => ({
    worksheet: sheet.name,
    totalRowsIncludingHeader: sheet.rows.length,
    dataRows: Math.max(0, sheet.rows.length - 1),
    classification: sheet.name === 'Curriculum Master' ? 'curriculum source' : 'metadata/reference sheet; no subject rows imported',
  }));
  const countsByProgramme = groupCounts(mapped, 'programme');
  const countsByBranch = groupCounts(mapped, 'branchOrMajor');
  const countsBySemester = groupCounts(mapped, 'semester');
  const countsByStatus = groupCounts(mapped, 'recordStatus');
  const countsBySourceStatus = groupCounts(mapped, 'sourceStatus');
  const relationshipMappings = new Map();
  for (const item of mapped) {
    const key = `${item.programme}\u0000${item.branchOrMajor}`;
    if (!relationshipMappings.has(key)) {
      relationshipMappings.set(key, {
        workbookProgramme: item.programme,
        workbookBranchOrMajor: item.branchOrMajor,
        targetProgrammeCode: item.programmeCode,
        targetProgrammeName: item.programmeName,
        targetOptionCode: item.branchCode,
        targetBranchOrMajor: item.branchName,
        handling: item.branchCode ? 'mapped to academic_options' : item.programmeCode ? 'programme-level record; no branch is assigned' : 'unmapped and excluded from import',
      });
    }
  }
  const recordsWithoutPublishedSemesterOrCredits = mapped.filter((item) =>
    ['not-published', 'missing', 'programme-summary', 'range-or-summary'].includes(item.semesterMapping.status)
    || item.credits == null).length;
  const ambiguousRelationshipMappings = [...relationshipMappings.values()].filter((item) => item.handling === 'unmapped and excluded from import').length;
  const dataQuality = {
    missingCourseCodes: mapped.filter((item) => !item.courseCode).length,
    blankCreditCells: mapped.filter((item) => !item.creditsRaw).length,
    nonNumericCreditNotations: mapped.filter((item) => item.creditsRaw && item.credits == null).length,
    missingCourseYears: mapped.filter((item) => !item.courseYear).length,
    missingCategories: mapped.filter((item) => !item.category).length,
    semesterNotPublishedOrOnlyAggregate: mapped.filter((item) => ['not-published', 'missing', 'programme-summary', 'range-or-summary'].includes(item.semesterMapping.status)).length,
    exactDuplicates: duplicateCount,
    invalidOrUnmappedRows: mapped.filter((item) => item.importAction === 'skip_invalid_unmapped').length,
    ambiguousRelationshipMappings,
  };
  const issues = mapped.flatMap((item) => item.issues.map((message) => ({ worksheet: item.worksheet, row: item.sourceRow, programme: item.programme, courseName: item.courseName, message })));
  return {
    sourceFile: path.basename(filePath),
    worksheetSummary: worksheetsSummary,
    headerRow: 1,
    columnMapping: headers.map((header, index) => ({
      excelColumn: columnName(index),
      header,
      databaseField: DATABASE_FIELD_MAP[header] || null,
      handling: header === 'Credits' ? 'numeric value stored in credits; original text retained in credits_raw' : FIELD_MAP[header] ? 'mapped' : 'not imported directly',
    })),
    mappingWarnings: missingHeaders.map((header) => `Required workbook header is missing: ${header}`),
    totals: {
      curriculumRows: mapped.length,
      validNamedPublishedSubjects: valid.length,
      choiceRequiredRecords: mapped.filter((item) => item.recordStatus === 'choice_required').length,
      conditionalRecords: mapped.filter((item) => item.recordStatus === 'conditional').length,
      areaOnlyRecords: mapped.filter((item) => item.recordStatus === 'area_only').length,
      needsReviewRecords: mapped.filter((item) => item.recordStatus === 'needs_review').length,
      partialRecords: mapped.filter((item) => item.recordStatus === 'partial').length,
      recordsWithoutOfficialSemesterOrCredits: recordsWithoutPublishedSemesterOrCredits,
      duplicateRecords: duplicateCount,
      invalidOrUnmappedRecords: mapped.filter((item) => item.importAction === 'skip_invalid_unmapped').length,
      warnings: issues.length,
    },
    dataQuality,
    countsByProgramme,
    countsByBranch,
    countsBySemester,
    countsByStatus,
    countsBySourceStatus,
    relationshipMappings: [...relationshipMappings.values()],
    samples,
    issues,
    records: mapped,
  };
}

function columnName(index) {
  let value = index + 1;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function selectSamples(records) {
  const criteria = [
    (item) => item.recordStatus === 'published' && item.programmeCode === 'BTECH' && item.semesterMapping.number === 1,
    (item) => item.recordStatus === 'published' && item.programmeCode === 'BBA' && item.semesterMapping.number,
    (item) => item.recordStatus === 'published' && item.programmeCode === 'BCOM_HONS',
    (item) => item.recordStatus === 'published' && item.programmeCode === 'BA_LLB_HONS',
    (item) => item.recordStatus === 'choice_required',
    (item) => item.recordStatus === 'conditional',
    (item) => item.recordStatus === 'area_only',
    (item) => item.recordStatus === 'needs_review',
    (item) => item.importAction === 'preserve_unresolved_basket_not_assignable',
    (item) => item.programmeCode === 'BTECH' && item.branchOrMajor.includes('EComE'),
    (item) => item.programmeCode === 'BTECH' && item.branchOrMajor.includes('Mechanical'),
    (item) => item.recordStatus === 'partial',
  ];
  const result = [];
  for (const criteriaMatch of criteria) {
    const sample = records.find((item) => criteriaMatch(item) && !result.includes(item));
    if (sample) result.push(sample);
  }
  for (const item of records) {
    if (result.length >= 12) break;
    if (!result.includes(item)) result.push(item);
  }
  return result.slice(0, 12);
}

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

function writeReports(report, outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const reportHash = stableHash(report.records.map((item) => ({
    sourceRowHash: item.mappingHash,
    programmeCode: item.programmeCode,
    branchCode: item.branchCode,
    recordStatus: item.recordStatus,
    semesterMapping: item.semesterMapping,
    credits: item.credits,
    creditsRaw: item.creditsRaw,
    importAction: item.importAction,
    sourceStatus: item.sourceStatus,
  })));
  report.reportHash = reportHash;
  const jsonPath = path.join(outputDir, 'curriculum-mapping-preview.json');
  const csvPath = path.join(outputDir, 'curriculum-mapping-preview.csv');
  const markdownPath = path.join(outputDir, 'curriculum-mapping-preview.md');
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const csvHeaders = ['worksheet', 'sourceRow', 'programme', 'programmeName', 'branchOrMajor', 'branchName', 'courseName', 'courseCode', 'semester', 'credits', 'creditsRaw', 'category', 'sourceStatus', 'recordStatus', 'importAction', 'issues'];
  const csvRows = report.records.map((item) => csvHeaders.map((header) => csvEscape(Array.isArray(item[header]) ? item[header].join(' | ') : item[header])).join(','));
  fs.writeFileSync(csvPath, `${csvHeaders.join(',')}\n${csvRows.join('\n')}\n`, 'utf8');

  const lines = [
    '# BMU curriculum import mapping preview',
    '',
    `Source workbook: ${report.sourceFile}`,
    `Mapping report hash: \`${reportHash}\``,
    '',
    '> Preview only. No MySQL connection or curriculum insert/update/delete was performed.',
    '',
    '## Worksheet row counts',
    '',
    '| Worksheet | Rows including header | Data rows | Handling |',
    '|---|---:|---:|---|',
    ...report.worksheetSummary.map((sheet) => `| ${sheet.worksheet} | ${sheet.totalRowsIncludingHeader} | ${sheet.dataRows} | ${sheet.classification} |`),
    '',
    '## Excel column mapping',
    '',
    '| Excel column | Header | Target field | Handling |',
    '|---|---|---|---|',
    ...report.columnMapping.map((column) => `| ${column.excelColumn} | ${column.header} | ${column.databaseField || '—'} | ${column.handling} |`),
    '',
    '## Programme and branch relationship mapping',
    '',
    '| Workbook programme | Workbook branch/major | Target programme | Target option | Handling |',
    '|---|---|---|---|---|',
    ...report.relationshipMappings.map((mapping) => `| ${mapping.workbookProgramme} | ${mapping.workbookBranchOrMajor} | ${mapping.targetProgrammeName || mapping.targetProgrammeCode || '—'} | ${mapping.targetBranchOrMajor || mapping.targetOptionCode || 'Programme level'} | ${mapping.handling} |`),
    '',
    '## Record summary',
    '',
    ...Object.entries(report.totals).map(([key, value]) => `- **${key}:** ${value}`),
    '',
    '## Missing, invalid, duplicate, and ambiguous checks',
    '',
    ...Object.entries(report.dataQuality).map(([key, value]) => `- **${key}:** ${value}`),
    '',
    '## Programme-wise counts',
    '',
    ...Object.entries(report.countsByProgramme).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Branch/major-wise counts',
    '',
    ...Object.entries(report.countsByBranch).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Semester-wise counts',
    '',
    ...Object.entries(report.countsBySemester).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Status counts',
    '',
    ...Object.entries(report.countsByStatus).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Original workbook status counts',
    '',
    ...Object.entries(report.countsBySourceStatus).map(([key, value]) => `- ${key}: ${value}`),
    '',
    '## Sample mapped records',
    '',
    '| Worksheet | Programme | Branch | Course name | Course code | Semester | Credits | Status | Import action |',
    '|---|---|---|---|---|---|---:|---|---|',
    ...report.samples.map((item) => `| ${item.worksheet} | ${item.programme} | ${item.branchOrMajor} | ${item.courseName} | ${item.courseCode || '—'} | ${item.semester} | ${item.creditsRaw || '—'} | ${item.sourceStatus} | ${item.importAction} |`),
    '',
    '## Detected issues and cautions',
    '',
    ...report.issues.slice(0, 100).map((issue) => `- Row ${issue.row} (${issue.programme}; ${issue.courseName}): ${issue.message}`),
    ...(report.issues.length > 100 ? [`- ${report.issues.length - 100} additional warnings are listed in the JSON and CSV reports.`] : []),
    '',
    '### Import policy',
    '',
    '- Published named courses may be imported as assignable curriculum records, even when the workbook omits course codes; missing codes are retained as NULL.',
    '- Choice-required baskets, conditional records, area-only entries, partial structures and syllabus placeholders are preserved as non-assignable curriculum metadata.',
    '- Programme-level structural descriptions are not treated as branches. The five Liberal Studies programme titles are mapped to the Liberal Studies programme and their stated major.',
    '- Exact duplicate source records are skipped. Existing database rows are never updated or deleted by the import script.',
    '- Phase 2 requires a separate explicit approval, the exact report hash, and `CURRICULUM_IMPORT_APPROVED=true`.',
    '',
  ];
  fs.writeFileSync(markdownPath, `${lines.join('\n')}\n`, 'utf8');
  return { jsonPath, csvPath, markdownPath, reportHash };
}

async function applyApprovedImport(report, approvedHash) {
  if (process.env.CURRICULUM_IMPORT_APPROVED !== 'true') {
    throw new Error('Import is blocked. A separate explicit approval and CURRICULUM_IMPORT_APPROVED=true are required.');
  }
  if (!approvedHash || approvedHash !== report.reportHash) {
    throw new Error('Import is blocked because the approved report hash does not match the current mapping preview.');
  }

  const pool = require('./pool');
  const connection = await pool.getConnection();
  const log = [];
  let inserted = 0;
  let skipped = 0;
  try {
    await connection.beginTransaction();
    const [programmes] = await connection.execute('SELECT id, code FROM academic_programmes');
    const programmeIds = new Map(programmes.map((row) => [row.code, Number(row.id)]));
    const [options] = await connection.execute('SELECT id, code, programme_id AS programmeId FROM academic_options');
    const optionIds = new Map(options.map((row) => [`${Number(row.programmeId)}:${row.code}`, Number(row.id)]));
    const [semesters] = await connection.execute('SELECT id, semester_number AS semesterNumber FROM academic_semesters');
    const semesterIds = new Map(semesters.map((row) => [Number(row.semesterNumber), Number(row.id)]));

    for (const item of report.records) {
      if (item.importAction === 'skip_duplicate_source_record') {
        skipped += 1;
        log.push({ row: item.sourceRow, action: 'skipped', reason: `Exact duplicate of worksheet row ${item.duplicateOfRow}.` });
        continue;
      }
      if (!item.programmeCode || !programmeIds.has(item.programmeCode) || !item.branchCode && item.branchOrMajor && item.branchName == null && item.branchOrMajor.startsWith('Unknown:')) {
        skipped += 1;
        log.push({ row: item.sourceRow, action: 'skipped', reason: 'Programme/branch is not present in academic structure.' });
        continue;
      }
      if (item.importAction === 'skip_invalid_unmapped') {
        skipped += 1;
        log.push({ row: item.sourceRow, action: 'skipped', reason: item.issues.join(' ') || 'Invalid or unmapped record.' });
        continue;
      }
      const programmeId = programmeIds.get(item.programmeCode);
      const branchOptionId = item.branchCode ? optionIds.get(`${programmeId}:${item.branchCode}`) : null;
      if (item.branchCode && !branchOptionId) {
        skipped += 1;
        log.push({ row: item.sourceRow, action: 'skipped', reason: `Mapped branch ${item.branchCode} is not present in academic structure.` });
        continue;
      }
      const [existing] = await connection.execute('SELECT id FROM curriculum_subjects WHERE mapping_hash = ? LIMIT 1', [item.mappingHash]);
      if (existing.length) {
        skipped += 1;
        log.push({ row: item.sourceRow, action: 'skipped', reason: 'This source row was already imported.' });
        continue;
      }
      let subjectId = null;
      if (item.importAction === 'import_named_published_course') {
        const [subject] = await connection.execute(
          'INSERT INTO subjects (subject_code, subject_name, is_active) VALUES (?, ?, TRUE)',
          [item.courseCode || null, item.courseName],
        );
        subjectId = subject.insertId;
      }
      const semesterId = item.semesterMapping.number ? semesterIds.get(item.semesterMapping.number) || null : null;
      const [created] = await connection.execute(`
        INSERT INTO curriculum_subjects (
          subject_id, programme_id, branch_option_id, semester_id,
          course_name, course_code, semester_label, course_year, credits, credits_raw,
          category, record_status, source_data_status, source_worksheet, source_row, source_url,
          notes, mapping_hash, created_by_user_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
      `, [
        subjectId, programmeId, branchOptionId || null, semesterId,
        item.courseName, item.courseCode || null, item.semesterMapping.label,
        item.courseYear || null, item.credits, item.creditsRaw || null, item.category || null,
        item.recordStatus, item.sourceStatus || null, item.worksheet, item.sourceRow, item.sourceUrl || null,
        item.notes || null, item.mappingHash,
      ]);
      inserted += 1;
      log.push({ row: item.sourceRow, action: 'inserted', curriculumRecordId: created.insertId, subjectId, importAction: item.importAction });
    }
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
  return { inserted, updated: 0, skipped, log };
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes('--apply') ? 'apply' : 'preview';
  const workbookPath = args.find((argument) => !argument.startsWith('--'));
  if (!workbookPath || !fs.existsSync(workbookPath)) {
    throw new Error('Usage: node backend/database/import-curriculum.js <workbook.xlsx> [--apply --approved-report-hash=<sha256>]');
  }
  const report = inspectWorkbook(path.resolve(workbookPath));
  const outputDir = path.resolve(__dirname, '../reports');
  const written = writeReports(report, outputDir);
  console.log(`Preview written to ${written.markdownPath}`);
  console.log(`Mapping JSON: ${written.jsonPath}`);
  console.log(`Mapped rows CSV: ${written.csvPath}`);
  console.log(`Mapping report hash: ${written.reportHash}`);
  console.log(`Detected ${report.totals.curriculumRows} curriculum rows; no database import was performed in preview mode.`);
  if (mode === 'apply') {
    const hashArg = args.find((argument) => argument.startsWith('--approved-report-hash='));
    const approvedHash = hashArg?.slice('--approved-report-hash='.length);
    const result = await applyApprovedImport(report, approvedHash);
    const summaryPath = path.join(outputDir, `curriculum-import-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(summaryPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`Import summary: ${summaryPath}`);
    console.log(JSON.stringify({ inserted: result.inserted, updated: result.updated, skipped: result.skipped }));
    const pool = require('./pool');
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { inspectWorkbook, mapProgramme, mapBranch, parseSemester, applyApprovedImport, writeReports };
