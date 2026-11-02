'use strict';

(() => {
  const statElements = Array.from(document.querySelectorAll('[data-dashboard-stat]'));
  if (!statElements.length) return;

  const supportElements = new Map(
    Array.from(document.querySelectorAll('[data-dashboard-support]'))
      .map((element) => [element.dataset.dashboardSupport, element]),
  );
  const statsGrid = document.querySelector('.stats-grid');
  const errorElement = document.querySelector('[data-dashboard-error]');
  const numberFormat = new Intl.NumberFormat();

  function renderCards(cards) {
    for (const element of statElements) {
      const key = element.dataset.dashboardStat;
      const card = cards?.[key];
      if (!card) {
        element.textContent = '—';
        const support = supportElements.get(key);
        if (support) support.textContent = 'Statistics unavailable.';
        continue;
      }

      element.textContent = card.value === null || card.value === undefined
        ? '—'
        : key === 'scheduleHealth'
          ? `${numberFormat.format(Number(card.value))}%`
          : numberFormat.format(Number(card.value));
      const support = supportElements.get(key);
      if (support) support.textContent = card.supportingText || '';
    }
    if (statsGrid) statsGrid.setAttribute('aria-busy', 'false');
  }

  if (statsGrid) statsGrid.setAttribute('aria-busy', 'true');

  fetch('/api/admin/dashboard/stats', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Dashboard statistics could not be loaded.');
      renderCards(data.cards);
    })
    .catch((error) => {
      renderCards(null);
      statElements.forEach((element) => { element.textContent = '—'; });
      if (errorElement) errorElement.textContent = error.message || 'Dashboard statistics could not be loaded.';
    });
})();
