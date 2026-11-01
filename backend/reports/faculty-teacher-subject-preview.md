# Faculty and teacher-subject assignment preview

Inspection date: 2026-11-01

This is a read-only Phase 1 preview. No faculty, subject, curriculum, or assignment rows were inserted or changed.

## Database inventory

| Table | Current records | Relevant verified columns |
|---|---:|---|
| `users` | 2 teacher-role users | `id`, `name`, `role`, `is_active` |
| `teacher_profiles` | 2 profiles | `user_id`, `teacher_id`, `contact_number`, `department` |
| `subjects` | 0 | `id`, `subject_code` (nullable), `subject_name`, `is_active` |
| `curriculum_subjects` | 0 | `id`, `subject_id`, `programme_id`, `branch_option_id`, `semester_id`, `course_name`, `course_code` (nullable), `semester_label`, `course_year`, `credits` (nullable), `record_status` |
| `teacher_subjects` | 0 | `teacher_user_id`, `subject_id` |
| `teacher_course_assignments` | 0 | `teacher_user_id`, `section_id` (NOT NULL), `curriculum_subject_id` |
| `class_course_assignments` | 0 | `section_id`, `curriculum_subject_id` |
| `academic_programmes` | 7 | `id`, `code`, `name`, `min_duration_years`, `max_duration_years`, `is_active` |
| `academic_options` | 34 | `id`, `programme_id`, `parent_option_id`, `code`, `name`, `option_type`, `is_active` |
| `academic_semesters` | 10 | `id`, `semester_number`, `label`, `is_active` |
| `academic_sections` | 13 | `id`, `programme_id`, `branch_option_id`, `section_name`, `is_active` |

Existing teacher accounts found (names only): `Faculty` (`TCH-0002`) and `tester1` (`TCH-0022`). Neither matches a requested faculty member. No login IDs, email addresses, or credentials were inferred.

## Requested assignment mapping

The supplied section/batch wording is retained as a planning note only. It is not an applied class allocation. No semester is inferred from a target year.

| Faculty | Target year | Subject (provided) | Proposed canonical subject | Programme/branch context | Section note for later | Teacher found | Subject/curriculum match | Proposed action |
|---|---|---|---|---|---|---|---|---|
| Hirdesh Kumar Pharasi | 3rd Year | ML (Machine Learning) | Machine Learning | B.Tech / CSE | CSE 6 | No | No | Blocked: faculty and subject missing |
| Hirdesh Kumar Pharasi | 3rd Year | ADS 1 (Advanced Data Structures 1) | Advanced Data Structures 1 | B.Tech / CSE | CSE 5 & CSE 6 (combined, per supplied note) | No | No | Blocked: faculty and subject missing |
| Hirdesh Kumar Pharasi | 3rd Year | ADS 2 (Advanced Data Structures 2) | Advanced Data Structures 2 | B.Tech / CSE | CSE 7 & CSE 8 (combined, per supplied note) | No | No | Blocked: faculty and subject missing |
| Atul Mishra | 1st Year | C Programming | C Programming | B.Tech / CSE | CSE 4 & CSE 5 | No | No | Blocked: faculty and subject missing |
| Atul Mishra | 4th Year | NLP (Natural Language Processing) | Natural Language Processing | Programme/branch needs confirmation | All 4th Year / Core | No | No | Blocked: faculty and subject missing; programme scope unclear |
| Subhankar Ghatak | 2nd Year | DSA (Data Structures & Algorithms) | Data Structures & Algorithms | B.Tech / CSE | CSE 7 | No | No | Blocked: faculty and subject missing |
| Subhankar Ghatak | 3rd Year | ML (Machine Learning) | Machine Learning | B.Tech / CSE | CSE 4 & CSE 5 (respective classes) | No | No | Blocked: faculty and subject missing |
| Ranbir Singh | 1st Year | EME (Elements of Mechanical Engineering) | Elements of Mechanical Engineering | B.Tech / CSE as supplied in section note; confirm this unusual pairing | CSE 5 & CSE 6 | No | No | Blocked: faculty and subject missing; branch/curriculum scope needs confirmation |
| Ranbir Singh | 2nd Year | D & CS | D & CS | B.Tech / Mechanical | Mechanical (section/batch unspecified) | No | No | Blocked: faculty and subject missing; exact subject name and section need confirmation |
| Ranbir Singh | 3rd Year | Intro to Robotics & IoT | Introduction to Robotics & Internet of Things | B.Tech / Mechanical | Mechanical (section/batch unspecified) | No | No | Blocked: faculty and subject missing; confirm whether this is one combined course |

## Findings and decisions needed

- Requested teachers found: **0 of 4**. All four are missing. Per the instruction, no accounts will be created and no identifying information or credentials will be invented.
- Existing subjects and curriculum subjects: **0**. The nine proposed canonical subject names above have no matching records, so none can be linked by ID. No subjects, codes, or credits have been created or inferred.
- Proposed assignment pairs: **10**; safely insertable now: **0**. Teacher accounts and subject/curriculum IDs are prerequisites.
- Potential repeat subject: Machine Learning is requested for two faculty members. This is not a duplicate assignment because the faculty differ. Its curriculum placement still needs an approved course record and year/programme scope.
- Semester mappings requiring confirmation: **all 10**. The database contains semester numbers 1–8 as active and 9–10 as inactive, but has no verified year-to-semester relationship for these requests. The existing `curriculum_subjects.course_year` column can preserve a supplied year, while `semester_id` can remain NULL until confirmed.
- Section allocations: **10 pending manual review**. Existing CSE sections include `CSE4` through `CSE8`, but no section rows will be created. Mechanical section names/batches are not present in the active section inventory.
- Combined batches: the existing `teacher_course_assignments` table has one required `section_id` per row and its uniqueness is per teacher + section + curriculum subject. It cannot represent one combined teaching assignment with a separately managed set of sections without duplicating the teacher/course relation.
- Unsectioned teacher-subject assignments: the legacy `teacher_subjects` table supports teacher + subject only, but it cannot carry curriculum subject, programme/branch, or target year. The current Teacher Assignment API/UI uses `teacher_course_assignments` and requires a section when creating an assignment.

## Proposed minimal design before any insert

1. Reuse the existing `subjects` and `curriculum_subjects` tables for approved subject records. Leave course code and credits NULL where the provided data does not supply them. Preserve the target year in the existing `course_year` field; leave `semester_id` NULL until confirmed.
2. Do not create teacher accounts until you provide/reconcile their existing account identities through the normal Teacher Management workflow.
3. To support one teacher-to-curriculum assignment before any sections are selected, introduce a parent assignment relationship keyed by `teacher_user_id` + `curriculum_subject_id`; keep section links as a separate child relationship. This is the smallest normalized change that supports an unsectioned state and combined section groups without creating a second teacher-subject assignment. The present schema has no such parent relationship. The exact migration and workspace changes should be reviewed before implementation.
4. Do not create final section allocations from the supplied notes. After approval and implementation, section links can be configured manually in the Course Assignment Workspace.

## Approval boundary

This preview does not authorize database changes. No inserts, updates, or deletes were performed. Review the missing teachers, proposed subject names, Mechanical/CSE scope questions, NLP programme scope, exact “D & CS” naming, combined Robotics/IoT interpretation, and the relationship design. A separate explicit approval is required before inserting any faculty/subject/assignment data.
