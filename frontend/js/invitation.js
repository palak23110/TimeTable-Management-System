(() => {
  const token = new URLSearchParams(location.search).get('token') || '';
  const message = document.querySelector('[data-invitation-message]');
  const acceptButton = document.querySelector('[data-accept-invitation]');
  const rejectButton = document.querySelector('[data-reject-invitation]');

  async function submit(action) {
    const response = await fetch(`/api/auth/${action}-invitation`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The invitation could not be processed.');
    return data;
  }

  acceptButton.addEventListener('click', async () => {
    acceptButton.disabled = true;
    rejectButton.disabled = true;
    message.textContent = '';
    try {
      const data = await submit('accept');
      location.assign(data.redirectTo);
    } catch (error) {
      message.textContent = error.message;
      acceptButton.disabled = false;
      rejectButton.disabled = false;
    }
  });

  rejectButton.addEventListener('click', async () => {
    if (!window.confirm('Reject this teacher invitation? It cannot be accepted afterward.')) return;
    acceptButton.disabled = true;
    rejectButton.disabled = true;
    message.textContent = '';
    try {
      const data = await submit('reject');
      message.textContent = data.message;
    } catch (error) {
      message.textContent = error.message;
      acceptButton.disabled = false;
      rejectButton.disabled = false;
    }
  });
})();
