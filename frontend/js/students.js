(() => {
  const rows = document.querySelector('[data-student-rows]');
  if (!rows) return;

  const message = document.querySelector('[data-message]');
  const search = document.querySelector('[data-search]');
  const programmeFilter = document.querySelector('[data-filter-programme]');
  const branchFilter = document.querySelector('[data-filter-branch]');
  const semesterFilter = document.querySelector('[data-filter-semester]');
  const sectionFilter = document.querySelector('[data-filter-section]');
  const statusFilter = document.querySelector('[data-filter-status]');
  const modal = document.querySelector('[data-student-modal]');
  const form = document.querySelector('[data-student-form]');
  const programSelect = document.querySelector('[data-form-programme]');
  const branchSelect = document.querySelector('[data-form-branch]');
  const specialisationSelect = document.querySelector('[data-form-specialisation]');
  const sectionSelect = document.querySelector('[data-form-section]');
  const enrolledInput = document.querySelector('[data-enrolled-year]');
  const graduationSelect = document.querySelector('[data-graduation-year]');
  const semesterOutput = document.querySelector('[data-current-semester]');
  const calendarNote = document.querySelector('[data-calendar-note]');
  const branchField = document.querySelector('[data-branch-field]');
  const specialisationField = document.querySelector('[data-specialisation-field]');
  let structure = null;
  let page = 1;
  let totalPages = 1;
  let searchTimer;

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = `teacher-message${type ? ` ${type}` : ''}`;
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const contentType = response.headers.get('content-type') || '';
    if (response.redirected || !contentType.includes('application/json')) {
      throw new Error('The server did not return student data. Your session may have expired.');
    }
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  function textElement(tag, value, className = '') {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function optionElement(select, value, label) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    select.append(option);
  }

  function fillFilterOptions() {
    programmeFilter.replaceChildren();
    optionElement(programmeFilter, '', 'All programmes');
    for (const programme of structure.programmes.filter((item) => Number(item.isActive))) {
      optionElement(programmeFilter, programme.id, programme.name);
    }

    semesterFilter.replaceChildren();
    optionElement(semesterFilter, '', 'All semesters');
    for (const semester of structure.semesters.filter((item) => Number(item.isActive))) {
      optionElement(semesterFilter, semester.id, semester.label);
    }
  }

  async function loadStructure() {
    structure = await request('/api/admin/academic-structure');
    fillFilterOptions();
    document.querySelector('[data-form-programme]').replaceChildren();
    optionElement(programSelect, '', 'Select programme');
    for (const programme of structure.programmes.filter((item) => Number(item.isActive))) {
      optionElement(programSelect, programme.id, programme.name);
    }
    updateFilterBranches();
    updateFilterSections();
  }

  function updateFilterBranches() {
    const programmeId = Number(programmeFilter.value);
    const options = programmeId
      ? structure.options.filter((item) => Number(item.programmeId) === programmeId && item.parentOptionId == null && Number(item.isActive) && ['branch', 'major'].includes(item.type))
      : [];
    branchFilter.replaceChildren();
    optionElement(branchFilter, '', 'All branches / majors');
    for (const option of options) optionElement(branchFilter, option.id, option.name);
    branchFilter.disabled = !programmeId || !options.length;
    if (branchFilter.disabled) branchFilter.value = '';
  }

  function updateFilterSections() {
    const programmeId = Number(programmeFilter.value);
    const branchId = Number(branchFilter.value);
    const options = programmeId
      ? structure.sections.filter((section) => Number(section.programmeId) === programmeId
        && Number(section.isActive)
        && (section.branchOptionId == null || !branchId || Number(section.branchOptionId) === branchId))
      : [];
    sectionFilter.replaceChildren();
    optionElement(sectionFilter, '', 'All sections');
    for (const section of options) optionElement(sectionFilter, section.id, section.name);
    sectionFilter.disabled = !programmeId || !options.length;
    if (sectionFilter.disabled) sectionFilter.value = '';
  }

  function formProgram() {
    return structure.programmes.find((programme) => Number(programme.id) === Number(programSelect.value));
  }

  function formOptions() {
    const programme = formProgram();
    if (!programme) return [];
    return structure.options.filter((option) => Number(option.programmeId) === Number(programme.id)
      && option.parentOptionId == null
      && Number(option.isActive)
      && ['branch', 'major'].includes(option.type));
  }

  function updateGraduationYears(preserve = true) {
    const programme = formProgram();
    const enrolledYear = Number(enrolledInput.value);
    const previous = graduationSelect.value;
    graduationSelect.replaceChildren();
    graduationSelect.disabled = true;
    if (!programme || !Number.isInteger(enrolledYear) || enrolledYear < 2000 || enrolledYear > 2200) {
      optionElement(graduationSelect, '', 'Select programme and enrolled year');
      return;
    }
    optionElement(graduationSelect, '', 'Select expected year');
    for (let duration = Number(programme.minDurationYears); duration <= Number(programme.maxDurationYears); duration += 1) {
      optionElement(graduationSelect, enrolledYear + duration, String(enrolledYear + duration));
    }
    graduationSelect.disabled = false;
    if (preserve && [...graduationSelect.options].some((option) => option.value === previous)) {
      graduationSelect.value = previous;
    }
  }

  function updateSemesterPreview() {
    semesterOutput.setCustomValidity('');
    const programme = formProgram();
    const enrolledYear = Number(enrolledInput.value);
    const graduationYear = Number(graduationSelect.value);
    if (!structure?.activeCalendar) {
      semesterOutput.value = 'Calendar not configured';
      semesterOutput.setCustomValidity('An administrator must configure the active academic year and term.');
      calendarNote.textContent = 'No active academic calendar is configured. Ask an administrator to set the current academic year and term.';
      return;
    }
    calendarNote.textContent = `Academic year ${structure.activeCalendar.academicYearLabel} · ${structure.activeCalendar.termKey === 'odd' ? 'Odd semester (July–December)' : 'Even semester (January–June)'}.`;
    if (!programme || !Number.isInteger(enrolledYear) || !graduationYear) {
      semesterOutput.value = 'Select programme and enrolment details';
      return;
    }
    const semesterNumber = (Number(structure.activeCalendar.startYear) - enrolledYear) * 2
      + (structure.activeCalendar.termKey === 'odd' ? 1 : 2);
    const maximumSemester = (graduationYear - enrolledYear) * 2;
    if (semesterNumber < 1 || semesterNumber > maximumSemester || semesterNumber > 10) {
      semesterOutput.value = 'Outside programme duration';
      semesterOutput.setCustomValidity('The current academic calendar places this student outside the selected programme duration.');
      return;
    }
    const semester = structure.semesters.find((item) => Number(item.semesterNumber) === semesterNumber && Number(item.isActive));
    if (!semester) {
      semesterOutput.value = `Semester ${semesterNumber} is not configured`;
      semesterOutput.setCustomValidity(`Semester ${semesterNumber} is inactive in the academic structure.`);
      return;
    }
    semesterOutput.value = `${semester.label} · ${structure.activeCalendar.academicYearLabel}`;
  }

  function updateFormSections() {
    const programme = formProgram();
    const branchId = Number(branchSelect.value);
    const sections = programme
      ? structure.sections.filter((item) => Number(item.programmeId) === Number(programme.id)
        && Number(item.isActive)
        && (item.branchOptionId == null || Number(item.branchOptionId) === branchId))
      : [];
    sectionSelect.replaceChildren();
    optionElement(sectionSelect, '', sections.length ? 'Select section' : 'No sections configured');
    for (const section of sections) optionElement(sectionSelect, section.id, section.name);
    sectionSelect.disabled = sections.length === 0;
  }

  function updateFormSpecialisations() {
    const programme = formProgram();
    const branchId = Number(branchSelect.value);
    const options = programme && branchId
      ? structure.options.filter((item) => Number(item.programmeId) === Number(programme.id)
        && Number(item.parentOptionId) === branchId
        && item.type === 'specialisation'
        && Number(item.isActive))
      : [];
    specialisationField.hidden = options.length === 0;
    specialisationSelect.replaceChildren();
    optionElement(specialisationSelect, '', 'No specialisation');
    for (const option of options) optionElement(specialisationSelect, option.id, option.name);
    specialisationSelect.disabled = options.length === 0;
    if (!options.length) specialisationSelect.value = '';
  }

  function handleProgrammeChange() {
    const options = formOptions();
    branchField.hidden = options.length === 0;
    branchSelect.required = options.length > 0;
    branchSelect.disabled = options.length === 0;
    branchSelect.replaceChildren();
    optionElement(branchSelect, '', options.length ? 'Select branch / major' : 'Not required for this programme');
    for (const option of options) optionElement(branchSelect, option.id, option.name);
    specialisationSelect.value = '';
    specialisationField.hidden = true;
    specialisationSelect.disabled = true;
    specialisationSelect.required = false;
    updateFormSections();
    updateGraduationYears(false);
    updateSemesterPreview();
  }

  function handleBranchChange() {
    specialisationSelect.value = '';
    updateFormSpecialisations();
    updateFormSections();
  }

  function initials(name) {
    return String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase() || '—';
  }

  function addActions(cell, student) {
    cell.className = 'teacher-row-actions';
    const viewButton = textElement('button', 'View', 'view-teacher');
    viewButton.type = 'button';
    viewButton.addEventListener('click', () => showDetails(student.id));
    cell.append(viewButton);
    const editButton = textElement('button', 'Edit', 'view-teacher');
    editButton.type = 'button';
    editButton.addEventListener('click', () => openEdit(student.id));
    cell.append(editButton);
  }

  function renderStudent(student) {
    const row = document.createElement('tr');
    const identity = document.createElement('td');
    const avatar = textElement('span', initials(student.name), 'teacher-avatar');
    const copy = document.createElement('span');
    copy.className = 'teacher-identity';
    copy.append(textElement('strong', student.name), textElement('small', student.email));
    identity.append(avatar, copy);
    const programmeCopy = document.createElement('span');
    programmeCopy.className = 'student-programme-copy';
    programmeCopy.append(textElement('strong', student.programmeName || 'Not assigned'));
    if (student.branchName) programmeCopy.append(textElement('small', student.branchName));
    if (student.specialisationName) programmeCopy.append(textElement('small', student.specialisationName));
    row.append(
      identity,
      textElement('td', student.studentId),
      textElement('td', student.contactNumber || '—'),
      (() => { const cell = document.createElement('td'); cell.append(programmeCopy); return cell; })(),
      textElement('td', student.semesterName || '—'),
      textElement('td', student.sectionName || '—'),
    );
    const labels = { active: 'Active', inactive: 'Inactive', not_linked: 'Account not linked' };
    row.append(textElement('td', '', ''));
    const statusCell = row.lastElementChild;
    statusCell.append(textElement('span', labels[student.status] || 'Unknown', `status-pill ${student.status === 'not_linked' ? 'invitation' : student.status}`));
    const actions = document.createElement('td');
    addActions(actions, student);
    row.append(actions);
    return row;
  }

  async function loadStudents() {
    const params = new URLSearchParams({ page: String(page) });
    if (search.value.trim()) params.set('search', search.value.trim());
    if (programmeFilter.value) params.set('programme', programmeFilter.value);
    if (branchFilter.value) params.set('branch', branchFilter.value);
    if (semesterFilter.value) params.set('semester', semesterFilter.value);
    if (sectionFilter.value) params.set('section', sectionFilter.value);
    if (statusFilter.value) params.set('status', statusFilter.value);
    try {
      const data = await request(`/api/admin/students?${params}`);
      if (!Array.isArray(data.students)) throw new Error('The student list response is missing its records.');
      totalPages = Math.max(1, Number(data.totalPages) || 1);
      rows.replaceChildren();
      if (!data.students.length) {
        const row = document.createElement('tr');
        row.append(textElement('td', 'No student records match the current filters.', 'empty-row'));
        row.firstElementChild.colSpan = 8;
        rows.append(row);
      } else {
        data.students.forEach((student) => rows.append(renderStudent(student)));
      }
      const first = data.total ? (page - 1) * data.pageSize + 1 : 0;
      const last = Math.min(page * data.pageSize, data.total);
      document.querySelector('[data-page-summary]').textContent = `Showing ${first}–${last} of ${data.total} records`;
      document.querySelector('[data-page-number]').textContent = `${page} / ${totalPages}`;
      document.querySelector('[data-page-prev]').disabled = page <= 1;
      document.querySelector('[data-page-next]').disabled = page >= totalPages;
    } catch (error) {
      rows.replaceChildren();
      const row = document.createElement('tr');
      row.append(textElement('td', 'Student records could not be loaded. Please retry.', 'empty-row'));
      row.firstElementChild.colSpan = 8;
      rows.append(row);
      setMessage(error.message, 'error');
    }
  }

  async function loadStats() {
    try {
      const { stats } = await request('/api/admin/students/stats');
      for (const [key, value] of Object.entries(stats)) {
        const element = document.querySelector(`[data-stat="${key}"]`);
        if (element) element.textContent = value;
      }
    } catch (error) {
      setMessage(`Student statistics could not be loaded. ${error.message}`, 'error');
    }
  }

  function setModalOpen(open) {
    modal.hidden = !open;
    document.body.classList.toggle('modal-open', open || !document.querySelector('[data-student-detail]').hidden);
    if (open) form.elements.name.focus();
  }

  function resetForm() {
    form.reset();
    form.dataset.profileId = '';
    document.querySelector('[data-student-error]').textContent = '';
    document.querySelector('[data-student-modal] .eyebrow').textContent = 'New record';
    document.querySelector('#student-modal-title').textContent = 'Add new student';
    handleProgrammeChange();
  }

  function populateForm(student) {
    resetForm();
    document.querySelector('[data-student-modal] .eyebrow').textContent = 'Student record';
    document.querySelector('#student-modal-title').textContent = `Edit ${student.name}`;
    form.dataset.profileId = student.id;
    form.elements.name.value = student.name || '';
    form.elements.studentId.value = student.studentId || '';
    form.elements.email.value = student.email || '';
    form.elements.contactNumber.value = student.contactNumber || '';
    programSelect.value = student.programmeId || '';
    handleProgrammeChange();
    enrolledInput.value = student.enrolledYear || '';
    updateGraduationYears(false);
    branchSelect.value = student.branchOptionId || '';
    handleBranchChange();
    specialisationSelect.value = student.specialisationOptionId || '';
    sectionSelect.value = student.sectionId || '';
    graduationSelect.value = student.expectedGraduationYear || '';
    updateSemesterPreview();
  }

  function collectFormData() {
    const data = Object.fromEntries(new FormData(form));
    for (const key of ['programmeId', 'branchOptionId', 'specialisationOptionId', 'sectionId']) {
      data[key] = data[key] || null;
    }
    data.enrolledYear = Number(data.enrolledYear);
    data.expectedGraduationYear = Number(data.expectedGraduationYear);
    return data;
  }

  async function openEdit(id) {
    try {
      const { student } = await request(`/api/admin/students/${encodeURIComponent(id)}`);
      populateForm(student);
      setModalOpen(true);
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  async function showDetails(id) {
    try {
      const { student } = await request(`/api/admin/students/${encodeURIComponent(id)}`);
      document.querySelector('[data-detail-name]').textContent = student.name;
      const details = document.querySelector('[data-detail-content]');
      details.replaceChildren();
      const fields = [
        ['Student ID', student.studentId], ['Email', student.email],
        ['Contact number', student.contactNumber], ['Degree / programme', student.programmeName],
        ['Branch / major', student.branchName], ['Specialisation', student.specialisationName],
        ['Enrolled year', student.enrolledYear], ['Expected graduation year', student.expectedGraduationYear],
        ['Current semester', student.semesterName], ['Section', student.sectionName],
        ['Account status', student.status === 'not_linked' ? 'Account not linked' : student.status],
      ];
      for (const [label, value] of fields) {
        details.append(textElement('dt', label), textElement('dd', value ?? 'Not provided'));
      }
      const detailModal = document.querySelector('[data-student-detail]');
      detailModal.hidden = false;
      document.body.classList.add('modal-open');
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  async function refresh() {
    await Promise.all([loadStats(), loadStudents()]);
  }

  programSelect.addEventListener('change', handleProgrammeChange);
  branchSelect.addEventListener('change', handleBranchChange);
  specialisationSelect.addEventListener('change', updateFormSections);
  enrolledInput.addEventListener('input', () => { updateGraduationYears(false); updateSemesterPreview(); });
  graduationSelect.addEventListener('change', updateSemesterPreview);

  programmeFilter.addEventListener('change', () => {
    updateFilterBranches();
    updateFilterSections();
    page = 1;
    loadStudents();
  });
  branchFilter.addEventListener('change', () => {
    updateFilterSections();
    page = 1;
    loadStudents();
  });
  [semesterFilter, sectionFilter, statusFilter].forEach((select) => select.addEventListener('change', () => { page = 1; loadStudents(); }));
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { page = 1; loadStudents(); }, 200);
  });

  document.querySelector('[data-clear]').addEventListener('click', () => {
    search.value = '';
    programmeFilter.value = '';
    branchFilter.value = '';
    semesterFilter.value = '';
    sectionFilter.value = '';
    statusFilter.value = '';
    updateFilterBranches();
    updateFilterSections();
    page = 1;
    loadStudents();
  });
  document.querySelector('[data-page-prev]').addEventListener('click', () => {
    if (page > 1) { page -= 1; loadStudents(); }
  });
  document.querySelector('[data-page-next]').addEventListener('click', () => {
    if (page < totalPages) { page += 1; loadStudents(); }
  });
  document.querySelector('[data-open-student]').addEventListener('click', () => {
    resetForm();
    setModalOpen(true);
  });
  document.querySelectorAll('[data-close-student]').forEach((button) => button.addEventListener('click', () => setModalOpen(false)));
  modal.addEventListener('click', (event) => {
    if (event.target === modal) setModalOpen(false);
  });
  const detailModal = document.querySelector('[data-student-detail]');
  const closeDetails = () => {
    detailModal.hidden = true;
    document.body.classList.toggle('modal-open', !modal.hidden);
  };
  document.querySelector('[data-close-student-detail]').addEventListener('click', closeDetails);
  detailModal.addEventListener('click', (event) => { if (event.target === detailModal) closeDetails(); });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!detailModal.hidden) closeDetails();
    else if (!modal.hidden) setModalOpen(false);
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector('[data-student-error]');
    const submitButton = form.querySelector('[type="submit"]');
    errorBox.textContent = '';
    submitButton.disabled = true;
    try {
      const data = collectFormData();
      const profileId = form.dataset.profileId;
      const result = await request(profileId
        ? `/api/admin/students/${encodeURIComponent(profileId)}`
        : '/api/admin/students', {
        method: profileId ? 'PATCH' : 'POST',
        body: JSON.stringify(data),
      });
      setModalOpen(false);
      setMessage(result.message || (profileId ? 'Student record updated.' : 'Student record added.'), 'success');
      page = 1;
      await refresh();
    } catch (error) {
      errorBox.textContent = error.message || 'Could not save the student record.';
    } finally {
      submitButton.disabled = false;
    }
  });

  loadStructure().then(refresh).catch((error) => {
    rows.replaceChildren();
    const row = document.createElement('tr');
    row.append(textElement('td', `Academic structure could not be loaded. ${error.message}`, 'empty-row'));
    row.firstElementChild.colSpan = 8;
    rows.append(row);
    setMessage(error.message, 'error');
  });
})();
