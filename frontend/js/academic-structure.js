(() => {
  const message = document.querySelector('[data-structure-message]');
  let structure = null;

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      ...options,
      headers: {
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
    return data;
  }

  function element(tag, value, className = '') {
    const node = document.createElement(tag);
    node.textContent = value ?? '';
    if (className) node.className = className;
    return node;
  }

  function field(labelText, value, type = 'text', min, max) {
    const label = element('label', labelText);
    const input = document.createElement('input');
    input.type = type;
    input.value = value ?? '';
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    label.append(input);
    return { label, input };
  }

  function actionButton(label, className = 'secondary-button') {
    const button = element('button', label, className);
    button.type = 'button';
    return button;
  }

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = `teacher-message${type ? ` ${type}` : ''}`;
  }

  function fillProgrammeSelect(select, includePlaceholder = true) {
    select.replaceChildren();
    if (includePlaceholder) {
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = 'Select programme';
      select.append(empty);
    }
    for (const programme of structure.programmes.filter((item) => Number(item.isActive))) {
      const option = document.createElement('option');
      option.value = programme.id;
      option.textContent = programme.name;
      select.append(option);
    }
  }

  function renderProgrammes() {
    const container = document.querySelector('[data-programme-list]');
    container.replaceChildren();
    for (const programme of structure.programmes) {
      const row = document.createElement('form');
      row.className = 'structure-record';
      const name = field('Programme name', programme.name);
      const code = field('Code', programme.code);
      code.input.readOnly = true;
      const min = field('Minimum years', programme.minDurationYears, 'number', 1, 10);
      const max = field('Maximum years', programme.maxDurationYears, 'number', 1, 10);
      row.append(name.label, code.label, min.label, max.label);
      const controls = element('div', '', 'structure-record-actions');
      const save = actionButton('Save');
      save.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/programmes/${programme.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ name: name.input.value, minDurationYears: Number(min.input.value), maxDurationYears: Number(max.input.value) }),
          });
          await loadStructure();
          setMessage('Programme updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      const toggle = actionButton(Number(programme.isActive) ? 'Deactivate' : 'Activate', Number(programme.isActive) ? 'secondary-button warning-button' : 'secondary-button');
      toggle.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/programmes/${programme.id}`, {
            method: 'PATCH', body: JSON.stringify({ isActive: !Number(programme.isActive) }),
          });
          await loadStructure();
          setMessage('Programme status updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      controls.append(save, toggle);
      row.append(controls);
      container.append(row);
    }
    fillProgrammeSelect(document.querySelector('[data-option-programme]'));
    fillProgrammeSelect(document.querySelector('[data-section-programme]'));
    updateOptionParents();
    updateSectionBranches();
  }

  function renderOptions() {
    const container = document.querySelector('[data-option-list]');
    container.replaceChildren();
    const lookup = new Map(structure.options.map((option) => [Number(option.id), option]));
    for (const option of structure.options) {
      const row = document.createElement('div');
      row.className = 'structure-record structure-option-record';
      const name = field('Name', option.name);
      row.append(element('span', option.type.replace('_', ' '), 'structure-type'), name.label);
      const parent = option.parentOptionId ? lookup.get(Number(option.parentOptionId))?.name : option.programmeName;
      row.append(element('small', parent || 'Programme option', 'structure-record-parent'));
      const controls = element('div', '', 'structure-record-actions');
      const save = actionButton('Save');
      save.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/options/${option.id}`, {
            method: 'PATCH', body: JSON.stringify({ name: name.input.value }),
          });
          await loadStructure();
          setMessage('Academic option updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      const toggle = actionButton(Number(option.isActive) ? 'Deactivate' : 'Activate', Number(option.isActive) ? 'secondary-button warning-button' : 'secondary-button');
      toggle.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/options/${option.id}`, {
            method: 'PATCH', body: JSON.stringify({ isActive: !Number(option.isActive) }),
          });
          await loadStructure();
          setMessage('Academic option status updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      controls.append(save, toggle);
      row.append(controls);
      container.append(row);
    }
    updateOptionParents();
  }

  function renderYearsAndTerms() {
    const yearsContainer = document.querySelector('[data-year-list]');
    yearsContainer.replaceChildren();
    for (const year of structure.years) {
      const row = element('div', '', 'structure-list-row');
      const title = element('strong', year.label);
      const dates = element('small', `${year.startYear}–${year.endYear}`);
      const status = element('span', Number(year.isActive) ? 'Current academic year' : 'Inactive', Number(year.isActive) ? 'structure-status active' : 'structure-status');
      const action = actionButton(Number(year.isActive) ? 'Current' : 'Set current');
      action.disabled = Boolean(Number(year.isActive));
      action.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/years/${year.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) });
          await loadStructure();
          setMessage('Active academic year updated. The current term follows the July–December / January–June cycle.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      row.append(title, dates, status, action);
      yearsContainer.append(row);
    }

    const activeCalendar = structure.activeCalendar;
    const calendarBadge = document.querySelector('[data-active-calendar]');
    calendarBadge.textContent = activeCalendar
      ? `${activeCalendar.academicYearLabel} · ${activeCalendar.termKey === 'odd' ? 'Odd semester' : 'Even semester'}`
      : 'No active academic calendar';
    calendarBadge.classList.toggle('inactive', !activeCalendar);

    const termsContainer = document.querySelector('[data-term-list]');
    termsContainer.replaceChildren();
    for (const term of structure.terms) {
      const row = element('div', '', 'structure-list-row');
      const label = `${term.academicYearLabel} · ${term.termKey === 'odd' ? 'Odd semester' : 'Even semester'}`;
      row.append(element('strong', label), element('small', `${term.startsOn} – ${term.endsOn}`));
      row.append(element('span', Number(term.isActive) ? 'Current term' : 'Inactive', Number(term.isActive) ? 'structure-status active' : 'structure-status'));
      const action = actionButton(Number(term.isActive) ? 'Current' : 'Set current');
      action.disabled = Boolean(Number(term.isActive));
      action.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/terms/${term.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: true }) });
          await loadStructure();
          setMessage('Active academic term updated. Student semester placement was recalculated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      row.append(action);
      termsContainer.append(row);
    }
  }

  function renderSemesters() {
    const container = document.querySelector('[data-semester-list]');
    container.replaceChildren();
    for (const semester of structure.semesters) {
      const row = document.createElement('form');
      row.className = 'structure-record structure-semester-record';
      row.append(element('span', `Semester ${semester.semesterNumber}`, 'structure-type'));
      const label = field('Display label', semester.label, 'text');
      row.append(label.label);
      const controls = element('div', '', 'structure-record-actions');
      const save = actionButton('Save');
      save.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/semesters/${semester.id}`, { method: 'PATCH', body: JSON.stringify({ label: label.input.value }) });
          await loadStructure();
          setMessage('Semester label updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      const toggle = actionButton(Number(semester.isActive) ? 'Deactivate' : 'Activate', Number(semester.isActive) ? 'secondary-button warning-button' : 'secondary-button');
      toggle.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/semesters/${semester.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !Number(semester.isActive) }) });
          await loadStructure();
          setMessage('Semester status updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      controls.append(save, toggle);
      row.append(controls);
      container.append(row);
    }
  }

  function renderSections() {
    const container = document.querySelector('[data-section-list]');
    container.replaceChildren();
    for (const section of structure.sections) {
      const row = document.createElement('form');
      row.className = 'structure-record structure-section-record';
      const grouping = section.branchName ? `${section.programmeName} · ${section.branchName}` : section.programmeName;
      row.append(element('small', grouping, 'structure-record-parent'));
      const name = field('Section name', section.name);
      row.append(name.label);
      const controls = element('div', '', 'structure-record-actions');
      const save = actionButton('Save');
      save.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/sections/${section.id}`, { method: 'PATCH', body: JSON.stringify({ name: name.input.value }) });
          await loadStructure();
          setMessage('Section updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      const toggle = actionButton(Number(section.isActive) ? 'Deactivate' : 'Activate', Number(section.isActive) ? 'secondary-button warning-button' : 'secondary-button');
      toggle.addEventListener('click', async () => {
        try {
          await request(`/api/admin/academic-structure/sections/${section.id}`, { method: 'PATCH', body: JSON.stringify({ isActive: !Number(section.isActive) }) });
          await loadStructure();
          setMessage('Section status updated.', 'success');
        } catch (error) { setMessage(error.message, 'error'); }
      });
      controls.append(save, toggle);
      row.append(controls);
      container.append(row);
    }
    updateSectionBranches();
  }

  function updateOptionParents() {
    const programmeId = Number(document.querySelector('[data-option-programme]').value);
    const type = document.querySelector('[data-option-type]').value;
    const field = document.querySelector('[data-option-parent-field]');
    const select = document.querySelector('[data-option-parent]');
    const parents = structure.options.filter((option) => Number(option.programmeId) === programmeId
      && option.parentOptionId == null && option.type === 'branch' && Number(option.isActive));
    field.hidden = type !== 'specialisation';
    select.required = type === 'specialisation';
    select.replaceChildren();
    const prompt = document.createElement('option');
    prompt.value = '';
    prompt.textContent = 'Select parent branch';
    select.append(prompt);
    for (const parent of parents) {
      const option = document.createElement('option');
      option.value = parent.id;
      option.textContent = parent.name;
      select.append(option);
    }
    select.disabled = type !== 'specialisation' || !parents.length;
  }

  function updateSectionBranches() {
    const programmeId = Number(document.querySelector('[data-section-programme]').value);
    const select = document.querySelector('[data-section-branch]');
    const options = structure.options.filter((option) => Number(option.programmeId) === programmeId
      && option.parentOptionId == null && ['branch', 'major'].includes(option.type) && Number(option.isActive));
    select.replaceChildren();
    const general = document.createElement('option');
    general.value = '';
    general.textContent = options.length ? 'Programme-wide section' : 'No branch / major grouping';
    select.append(general);
    for (const option of options) {
      const item = document.createElement('option');
      item.value = option.id;
      item.textContent = option.name;
      select.append(item);
    }
    select.disabled = !programmeId;
  }

  async function loadStructure() {
    structure = await request('/api/admin/academic-structure');
    renderProgrammes();
    renderOptions();
    renderYearsAndTerms();
    renderSemesters();
    renderSections();
  }

  document.querySelector('[data-programme-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.minDurationYears = Number(data.minDurationYears);
    data.maxDurationYears = Number(data.maxDurationYears);
    try {
      await request('/api/admin/academic-structure/programmes', { method: 'POST', body: JSON.stringify(data) });
      event.currentTarget.reset();
      await loadStructure();
      setMessage('Programme added.', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
  });

  document.querySelector('[data-option-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.parentOptionId = data.parentOptionId || null;
    try {
      await request('/api/admin/academic-structure/options', { method: 'POST', body: JSON.stringify(data) });
      const programme = data.programmeId;
      event.currentTarget.reset();
      document.querySelector('[data-option-programme]').value = programme;
      updateOptionParents();
      await loadStructure();
      setMessage('Academic option added.', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
  });
  document.querySelector('[data-option-programme]').addEventListener('change', updateOptionParents);
  document.querySelector('[data-option-type]').addEventListener('change', updateOptionParents);

  document.querySelector('[data-year-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    const data = { startYear: Number(formData.get('startYear')), isActive: formData.has('isActive') };
    try {
      await request('/api/admin/academic-structure/years', { method: 'POST', body: JSON.stringify(data) });
      event.currentTarget.reset();
      await loadStructure();
      setMessage('Academic year and its odd/even terms were added.', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
  });

  document.querySelector('[data-semester-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.semesterNumber = Number(data.semesterNumber);
    try {
      await request('/api/admin/academic-structure/semesters', { method: 'POST', body: JSON.stringify(data) });
      event.currentTarget.reset();
      await loadStructure();
      setMessage('Semester added.', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
  });

  document.querySelector('[data-section-form]').addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    data.branchOptionId = data.branchOptionId || null;
    try {
      await request('/api/admin/academic-structure/sections', { method: 'POST', body: JSON.stringify(data) });
      const programme = data.programmeId;
      event.currentTarget.reset();
      document.querySelector('[data-section-programme]').value = programme;
      updateSectionBranches();
      await loadStructure();
      setMessage('Section added.', 'success');
    } catch (error) { setMessage(error.message, 'error'); }
  });
  document.querySelector('[data-section-programme]').addEventListener('change', updateSectionBranches);

  loadStructure().catch((error) => setMessage(`Academic structure could not be loaded. ${error.message}`, 'error'));
})();
