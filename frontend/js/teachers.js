(() => {
  const rows = document.querySelector('[data-teacher-rows]');
  if (!rows) return;

  const search = document.querySelector('[data-search]');
  const subject = document.querySelector('[data-subject]');
  const status = document.querySelector('[data-status]');
  const message = document.querySelector('[data-message]');
  const drawer = document.querySelector('[data-drawer]');
  const form = document.querySelector('[data-teacher-form]');

  let page = 1;
  let totalPages = 1;
  let debounce;
  const modalLayers = [drawer, document.querySelector('[data-edit-drawer]'), document.querySelector('[data-subject-drawer]')];

  function setModalOpen(modal, open) {
    modal.hidden = !open;
    document.body.classList.toggle('teacher-modal-open', modalLayers.some((layer) => !layer.hidden));
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
      throw new Error('The server did not return teacher data. Your session may have expired.');
    }

    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error('The server returned unreadable teacher data. Please try again.');
    }

    if (!response.ok) {
      throw new Error(data.error || 'Request failed.');
    }

    return data;
  }

  function createTextElement(tag, value, className = '') {
    const element = document.createElement(tag);
    element.textContent = value;
    if (className) element.className = className;
    return element;
  }

  function setMessage(text, type = '') {
    message.textContent = text;
    message.className = `teacher-message${type ? ` ${type}` : ''}`;
  }

  async function loadStats() {
    const { stats } = await request('/api/admin/teachers/stats');

    for (const [key, value] of Object.entries(stats)) {
      const stat = document.querySelector(`[data-stat="${key}"]`);
      if (stat) stat.textContent = value;
    }
  }

  async function loadSubjects() {
    const { subjects } = await request('/api/admin/teachers/subjects');

    for (const item of subjects) {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.name;
      subject.append(option);
    }
  }

  function addTeacherActions(cell, teacher) {
    cell.className = 'teacher-row-actions';

    const viewButton = createTextElement('button', 'View', 'view-teacher');
    viewButton.type = 'button';
    viewButton.setAttribute('aria-label', `View ${teacher.name}`);
    viewButton.addEventListener('click', () => showDetails(teacher.id));
    cell.append(viewButton);

    const editButton = createTextElement('button', 'Edit', 'view-teacher');
    editButton.type = 'button';
    editButton.setAttribute('aria-label', `Edit ${teacher.name}`);
    editButton.addEventListener('click', () => openEditDrawer(teacher.id));
    cell.append(editButton);

    const subjectsButton = createTextElement('button', 'Manage subjects', 'view-teacher');
    subjectsButton.type = 'button';
    subjectsButton.setAttribute('aria-label', `Manage subjects for ${teacher.name}`);
    subjectsButton.addEventListener('click', () => openSubjectsDrawer(teacher));
    cell.append(subjectsButton);

    if (teacher.status === 'invitation' || teacher.status === 'delivery_failed') {
      const resendButton = createTextElement(
        'button',
        'Resend invitation',
        'view-teacher resend-invitation',
      );
      resendButton.type = 'button';
      resendButton.addEventListener('click', () => resendInvitation(teacher));
      cell.append(resendButton);
    }
  }

  async function loadTeachers() {
    const params = new URLSearchParams({ page: String(page) });
    if (search.value.trim()) params.set('search', search.value.trim());
    if (subject.value) params.set('subject', subject.value);
    if (status.value) params.set('status', status.value);

    try {
      const url = `/api/admin/teachers?${params}`;
      const data = await request(url);
      if (!Array.isArray(data.teachers)) {
        throw new Error('The teacher list response is missing its records.');
      }

      totalPages = Math.max(1, data.totalPages);
      rows.replaceChildren();

      if (!data.teachers.length) {
        const row = document.createElement('tr');
        const cell = createTextElement('td', 'No teacher records found.', 'empty-row');
        cell.colSpan = 6;
        row.append(cell);
        rows.append(row);
      }

      for (const teacher of data.teachers) {
        const row = document.createElement('tr');
        const identity = document.createElement('td');
        const initials = teacher.name
          .split(/\s+/)
          .map((part) => part[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
        const avatar = createTextElement('span', initials, 'teacher-avatar');
        const nameWrap = document.createElement('span');
        nameWrap.className = 'teacher-identity';
        nameWrap.append(
          createTextElement('strong', teacher.name),
          createTextElement('small', teacher.email),
        );
        identity.append(avatar, nameWrap);

        row.append(
          identity,
          createTextElement('td', teacher.teacherId),
          createTextElement('td', teacher.contactNumber || '—'),
        );

        const subjectsCell = document.createElement('td');
        if (teacher.subjectNames.length) {
          const subjectPills = document.createElement('div');
          subjectPills.className = 'teacher-subject-pills';
          for (const subjectName of teacher.subjectNames) {
            subjectPills.append(createTextElement('span', subjectName, 'teacher-subject-pill'));
          }
          subjectsCell.append(subjectPills);
        } else {
          subjectsCell.textContent = '—';
        }
        row.append(subjectsCell);

        const statusCell = document.createElement('td');
        const statusLabels = {
          active: 'Active',
          invitation: 'Invitation sent',
          delivery_failed: 'Email not delivered',
          inactive: 'Inactive',
        };
        statusCell.append(createTextElement(
          'span',
          statusLabels[teacher.status] || 'Unknown',
          `status-pill ${teacher.status}`,
        ));
        row.append(statusCell);

        const actions = document.createElement('td');
        addTeacherActions(actions, teacher);
        row.append(actions);
        rows.append(row);
      }

      const first = data.total ? (page - 1) * data.pageSize + 1 : 0;
      const last = Math.min(page * data.pageSize, data.total);
      document.querySelector('[data-page-summary]').textContent =
        `Showing ${first}–${last} of ${data.total} records`;
      document.querySelector('[data-page-number]').textContent = `${page} / ${totalPages}`;
      document.querySelector('[data-page-prev]').disabled = page <= 1;
      document.querySelector('[data-page-next]').disabled = page >= totalPages;
    } catch (error) {
      setMessage(`Could not load teacher records. ${error.message}`, 'error');
    }
  }

  async function showDetails(id) {
    try {
      const { teacher } = await request(`/api/admin/teachers/${encodeURIComponent(id)}`);
      document.querySelector('[data-detail-name]').textContent = teacher.name;
      const details = document.querySelector('[data-detail-content]');
      details.replaceChildren();

      const fields = [
        ['Teacher ID', teacher.teacher_id],
        ['Email', teacher.email],
        ['Contact number', teacher.contact_number],
        ['Department', teacher.department],
        ['Designation', teacher.designation],
        ['Qualification', teacher.highest_qualification],
        ['University / institution', teacher.university_institution],
        ['Specialization', teacher.specialization],
        ['Years of experience', teacher.years_of_experience],
        ['Previous organization', teacher.previous_organization],
        ['Previous job role', teacher.previous_job_role],
        ['Previous responsibilities', teacher.previous_job_responsibilities],
        ['Skills / areas of expertise', teacher.skills_areas_of_expertise],
        ['Professional summary', teacher.professional_summary],
      ];

      for (const [label, value] of fields) {
        details.append(
          createTextElement('dt', label),
          createTextElement('dd', value || '—'),
        );
      }

      document.querySelector('[data-detail]').hidden = false;
      document.querySelector('[data-detail]').dataset.teacherId = id;
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  const editFields = [
    'name',
    'teacherId',
    'email',
    'contactNumber',
    'department',
    'designation',
    'highestQualification',
    'universityInstitution',
    'specialization',
    'yearsOfExperience',
    'previousEmployer',
    'previousJobRole',
    'responsibilities',
    'skills',
    'professionalSummary',
    'status',
  ];
  const editForm = document.querySelector('[data-edit-form]');
  const editDrawer = document.querySelector('[data-edit-drawer]');

  async function openEditDrawer(id) {
    const errorBox = document.querySelector('[data-edit-error]');
    errorBox.textContent = '';
    editForm.reset();
    editForm.dataset.teacherId = id;
    setModalOpen(editDrawer, true);
    document.querySelector('#edit-drawer-title').textContent = 'Loading teacher details…';

    try {
      const { teacher } = await request(`/api/admin/teachers/${encodeURIComponent(id)}`);
      const values = {
        name: teacher.name,
        teacherId: teacher.teacher_id,
        email: teacher.email,
        contactNumber: teacher.contact_number,
        department: teacher.department,
        designation: teacher.designation,
        highestQualification: teacher.highest_qualification,
        universityInstitution: teacher.university_institution,
        specialization: teacher.specialization,
        yearsOfExperience: teacher.years_of_experience,
        previousEmployer: teacher.previous_organization,
        previousJobRole: teacher.previous_job_role,
        responsibilities: teacher.previous_job_responsibilities,
        skills: teacher.skills_areas_of_expertise,
        professionalSummary: teacher.professional_summary,
        status: Number(teacher.isActive) ? 'active' : 'inactive',
      };

      for (const field of editFields) {
        editForm.elements[field].value = values[field] ?? '';
      }

      editForm.dataset.initialValues = JSON.stringify(
        Object.fromEntries(new FormData(editForm)),
      );
      document.querySelector('#edit-drawer-title').textContent = `Edit ${teacher.name}`;
      editForm.elements.name.focus();
    } catch (error) {
      errorBox.textContent = error.message;
    }
  }

  function closeEditDrawer() {
    setModalOpen(editDrawer, false);
  }

  const subjectForm = document.querySelector('[data-subject-form]');
  const subjectDrawer = document.querySelector('[data-subject-drawer]');
  const subjectOptions = document.querySelector('[data-subject-options]');

  async function openSubjectsDrawer(teacher) {
    const errorBox = document.querySelector('[data-subject-error]');
    errorBox.textContent = '';
    subjectOptions.replaceChildren(createTextElement('p', 'Loading available subjects…', 'subject-empty'));
    subjectForm.dataset.teacherId = teacher.id;
    setModalOpen(subjectDrawer, true);
    document.querySelector('[data-subject-teacher]').textContent = `${teacher.name} · ${teacher.teacherId}`;

    try {
      const [availableResult, assignedResult] = await Promise.all([
        request('/api/admin/teachers/subjects'),
        request(`/api/admin/teachers/${encodeURIComponent(teacher.id)}/subjects`),
      ]);
      const assignedIds = new Set(assignedResult.subjects.map((item) => Number(item.id)));
      const subjects = new Map(availableResult.subjects.map((item) => [Number(item.id), item]));
      for (const assigned of assignedResult.subjects) {
        subjects.set(Number(assigned.id), assigned);
      }

      subjectOptions.replaceChildren();
      if (!subjects.size) {
        subjectOptions.append(createTextElement('p', 'No subjects are available yet.', 'subject-empty'));
        return;
      }

      for (const item of [...subjects.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const option = document.createElement('label');
        option.className = 'subject-option';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'subjectIds';
        checkbox.value = item.id;
        checkbox.checked = assignedIds.has(Number(item.id));
        checkbox.disabled = !Number(item.isActive) && !checkbox.checked;
        const copy = document.createElement('span');
        copy.append(createTextElement('strong', item.name));
        if (item.code) copy.append(createTextElement('small', item.code));
        if (!Number(item.isActive)) copy.append(createTextElement('small', 'Inactive · currently assigned'));
        option.append(checkbox, copy);
        subjectOptions.append(option);
      }
    } catch (error) {
      subjectOptions.replaceChildren(createTextElement('p', error.message, 'subject-empty'));
      errorBox.textContent = `Could not load subject assignments. ${error.message}`;
    }
  }

  async function resendInvitation(teacher) {
    setMessage('');

    try {
      const result = await request(
        `/api/admin/teachers/${encodeURIComponent(teacher.id)}/resend-invitation`,
        { method: 'POST', body: JSON.stringify({}) },
      );

      setMessage(result.invitationSent
        ? `Invitation sent to ${teacher.email}.`
        : `The account remains active, but the invitation could not be delivered to ${teacher.email}. You can retry from this row.`,
      result.invitationSent ? 'success' : 'error');
      await Promise.all([loadStats(), loadTeachers()]);
    } catch (error) {
      setMessage(error.message, 'error');
    }
  }

  async function refresh() {
    await Promise.all([loadStats(), loadTeachers()]);
  }

  function setDrawerOpen(open) {
    setModalOpen(drawer, open);
    if (open) form.elements.name.focus();
  }

  loadStats().catch((error) => {
    setMessage(`Could not load teacher statistics. ${error.message}`, 'error');
  });
  loadSubjects().catch((error) => {
    setMessage(`Could not load the subject filters. ${error.message}`, 'error');
  });
  loadTeachers();

  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      page = 1;
      loadTeachers();
    }, 200);
  });

  subject.addEventListener('change', () => {
    page = 1;
    loadTeachers();
  });
  status.addEventListener('change', () => {
    page = 1;
    loadTeachers();
  });

  document.querySelector('[data-clear]').addEventListener('click', () => {
    search.value = '';
    subject.value = '';
    status.value = '';
    page = 1;
    loadTeachers();
  });

  document.querySelector('[data-page-prev]').addEventListener('click', () => {
    if (page > 1) {
      page -= 1;
      loadTeachers();
    }
  });
  document.querySelector('[data-page-next]').addEventListener('click', () => {
    if (page < totalPages) {
      page += 1;
      loadTeachers();
    }
  });

  document.querySelector('[data-open-drawer]').addEventListener('click', () => {
    setDrawerOpen(true);
  });
  document.querySelectorAll('[data-close-drawer]').forEach((button) => {
    button.addEventListener('click', () => setDrawerOpen(false));
  });

  document.querySelectorAll('[data-close-edit]').forEach((button) => {
    button.addEventListener('click', closeEditDrawer);
  });
  editDrawer.addEventListener('click', (event) => {
    if (event.target.matches('[data-edit-drawer]')) closeEditDrawer();
  });

  document.querySelectorAll('[data-close-subjects]').forEach((button) => {
    button.addEventListener('click', () => setModalOpen(subjectDrawer, false));
  });
  subjectDrawer.addEventListener('click', (event) => {
    if (event.target.matches('[data-subject-drawer]')) setModalOpen(subjectDrawer, false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!subjectDrawer.hidden) setModalOpen(subjectDrawer, false);
    else if (!editDrawer.hidden) closeEditDrawer();
    else if (!drawer.hidden) setDrawerOpen(false);
  });

  editForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector('[data-edit-error]');
    const submitButton = editForm.querySelector('[type="submit"]');
    errorBox.textContent = '';
    submitButton.disabled = true;

    try {
      const initialValues = JSON.parse(editForm.dataset.initialValues || '{}');
      const changes = Object.fromEntries(
        [...new FormData(editForm)].filter(([field, value]) => initialValues[field] !== value),
      );
      if (!Object.keys(changes).length) {
        errorBox.textContent = 'There are no changes to save.';
        return;
      }

      const teacherId = editForm.dataset.teacherId;
      await request(`/api/admin/teachers/${encodeURIComponent(teacherId)}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      closeEditDrawer();
      setMessage('Teacher details updated successfully.', 'success');
      await refresh();
      const detail = document.querySelector('[data-detail]');
      if (!detail.hidden && detail.dataset.teacherId === teacherId) await showDetails(teacherId);
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  subjectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector('[data-subject-error]');
    const submitButton = subjectForm.querySelector('[type="submit"]');
    errorBox.textContent = '';
    submitButton.disabled = true;

    try {
      const teacherId = subjectForm.dataset.teacherId;
      const subjectIds = [...subjectForm.querySelectorAll('input[name="subjectIds"]:checked')]
        .map((input) => Number(input.value));
      await request(`/api/admin/teachers/${encodeURIComponent(teacherId)}/subjects`, {
        method: 'PUT',
        body: JSON.stringify({ subjectIds }),
      });
      setModalOpen(subjectDrawer, false);
      setMessage('Subject assignments updated successfully.', 'success');
      await refresh();
      const detail = document.querySelector('[data-detail]');
      if (!detail.hidden && detail.dataset.teacherId === teacherId) await showDetails(teacherId);
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const errorBox = document.querySelector('[data-form-error]');
    const submitButton = form.querySelector('[type="submit"]');
    errorBox.textContent = '';
    submitButton.disabled = true;

    try {
      const payload = Object.fromEntries(new FormData(form));
      const result = await request('/api/admin/teachers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      form.reset();
      setDrawerOpen(false);
      setMessage(result.invitationSent
        ? `Teacher account created. Invitation sent to ${result.teacher.email}.`
        : `Teacher account created, but the invitation email could not be delivered to ${result.teacher.email}. Use Resend invitation to retry.`,
      result.invitationSent ? 'success' : 'error');
      page = 1;
      await refresh();
    } catch (error) {
      errorBox.textContent = error.message;
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelector('[data-close-detail]').addEventListener('click', () => {
    document.querySelector('[data-detail]').hidden = true;
  });
  document.querySelector('[data-detail]').addEventListener('click', (event) => {
    if (event.target.matches('[data-detail]')) event.currentTarget.hidden = true;
  });
})();
