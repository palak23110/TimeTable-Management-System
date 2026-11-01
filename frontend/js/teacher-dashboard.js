(() => {
  const errorElement = document.querySelector('[data-dashboard-error]');
  const subjectList = document.querySelector('[data-subject-list]');

  function initialsFor(name) {
    return String(name || '')
      .replace(/^(dr\.?|prof\.?|mr\.?|mrs\.?|ms\.?)\s+/i, '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0])
      .join('')
      .toUpperCase() || '—';
  }

  function setText(selector, value, fallback = 'Not provided') {
    const element = document.querySelector(selector);
    if (element) element.textContent = value || fallback;
  }

  function showMessage(message) {
    if (errorElement) errorElement.textContent = message;
  }

  function subjectRow(subject, index) {
    const item = document.createElement('article');
    item.className = 'teacher-subject-item';
    const swatch = document.createElement('span');
    swatch.className = `teacher-subject-swatch tone-${index % 3}`;
    swatch.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span');
    copy.className = 'teacher-subject-copy';
    const name = document.createElement('strong');
    name.textContent = subject.name;
    const details = document.createElement('small');
    details.textContent = subject.code || 'Assigned subject';
    copy.append(name, details);
    item.append(swatch, copy);
    return item;
  }

  async function loadTeacherOverview() {
    try {
      const response = await fetch('/api/teacher/profile', { headers: { Accept: 'application/json' } });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load your teacher profile.');
      const profile = data.profile;
      if (!profile || !Array.isArray(profile.subjects)) throw new Error('The teacher profile response was incomplete.');

      const initials = initialsFor(profile.name);
      const teacherId = profile.teacherId || 'Teacher ID unavailable';
      const department = profile.department || 'Department not provided';
      const hour = new Date().getHours();
      const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
      setText('[data-greeting]', `${greeting}, ${profile.name}`);
      setText('[data-profile-name]', profile.name);
      setText('[data-profile-teacher-id]', teacherId);
      setText('[data-teacher-id]', teacherId);
      setText('[data-profile-department]', department);
      document.querySelectorAll('[data-profile-initials]').forEach((element) => { element.textContent = initials; });

      const today = new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(new Date());
      setText('[data-today-label]', `Today · ${today}`);
      if (subjectList) {
        subjectList.replaceChildren();
        if (profile.subjects.length) {
          profile.subjects.forEach((subject, index) => subjectList.append(subjectRow(subject, index)));
        } else {
          const empty = document.createElement('div');
          empty.className = 'teacher-empty-state compact';
          const message = document.createElement('p');
          message.textContent = 'No subjects have been assigned yet.';
          const detail = document.createElement('small');
          detail.textContent = 'Your assigned subjects will appear here.';
          empty.append(message, detail);
          subjectList.append(empty);
        }
      }
    } catch (error) {
      if (subjectList) {
        subjectList.replaceChildren();
        const empty = document.createElement('div');
        empty.className = 'teacher-empty-state compact';
        const message = document.createElement('p');
        message.textContent = 'Assigned subjects could not be loaded.';
        empty.append(message);
        subjectList.append(empty);
      }
      showMessage(error.message || 'Could not load your teacher overview.');
    }
  }

  loadTeacherOverview();
})();
