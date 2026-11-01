# BMU curriculum import mapping preview

Source workbook: BMU_Curriculum_Subject_Master.xlsx
Mapping report hash: `02b521cff6a1bb244ea7c382cf0ab0b7edc98521a8081fbde7d2ea3b1a677327`

> Preview only. No MySQL connection or curriculum insert/update/delete was performed.

## Worksheet row counts

| Worksheet | Rows including header | Data rows | Handling |
|---|---:|---:|---|
| Curriculum Master | 244 | 243 | curriculum source |
| Read Me | 13 | 12 | metadata/reference sheet; no subject rows imported |
| Source Index | 10 | 9 | metadata/reference sheet; no subject rows imported |
| Programme Areas | 1 | 0 | metadata/reference sheet; no subject rows imported |

## Excel column mapping

| Excel column | Header | Target field | Handling |
|---|---|---|---|
| A | Programme | academic_programmes.id (matched by code) | mapped |
| B | Branch / Major | academic_options.id (matched by programme and option code; programme-level for structural labels) | mapped |
| C | Semester | academic_semesters.id when numeric; original label retained in curriculum_subjects.semester_label | mapped |
| D | Year | curriculum_subjects.course_year | mapped |
| E | Course Code | curriculum_subjects.course_code and subjects.subject_code for assignable courses | mapped |
| F | Subject / Course | curriculum_subjects.course_name; subjects.subject_name only for assignable courses | mapped |
| G | Credits | curriculum_subjects.credits; original value retained in curriculum_subjects.credits_raw | numeric value stored in credits; original text retained in credits_raw |
| H | Category | curriculum_subjects.category | mapped |
| I | Data Status | curriculum_subjects.source_data_status (normalized value also in record_status) | mapped |
| J | Source URL | curriculum_subjects.source_url | mapped |
| K | Notes | curriculum_subjects.notes | mapped |

## Programme and branch relationship mapping

| Workbook programme | Workbook branch/major | Target programme | Target option | Handling |
|---|---|---|---|---|
| B.Tech | Computer Science and Engineering (CSE) | B.Tech | Computer Science and Engineering (CSE) | mapped to academic_options |
| BBA / BBA (Hons.) | General / Major structure | BBA / BBA (Hons.) | Programme level | programme-level record; no branch is assigned |
| B.Com (Hons.) | General / specialisation elective structure | B.Com (Hons.) | Programme level | programme-level record; no branch is assigned |
| B.A. LL.B. (Hons.) | Integrated Law programme | B.A. LL.B. (Hons.) | Programme level | programme-level record; no branch is assigned |
| B.Tech | Mechanical Engineering | B.Tech | Mechanical Engineering (ME) | mapped to academic_options |
| B.Tech | Electronics and Computer Engineering (EComE) | B.Tech | Electronics and Computer Engineering (EComE) | mapped to academic_options |
| B.A. (Hons.) Sociology | Major programme | B.A. (Hons.) – Liberal Studies | Sociology | mapped to academic_options |
| B.A. (Hons.) Psychology | Major programme | B.A. (Hons.) – Liberal Studies | Psychology | mapped to academic_options |
| B.A. (Hons.) Economics | Major programme | B.A. (Hons.) – Liberal Studies | Economics | mapped to academic_options |
| B.A. (Hons.) Literature | Major programme | B.A. (Hons.) – Liberal Studies | Literature | mapped to academic_options |
| B.A. (Hons.) History | Major programme | B.A. (Hons.) – Liberal Studies | History | mapped to academic_options |
| BBA LL.B. (Hons.) | Integrated Law programme | BBA LL.B. (Hons.) | Programme level | programme-level record; no branch is assigned |
| Integrated BBA + MBA | Integrated programme | Integrated BBA + MBA | Programme level | programme-level record; no branch is assigned |

## Record summary

- **curriculumRows:** 243
- **validNamedPublishedSubjects:** 136
- **choiceRequiredRecords:** 66
- **conditionalRecords:** 4
- **areaOnlyRecords:** 26
- **needsReviewRecords:** 9
- **partialRecords:** 2
- **recordsWithoutOfficialSemesterOrCredits:** 35
- **duplicateRecords:** 0
- **invalidOrUnmappedRecords:** 0
- **warnings:** 68

## Missing, invalid, duplicate, and ambiguous checks

- **missingCourseCodes:** 160
- **blankCreditCells:** 33
- **nonNumericCreditNotations:** 1
- **missingCourseYears:** 34
- **missingCategories:** 6
- **semesterNotPublishedOrOnlyAggregate:** 34
- **exactDuplicates:** 0
- **invalidOrUnmappedRows:** 0
- **ambiguousRelationshipMappings:** 0

## Programme-wise counts

- B.A. (Hons.) Economics: 1
- B.A. (Hons.) History: 1
- B.A. (Hons.) Literature: 1
- B.A. (Hons.) Psychology: 1
- B.A. (Hons.) Sociology: 1
- B.A. LL.B. (Hons.): 53
- B.Com (Hons.): 42
- B.Tech: 84
- BBA / BBA (Hons.): 57
- BBA LL.B. (Hons.): 1
- Integrated BBA + MBA: 1

## Branch/major-wise counts

- Computer Science and Engineering (CSE): 58
- Electronics and Computer Engineering (EComE): 14
- General / Major structure: 57
- General / specialisation elective structure: 42
- Integrated Law programme: 54
- Integrated programme: 1
- Major programme: 5
- Mechanical Engineering: 12

## Semester-wise counts

- 1: 26
- 2: 27
- 3: 24
- 4: 26
- 5: 25
- 6: 25
- 7: 23
- 8: 17
- 9: 6
- 10: 4
- Not published: 32
- Programme total: 1
- Semesters 1-3: 1
- ST1: 1
- ST2: 1
- Summer after Sem 2: 2
- Summer after Sem 4: 2

## Status counts

- area_only: 26
- choice_required: 66
- conditional: 4
- needs_review: 9
- partial: 2
- published: 136

## Original workbook status counts

- Area only - semester/credits not published: 26
- Basket/definition not specified: 3
- Choice required: 66
- Conditional: 4
- Needs official syllabus: 6
- Partially published: 1
- Published: 137

## Sample mapped records

| Worksheet | Programme | Branch | Course name | Course code | Semester | Credits | Status | Import action |
|---|---|---|---|---|---|---:|---|---|
| Curriculum Master | B.Tech | Computer Science and Engineering (CSE) | Engineering Ethics | — | 1 | 2 | Published | import_named_published_course |
| Curriculum Master | BBA / BBA (Hons.) | General / Major structure | Business Organisation and Principles of Management | MGT1701 | 1 | 4 | Published | import_named_published_course |
| Curriculum Master | B.Com (Hons.) | General / specialisation elective structure | Financial Accounting | ACC1702 | 1 | 4 | Published | import_named_published_course |
| Curriculum Master | B.A. LL.B. (Hons.) | Integrated Law programme | Law of General Contract | LAW1701 | 1 | 4 | Published | import_named_published_course |
| Curriculum Master | B.Tech | Computer Science and Engineering (CSE) | Select one course from respective AEC basket | — | 2 | 2 | Choice required | preserve_elective_slot_not_assignable_subject |
| Curriculum Master | BBA / BBA (Hons.) | General / Major structure | Advanced Business Research Methodology | MKT3701 | 7 | 4 | Conditional | preserve_conditional_record_not_assignable_by_default |
| Curriculum Master | B.Tech | Mechanical Engineering | Thermodynamics | — | Not published | — | Area only - semester/credits not published | preserve_as_non_subject_area_record |
| Curriculum Master | B.Tech | Computer Science and Engineering (CSE) | Co-curricular | — | 2 | 2 | Basket/definition not specified | preserve_unresolved_basket_not_assignable |
| Curriculum Master | B.Tech | Computer Science and Engineering (CSE) | Co-curricular | — | 4 | 2 | Basket/definition not specified | preserve_unresolved_basket_not_assignable |
| Curriculum Master | B.Tech | Electronics and Computer Engineering (EComE) | Mathematics and Physics Foundations | — | Not published | — | Area only - semester/credits not published | preserve_as_non_subject_area_record |
| Curriculum Master | B.Tech | Mechanical Engineering | Fluid Mechanics | — | Not published | — | Area only - semester/credits not published | preserve_as_non_subject_area_record |
| Curriculum Master | BBA / BBA (Hons.) | General / Major structure | Enrichment Course | — | Programme total | 5 | Published | preserve_summary_not_subject |

## Detected issues and cautions

- Row 58 (B.Tech; Practice School –I / Community Project): Credits notation "Audit" is preserved as text; no numeric credit was inferred.
- Row 116 (BBA / BBA (Hons.); Enrichment Course): No official single-semester placement is present.
- Row 212 (B.Tech; Thermodynamics): No official single-semester placement is present.
- Row 212 (B.Tech; Thermodynamics): No officially supplied credit value is present.
- Row 213 (B.Tech; Fluid Mechanics): No official single-semester placement is present.
- Row 213 (B.Tech; Fluid Mechanics): No officially supplied credit value is present.
- Row 214 (B.Tech; Machine Design): No official single-semester placement is present.
- Row 214 (B.Tech; Machine Design): No officially supplied credit value is present.
- Row 215 (B.Tech; Mechatronics): No official single-semester placement is present.
- Row 215 (B.Tech; Mechatronics): No officially supplied credit value is present.
- Row 216 (B.Tech; Automotive Systems): No official single-semester placement is present.
- Row 216 (B.Tech; Automotive Systems): No officially supplied credit value is present.
- Row 217 (B.Tech; Fuels, Combustion and Internal Combustion Engine): No official single-semester placement is present.
- Row 217 (B.Tech; Fuels, Combustion and Internal Combustion Engine): No officially supplied credit value is present.
- Row 218 (B.Tech; Hydraulics and Pneumatics): No official single-semester placement is present.
- Row 218 (B.Tech; Hydraulics and Pneumatics): No officially supplied credit value is present.
- Row 219 (B.Tech; Manufacturing Processes and Systems): No official single-semester placement is present.
- Row 219 (B.Tech; Manufacturing Processes and Systems): No officially supplied credit value is present.
- Row 220 (B.Tech; Machine Learning): No official single-semester placement is present.
- Row 220 (B.Tech; Machine Learning): No officially supplied credit value is present.
- Row 221 (B.Tech; Industrial Engineering): No official single-semester placement is present.
- Row 221 (B.Tech; Industrial Engineering): No officially supplied credit value is present.
- Row 222 (B.Tech; Robotics and Automation): No official single-semester placement is present.
- Row 222 (B.Tech; Robotics and Automation): No officially supplied credit value is present.
- Row 223 (B.Tech; Computer-Aided Design / Computer-Aided Manufacturing (CAD/CAM)): No official single-semester placement is present.
- Row 223 (B.Tech; Computer-Aided Design / Computer-Aided Manufacturing (CAD/CAM)): No officially supplied credit value is present.
- Row 224 (B.Tech; Mathematics and Physics Foundations): No official single-semester placement is present.
- Row 224 (B.Tech; Mathematics and Physics Foundations): No officially supplied credit value is present.
- Row 225 (B.Tech; Fundamental Engineering): No official single-semester placement is present.
- Row 225 (B.Tech; Fundamental Engineering): No officially supplied credit value is present.
- Row 226 (B.Tech; VLSI Design): No official single-semester placement is present.
- Row 226 (B.Tech; VLSI Design): No officially supplied credit value is present.
- Row 227 (B.Tech; Embedded Systems): No official single-semester placement is present.
- Row 227 (B.Tech; Embedded Systems): No officially supplied credit value is present.
- Row 228 (B.Tech; Data Structures): No official single-semester placement is present.
- Row 228 (B.Tech; Data Structures): No officially supplied credit value is present.
- Row 229 (B.Tech; Communication Systems): No official single-semester placement is present.
- Row 229 (B.Tech; Communication Systems): No officially supplied credit value is present.
- Row 230 (B.Tech; Microprocessors): No official single-semester placement is present.
- Row 230 (B.Tech; Microprocessors): No officially supplied credit value is present.
- Row 231 (B.Tech; Artificial Intelligence): No official single-semester placement is present.
- Row 231 (B.Tech; Artificial Intelligence): No officially supplied credit value is present.
- Row 232 (B.Tech; Internet of Things): No official single-semester placement is present.
- Row 232 (B.Tech; Internet of Things): No officially supplied credit value is present.
- Row 233 (B.Tech; Machine Learning): No official single-semester placement is present.
- Row 233 (B.Tech; Machine Learning): No officially supplied credit value is present.
- Row 234 (B.Tech; Cyber Security): No official single-semester placement is present.
- Row 234 (B.Tech; Cyber Security): No officially supplied credit value is present.
- Row 235 (B.Tech; Blockchain): No official single-semester placement is present.
- Row 235 (B.Tech; Blockchain): No officially supplied credit value is present.
- Row 236 (B.Tech; Data Science): No official single-semester placement is present.
- Row 236 (B.Tech; Data Science): No officially supplied credit value is present.
- Row 237 (B.Tech; Bioinformatics): No official single-semester placement is present.
- Row 237 (B.Tech; Bioinformatics): No officially supplied credit value is present.
- Row 238 (B.A. (Hons.) Sociology; Curriculum not available in the captured official page): No official single-semester placement is present.
- Row 238 (B.A. (Hons.) Sociology; Curriculum not available in the captured official page): No officially supplied credit value is present.
- Row 239 (B.A. (Hons.) Psychology; Curriculum not available in the captured official page): No official single-semester placement is present.
- Row 239 (B.A. (Hons.) Psychology; Curriculum not available in the captured official page): No officially supplied credit value is present.
- Row 240 (B.A. (Hons.) Economics; Curriculum not available in the captured official page): No official single-semester placement is present.
- Row 240 (B.A. (Hons.) Economics; Curriculum not available in the captured official page): No officially supplied credit value is present.
- Row 241 (B.A. (Hons.) Literature; Curriculum not available in the captured official page): No official single-semester placement is present.
- Row 241 (B.A. (Hons.) Literature; Curriculum not available in the captured official page): No officially supplied credit value is present.
- Row 242 (B.A. (Hons.) History; Curriculum not available in the captured official page): No official single-semester placement is present.
- Row 242 (B.A. (Hons.) History; Curriculum not available in the captured official page): No officially supplied credit value is present.
- Row 243 (BBA LL.B. (Hons.); Semester-wise law/business curriculum): No official single-semester placement is present.
- Row 243 (BBA LL.B. (Hons.); Semester-wise law/business curriculum): No officially supplied credit value is present.
- Row 244 (Integrated BBA + MBA; Detailed semester-wise course/credit matrix not extracted): No official single-semester placement is present.
- Row 244 (Integrated BBA + MBA; Detailed semester-wise course/credit matrix not extracted): No officially supplied credit value is present.

### Import policy

- Published named courses may be imported as assignable curriculum records, even when the workbook omits course codes; missing codes are retained as NULL.
- Choice-required baskets, conditional records, area-only entries, partial structures and syllabus placeholders are preserved as non-assignable curriculum metadata.
- Programme-level structural descriptions are not treated as branches. The five Liberal Studies programme titles are mapped to the Liberal Studies programme and their stated major.
- Exact duplicate source records are skipped. Existing database rows are never updated or deleted by the import script.
- Phase 2 requires a separate explicit approval, the exact report hash, and `CURRICULUM_IMPORT_APPROVED=true`.

