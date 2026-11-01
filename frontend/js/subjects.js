(() => {
  const rows = document.querySelector('[data-subject-rows]');
  if (!rows) return;

  const query = (selector, root = document) => root.querySelector(selector);
  const message = query('[data-subject-message]');
  const assignmentMessage = query('[data-assignment-message]');
  const search = query('[data-search]');
  const programmeFilter = query('[data-filter-programme]');
  const branchFilter = query('[data-filter-branch]');
  const semesterFilter = query('[data-filter-semester]');
  const creditsFilter = query('[data-filter-credits]');
  const modal = query('[data-subject-modal]');
  const form = query('[data-subject-form]');
  const detail = query('[data-subject-detail]');
  const formProgramme = query('[data-form-programme]');
  const formBranch = query('[data-form-branch]');
  const formSemester = query('[data-form-semester]');
  const formSection = query('[data-form-section]');
  const formTeacher = query('[data-form-teacher]');
  const assignmentRecords = query('[data-assignment-records]');

  let options = null;
  let page = 1;
  let totalPages = 1;
  let searchTimer;
  let activeAssignmentType = 'class';

  function setMessage(target, text, type = '') {
    target.textContent = text;
    target.className = `teacher-message${type ? ` ${type}` : ''}`;
  }

  async function request(url, requestOptions = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...requestOptions,
      headers: {
        ...(requestOptions.body ? { 'Content-Type': 'application/json' } : {}),
        ...requestOptions.headers,
      },
    });
    const type = response.headers.get('content-type') || '';
    if (response.redirected || !type.includes('application/json')) {
      throw new Error('The server did not return subject data. Your session may have expired.');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function textElement(tag, value, className = '') {
    const node = document.createElement(tag);
    node.textContent = value ?? '';
    if (className) node.className = className;
    return node;
  }

  function fillSelect(select, items, label, valueKey = 'id', textKey = 'name') {
    select.replaceChildren();
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = label;
    select.append(placeholder);
    for (const item of items) {
      const option = document.createElement('option');
      option.value = item[valueKey];
      option.textContent = item[textKey];
      select.append(option);
    }
  }

  function fillProgrammeFilters() {
    const active = options.programmes.filter((item) => Number(item.isActive));
    fillSelect(programmeFilter, active, 'All programmes');
    fillSelect(formProgramme, active, 'Select programme');
    fillSelect(query('[data-class-programme]'), active, 'Select programme');
    fillSelect(query('[data-teacher-programme]'), active, 'Select programme');
  }

  function fillSemesters() {
    const active = options.semesters.filter((item) => Number(item.isActive));
    fillSelect(semesterFilter, active, 'All semesters', 'id', 'label');
    fillSelect(formSemester, active, 'Select semester', 'id', 'label');
    fillSelect(query('[data-class-semester]'), active, 'Select semester', 'id', 'label');
    fillSelect(query('[data-teacher-semester]'), active, 'Select semester', 'id', 'label');
  }

  function fillTeachers() {
    const teacherSelect = query('[data-teacher-select]');
    const formSelect = formTeacher;
    fillSelect(teacherSelect, options.teachers.map((item) => ({ ...item, label: `${item.name} · ${item.teacherId}` })), 'Select active teacher', 'userId', 'label');
    fillSelect(formSelect, options.teachers.map((item) => ({ ...item, label: `${item.name} · ${item.teacherId}` })), 'Select teacher', 'userId', 'label');
    formSelect.disabled = true;
  }

  function fillStudents() {
    const select = query('[data-student-select]');
    fillSelect(select, options.students.map((item) => ({ ...item, label: `${item.name} · ${item.studentId}` })), 'Select student', 'studentProfileId', 'label');
  }

  async function loadOptions() {
    options = await request('/api/admin/subjects/options');
    fillProgrammeFilters();
    fillSemesters();
    fillTeachers();
    fillStudents();
    refreshBranches(programmeFilter, branchFilter, 'All branches');
    refreshBranches(query('[data-form-programme]'), formBranch, 'Select branch or specialisation');
    refreshBranches(query('[data-class-programme]'), query('[data-class-branch]'), 'Select branch');
    refreshBranches(query('[data-teacher-programme]'), query('[data-teacher-branch]'), 'Select branch');
  }

  function programmeOptions(programmeId) {
    if (!programmeId) return [];
    return options.branches.filter((item) => Number(item.programmeId) === Number(programmeId) && Number(item.isActive));
  }

  function refreshBranches(programmeSelect, branchSelect, placeholder) {
    const branches = programmeOptions(programmeSelect.value);
    fillSelect(branchSelect, branches.map((item) => ({ ...item, label: `${item.parentOptionId ? '— ' : ''}${item.name}` })), placeholder, 'id', 'label');
    branchSelect.disabled = branches.length === 0;
    branchSelect.required = branches.length > 0;
  }

  function refreshSections(programmeSelect, branchSelect, sectionSelect) {
    const programmeId = Number(programmeSelect.value);
    const branchId = Number(branchSelect.value);
    const selectedBranch = options.branches.find((item) => Number(item.id) === branchId);
    const validBranchIds = new Set([branchId, Number(selectedBranch?.parentOptionId)].filter(Boolean));
    const sections = options.sections.filter((item) => Number(item.programmeId) === programmeId
      && Number(item.isActive)
      && (item.branchOptionId == null || !branchId || validBranchIds.has(Number(item.branchOptionId))));
    fillSelect(sectionSelect, sections, sections.length ? 'Select class / section' : 'No configured classes');
    sectionSelect.disabled = !sections.length;
  }

  function filteredCourses(programmeId, branchId, semesterId) {
    const availableBranches = programmeOptions(programmeId);
    if (availableBranches.length && !Number(branchId)) return [];
    const selectedBranch = options.branches.find((item) => Number(item.id) === Number(branchId));
    const validBranchIds = new Set([Number(branchId), Number(selectedBranch?.parentOptionId)].filter(Boolean));
    return options.curriculumSubjects.filter((item) => Number(item.programmeId) === Number(programmeId)
      && Number(item.semesterId) === Number(semesterId)
      && (!item.branchOptionId || validBranchIds.has(Number(item.branchOptionId))));
  }

  function refreshCourseSelect(select, programmeId, branchId, semesterId, multiple = false) {
    const courses = programmeId && semesterId ? filteredCourses(programmeId, branchId, semesterId) : [];
    fillSelect(select, courses.map((item) => ({ ...item, label: `${item.courseCode ? `${item.courseCode} · ` : ''}${item.courseName}${item.credits == null ? '' : ` · ${item.credits} cr`}` })),
      courses.length ? (multiple ? 'Choose course(s)' : 'Select course') : 'No matching records available',
      'curriculumSubjectId', 'label');
    select.multiple = multiple;
    select.disabled = courses.length === 0;
    return courses;
  }

  function renderStats(stats) {
    for (const [key, value] of Object.entries(stats || {})) {
      const element = query(`[data-stat="${key}"]`);
      if (element) element.textContent = Number(value || 0).toLocaleString();
    }
  }

  function actionButton(label, action, id) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'subject-icon-action';
    button.textContent = label;
    button.setAttribute('aria-label', `${action} subject`);
    button.addEventListener('click', () => action(id));
    return button;
  }

  function renderSubjects(subjects) {
    rows.replaceChildren();
    if (!subjects.length) {
      const row = document.createElement('tr');
      const cell = textElement('td', 'No subject records match these filters yet. Add a subject or review the curriculum import preview.', 'empty-row');
      cell.colSpan = 8;
      row.append(cell);
      rows.append(row);
      return;
    }
    for (const subject of subjects) {
      const row = document.createElement('tr');
      const course = document.createElement('td');
      course.append(textElement('strong', subject.courseName, 'subject-course-name'));
      course.append(textElement('small', subject.category || subject.recordStatus.replaceAll('_', ' '), 'subject-record-meta'));
      const code = textElement('td', subject.courseCode || '—');
      code.className = 'code-cell';
      const credits = textElement('td', subject.credits == null ? subject.creditsRaw || '—' : subject.credits);
      const placement = textElement('td', [subject.programmeName, subject.branchName].filter(Boolean).join(' · ') || 'Programme not assigned');
      const semester = textElement('td', subject.semesterName || subject.semesterLabel || '—');
      const classCount = textElement('td', subject.classAssignmentCount || '0');
      const teacherCount = textElement('td', subject.teacherAssignmentCount || '0');
      const actions = document.createElement('td');
      actions.className = 'subject-row-actions';
      actions.append(actionButton('◉', viewSubject, subject.id));
      actions.append(actionButton('✎', editSubject, subject.id));
      actions.append(actionButton('⋯', deactivateSubject, subject.id));
      row.append(course, code, credits, placement, semester, classCount, teacherCount, actions);
      rows.append(row);
    }
  }

  async function loadSubjects() {
    const params = new URLSearchParams({ page: String(page) });
    if (search.value.trim()) params.set('search', search.value.trim());
    if (programmeFilter.value) params.set('programmeId', programmeFilter.value);
    if (branchFilter.value) params.set('branchOptionId', branchFilter.value);
    if (semesterFilter.value) params.set('semesterId', semesterFilter.value);
    if (creditsFilter.value) params.set('credits', creditsFilter.value);
    const data = await request(`/api/admin/subjects?${params}`);
    renderSubjects(data.subjects);
    totalPages = data.totalPages;
    query('[data-page-summary]').textContent = data.total
      ? `Showing ${(data.page - 1) * data.pageSize + 1}–${Math.min(data.page * data.pageSize, data.total)} of ${data.total} records`
      : 'No records';
    query('[data-page-number]').textContent = String(data.page);
    query('[data-page-prev]').disabled = page <= 1;
    query('[data-page-next]').disabled = page >= totalPages;
  }

  async function loadStats() {
    const data = await request('/api/admin/subjects/stats');
    renderStats(data.stats);
  }

  function setModalOpen(open) {
    modal.hidden = !open;
    document.body.classList.toggle('modal-open', open || !detail.hidden);
    if (open) query('input[name="courseName"]', form).focus();
  }

  function closeModal() {
    setModalOpen(false);
    form.reset();
    form.dataset.subjectId = '';
    query('[data-subject-modal] h2').textContent = 'Add new subject';
    query('[data-subject-error]').textContent = '';
    refreshBranches(formProgramme, formBranch, 'Select branch or specialisation');
    refreshSections(formProgramme, formBranch, formSection);
    formTeacher.disabled = true;
  }

  function closeDetail() {
    detail.hidden = true;
    document.body.classList.toggle('modal-open', !modal.hidden);
  }

  function openNewSubject() {
    closeModal();
    setModalOpen(true);
  }

  async function viewSubject(subjectId) {
    try {
      const data = await request(`/api/admin/subjects/${subjectId}`);
      query('[data-detail-name]').textContent = data.subject.courseName;
      const content = query('[data-detail-content]');
      content.replaceChildren();
      const fields = [
        ['Course code', data.subject.courseCode || '—'],
        ['Credits', data.subject.credits ?? data.subject.creditsRaw ?? '—'],
        ['Programme', data.subject.programmeName || 'Not assigned'],
        ['Branch / specialisation', data.subject.branchName || '—'],
        ['Semester', data.subject.semesterName || data.subject.semesterLabel || '—'],
        ['Category', data.subject.category || '—'],
        ['Record status', data.subject.recordStatus],
        ['Source', data.subject.sourceUrl || 'Manually entered'],
        ['Notes', data.subject.notes || '—'],
      ];
      for (const [label, value] of fields) {
        content.append(textElement('dt', label), textElement('dd', value));
      }
      detail.hidden = false;
      document.body.classList.add('modal-open');
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  }

  async function editSubject(subjectId) {
    try {
      const data = await request(`/api/admin/subjects/${subjectId}`);
      closeModal();
      form.dataset.subjectId = String(subjectId);
      query('[data-subject-modal] h2').textContent = 'Edit subject';
      form.elements.courseName.value = data.subject.courseName;
      form.elements.courseCode.value = data.subject.courseCode || '';
      form.elements.credits.value = data.subject.credits ?? '';
      formProgramme.value = data.subject.programmeId || '';
      refreshBranches(formProgramme, formBranch, 'Select branch or specialisation');
      formBranch.value = data.subject.branchOptionId || '';
      formSemester.value = data.subject.semesterId || '';
      refreshSections(formProgramme, formBranch, formSection);
      setModalOpen(true);
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  }

  async function deactivateSubject(subjectId) {
    if (!window.confirm('Deactivate this subject? Existing assignment records will be preserved.')) return;
    try {
      const data = await request(`/api/admin/subjects/${subjectId}`, { method: 'DELETE' });
      setMessage(message, data.message, 'success');
      await Promise.all([loadSubjects(), loadStats(), loadOptions()]);
    } catch (error) {
      setMessage(message, error.message, 'error');
    }
  }

  async function submitSubject(event) {
    event.preventDefault();
    const button = query('[type="submit"]', form);
    button.disabled = true;
    try {
      const body = Object.fromEntries(new FormData(form));
      body.credits = Number(body.credits);
      for (const key of ['programmeId', 'branchOptionId', 'semesterId', 'sectionId', 'teacherUserId']) {
        if (body[key]) body[key] = Number(body[key]);
        else delete body[key];
      }
      const subjectId = form.dataset.subjectId;
      const data = await request(subjectId ? `/api/admin/subjects/${subjectId}` : '/api/admin/subjects', {
        method: subjectId ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      closeModal();
      setMessage(message, data.message, 'success');
      await Promise.all([loadSubjects(), loadStats(), loadOptions()]);
    } catch (error) {
      query('[data-subject-error]').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  function renderAssignmentList(data) {
    assignmentRecords.replaceChildren();
    const assignments = data.assignments || [];
    if (!assignments.length) {
      assignmentRecords.append(textElement('p', 'No assignments are available for this tab yet.', 'assignment-empty'));
      return;
    }
    for (const assignment of assignments) {
      const card = document.createElement('article');
      card.className = 'assignment-record';
      const heading = activeAssignmentType === 'teacher'
        ? `${assignment.courseName} · ${assignment.teacherName}`
        : activeAssignmentType === 'student'
          ? `${assignment.courseName} · ${assignment.studentName}`
          : `${assignment.courseName} · ${assignment.sectionName}`;
      const context = [assignment.programmeName, assignment.sectionName, assignment.semesterName, assignment.action].filter(Boolean).join(' · ');
      card.append(textElement('strong', heading), textElement('small', context));
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary-button';
      remove.textContent = 'Remove';
      remove.addEventListener('click', async () => {
        try {
          await request(`/api/admin/subjects/assignments/${activeAssignmentType}/${assignment.id}`, { method: 'DELETE' });
          await loadAssignments();
          setMessage(assignmentMessage, 'Assignment removed.', 'success');
        } catch (error) {
          setMessage(assignmentMessage, error.message, 'error');
        }
      });
      card.append(remove);
      assignmentRecords.append(card);
    }
  }

  async function loadAssignments() {
    const data = await request(`/api/admin/subjects/assignments?type=${activeAssignmentType}`);
    renderAssignmentList(data);
  }

  async function submitAssignment(event, type) {
    event.preventDefault();
    const formNode = event.currentTarget;
    const body = Object.fromEntries(new FormData(formNode));
    let endpoint = `/api/admin/subjects/assignments/${type}`;
    if (type === 'class' || type === 'teacher') {
      body.curriculumSubjectIds = new FormData(formNode).getAll('curriculumSubjectIds').filter(Boolean).map(Number);
      body.sectionId = Number(body.sectionId);
      body.semesterId = Number(formNode.querySelector(type === 'class' ? '[data-class-semester]' : '[data-teacher-semester]').value);
      if (type === 'teacher') body.teacherUserId = Number(body.teacherUserId);
    } else {
      body.studentProfileId = Number(body.studentProfileId);
      body.curriculumSubjectId = Number(body.curriculumSubjectId);
    }
    try {
      const data = await request(endpoint, { method: 'POST', body: JSON.stringify(body) });
      formNode.reset();
      setMessage(assignmentMessage, data.message, 'success');
      await Promise.all([loadAssignments(), loadOptions()]);
    } catch (error) {
      setMessage(assignmentMessage, error.message, 'error');
    }
  }

  function updateAssignmentTab(type) {
    activeAssignmentType = type;
    document.querySelectorAll('[data-assignment-tab]').forEach((button) => {
      const selected = button.dataset.assignmentTab === type;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-assignment-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.assignmentPanel !== type;
    });
    loadAssignments().catch((error) => setMessage(assignmentMessage, error.message, 'error'));
  }

  function clearFilters() {
    search.value = '';
    programmeFilter.value = '';
    refreshBranches(programmeFilter, branchFilter, 'All branches');
    semesterFilter.value = '';
    creditsFilter.value = '';
    page = 1;
    loadSubjects().catch((error) => setMessage(message, error.message, 'error'));
  }

  query('[data-open-subject]').addEventListener('click', openNewSubject);
  document.querySelectorAll('[data-close-subject]').forEach((button) => button.addEventListener('click', closeModal));
  modal.addEventListener('click', (event) => { if (event.target === modal) closeModal(); });
  form.addEventListener('submit', submitSubject);
  query('[data-close-detail]').addEventListener('click', closeDetail);
  detail.addEventListener('click', (event) => { if (event.target === detail) closeDetail(); });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (!modal.hidden) closeModal();
      if (!detail.hidden) closeDetail();
    }
  });
  query('[data-clear]').addEventListener('click', clearFilters);
  search.addEventListener('input', () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => {
      page = 1;
      loadSubjects().catch((error) => setMessage(message, error.message, 'error'));
    }, 180);
  });
  for (const filter of [programmeFilter, branchFilter, semesterFilter, creditsFilter]) {
    filter.addEventListener('change', () => {
      if (filter === programmeFilter) refreshBranches(programmeFilter, branchFilter, 'All branches');
      page = 1;
      loadSubjects().catch((error) => setMessage(message, error.message, 'error'));
    });
  }
  query('[data-page-prev]').addEventListener('click', () => {
    page = Math.max(1, page - 1);
    loadSubjects().catch((error) => setMessage(message, error.message, 'error'));
  });
  query('[data-page-next]').addEventListener('click', () => {
    page = Math.min(totalPages, page + 1);
    loadSubjects().catch((error) => setMessage(message, error.message, 'error'));
  });

  formProgramme.addEventListener('change', () => {
    refreshBranches(formProgramme, formBranch, 'Select branch or specialisation');
    refreshSections(formProgramme, formBranch, formSection);
    formTeacher.disabled = true;
    formTeacher.value = '';
  });
  formBranch.addEventListener('change', () => refreshSections(formProgramme, formBranch, formSection));
  formSection.addEventListener('change', () => {
    formTeacher.disabled = !formSection.value;
    if (!formTeacher.value && options.teachers.length) formTeacher.value = '';
  });

  const classProgramme = query('[data-class-programme]');
  const classBranch = query('[data-class-branch]');
  const classSemester = query('[data-class-semester]');
  const classSection = query('[data-class-section]');
  const classSubjects = query('[data-class-subjects]');
  classProgramme.addEventListener('change', () => {
    refreshBranches(classProgramme, classBranch, 'Select branch');
    refreshSections(classProgramme, classBranch, classSection);
    refreshCourseSelect(classSubjects, classProgramme.value, '', classSemester.value, true);
  });
  classBranch.addEventListener('change', () => {
    refreshSections(classProgramme, classBranch, classSection);
    refreshCourseSelect(classSubjects, classProgramme.value, classBranch.value, classSemester.value, true);
  });
  classSemester.addEventListener('change', () => refreshCourseSelect(classSubjects, classProgramme.value, classBranch.value, classSemester.value, true));

  const teacherProgramme = query('[data-teacher-programme]');
  const teacherBranch = query('[data-teacher-branch]');
  const teacherSemester = query('[data-teacher-semester]');
  const teacherSection = query('[data-teacher-section]');
  const teacherSubjects = query('[data-teacher-subjects]');
  teacherProgramme.addEventListener('change', () => {
    refreshBranches(teacherProgramme, teacherBranch, 'Select branch');
    refreshSections(teacherProgramme, teacherBranch, teacherSection);
    refreshCourseSelect(teacherSubjects, teacherProgramme.value, '', teacherSemester.value, true);
  });
  teacherBranch.addEventListener('change', () => {
    refreshSections(teacherProgramme, teacherBranch, teacherSection);
    refreshCourseSelect(teacherSubjects, teacherProgramme.value, teacherBranch.value, teacherSemester.value, true);
  });
  teacherSemester.addEventListener('change', () => refreshCourseSelect(teacherSubjects, teacherProgramme.value, teacherBranch.value, teacherSemester.value, true));

  query('[data-student-select]').addEventListener('change', (event) => {
    const student = options.students.find((item) => Number(item.studentProfileId) === Number(event.target.value));
    const select = query('[data-student-subject]');
    if (!student) {
      fillSelect(select, [], 'Select student first');
      select.disabled = true;
      return;
    }
    const courses = options.curriculumSubjects.filter((item) => Number(item.programmeId) === Number(student.programmeId)
      && Number(item.semesterId) === Number(student.semesterId)
      && (!item.branchOptionId || Number(item.branchOptionId) === Number(student.branchOptionId)
        || Number(options.branches.find((branch) => Number(branch.id) === Number(item.branchOptionId))?.parentOptionId) === Number(student.branchOptionId)));
    fillSelect(select, courses.map((item) => ({ ...item, label: `${item.courseCode ? `${item.courseCode} · ` : ''}${item.courseName}` })),
      courses.length ? 'Select course' : 'No course records for this student placement', 'curriculumSubjectId', 'label');
    select.disabled = courses.length === 0;
  });

  query('[data-class-assignment-form]').addEventListener('submit', (event) => submitAssignment(event, 'class'));
  query('[data-teacher-assignment-form]').addEventListener('submit', (event) => submitAssignment(event, 'teacher'));
  query('[data-student-assignment-form]').addEventListener('submit', (event) => submitAssignment(event, 'student'));
  document.querySelectorAll('[data-assignment-tab]').forEach((button) => {
    button.addEventListener('click', () => updateAssignmentTab(button.dataset.assignmentTab));
  });

  loadOptions()
    .then(() => Promise.all([loadStats(), loadSubjects(), loadAssignments()]))
    .catch((error) => {
      rows.replaceChildren();
      const row = document.createElement('tr');
      const cell = textElement('td', `Subject Management could not load its database options. ${error.message}`, 'empty-row');
      cell.colSpan = 8;
      row.append(cell);
      rows.append(row);
      setMessage(message, error.message, 'error');
    });
})();
