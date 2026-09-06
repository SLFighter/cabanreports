/**
 * Логика формы входа (страница pages/login.html).
 */

'use strict';

(function () {
  const form = document.getElementById('login-form');
  if (!form) return;

  const usernameEl = document.getElementById('username');
  const passwordEl = document.getElementById('password');
  const rememberEl = document.getElementById('remember');
  const btnEl = document.getElementById('btn-login');
  const msgEl = document.getElementById('login_message');

  function showMessage(text, type) {
    msgEl.innerHTML = text;
    msgEl.className = type;
    msgEl.style.display = 'block';
  }

  function hideMessage() {
    msgEl.style.display = 'none';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideMessage();

    const username = usernameEl.value.trim();
    const password = passwordEl.value;
    if (!username) return showMessage('Введи ник', 'error');
    if (!password) return showMessage('Введи пароль', 'error');

    btnEl.disabled = true;
    try {
      showMessage('Входим&#8230;', 'loading');
      const resp = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          remember: rememberEl.checked,
        }),
      });
      const data = await resp.json().catch(() => ({}));

      if (resp.ok) {
        showMessage('&#10003; Вход выполнен. Переносим на главную&#8230;', 'success');
        setTimeout(() => { window.location.href = '/'; }, 800);
      } else {
        showMessage(data.detail || ('Ошибка ' + resp.status), 'error');
        btnEl.disabled = false;
      }
    } catch (e) {
      showMessage('Ошибка соединения: ' + e.message, 'error');
      btnEl.disabled = false;
    }
  });
})();