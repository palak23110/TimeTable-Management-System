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
    const viewButton = createTextElement('button', 'View', 'view-teacher');
    viewButton.type = 'button';
    viewButton.setAttribute('aria-label', `View ${teacher.name}`);
    viewButton.addEventListener('click', () => showDetails(teacher.id));
    cell.append(viewButton);

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
          createTextElement(
            'td',
            teacher.subjectNames.length ? teacher.subjectNames.join(', ') : '—',
          ),
        );

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
      message.textContent = `Could not load teacher records. ${error.message}`;
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
    } catch (error) {
      message.textContent = error.message;
    }
  }

  async function resendInvitation(teacher) {
    message.textContent = '';

    try {
      const result = await request(
        `/api/admin/teachers/${encodeURIComponent(teacher.id)}/resend-invitation`,
        { method: 'POST', body: JSON.stringify({}) },
      );

      message.textContent = result.invitationSent
        ? `Invitation sent to ${teacher.email}.`
        : `The account remains active, but the invitation could not be delivered to ${teacher.email}. You can retry from this row.`;
      await Promise.all([loadStats(), loadTeachers()]);
    } catch (error) {
      message.textContent = error.message;
    }
  }

  async function refresh() {
    await Promise.all([loadStats(), loadTeachers()]);
  }

  function setDrawerOpen(open) {
    drawer.hidden = !open;
    if (open) form.elements.name.focus();
  }

  loadStats().catch((error) => {
    message.textContent = `Could not load teacher statistics. ${error.message}`;
  });
  loadSubjects().catch((error) => {
    message.textContent = `Could not load the subject filters. ${error.message}`;
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
      message.textContent = result.invitationSent
        ? `Teacher account created. Invitation sent to ${result.teacher.email}.`
        : `Teacher account created, but the invitation email could not be delivered to ${result.teacher.email}. Use Resend invitation to retry.`;
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
