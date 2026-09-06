/**
 * Регистрация на «Кабаньих сводках».
 *
 * Флоу:
 *   1. Пользователь вводит ник (живая проверка занятости) и пароль.
 *   2. При открытии страницы тихо решается PoW-челлендж (защита от ботов).
 *   3. Сабмит -> POST /api/auth/register.
 *   4. status=instant  -> «Добро пожаловать!» (сейчас, REQUIRE_VERIFICATION=none).
 *   5. status=pending  -> показываем код и ссылку на бота, поллим статус
 *                         (задел: REQUIRE_VERIFICATION=telegram|email).
 */

'use strict';

(function () {
  const form = document.getElementById('reg-form');
  if (!form) return; // скрипт подключен не на той странице

  const usernameEl = document.getElementById('username');
  const passwordEl = document.getElementById('password');
  const password2El = document.getElementById('password2');
  const honeypotEl = document.getElementById('website'); // honeypot: люди не видят
  const btnEl = document.getElementById('btn-register');
  const msgEl = document.getElementById('reg_message');
  const nickStatusEl = document.getElementById('nick-status');
  const pendingBlockEl = document.getElementById('pending-block');
  const pendingCodeEl = document.getElementById('reg-code');
  const pendingLinkEl = document.getElementById('tg-link');
  const pendingStatusEl = document.getElementById('pending-status');

  const pageLoadedAt = Date.now();
  let currentChallenge = null; // {id, difficulty, prefix}
  let powSolution = null;      // {nonce, hash, ms}
  let polling = null;

  // ---------- Сообщения ----------

  function showMessage(text, type) {
    msgEl.innerHTML = text;
    msgEl.className = type;
    msgEl.style.display = 'block';
  }

  function hideMessage() {
    msgEl.style.display = 'none';
  }

  // Числовые entity собираем из кодов, чтобы их нельзя было случайно «декодировать»
  function escapeHtml(s) {
    const map = {
      '&': '&#' + 38 + ';',
      '<': '&#' + 60 + ';',
      '>': '&#' + 62 + ';',
      '"': '&#' + 34 + ';',
      "'": '&#' + 39 + ';',
    };
    return String(s).replace(/[&<>"']/g, (c) => map[c]);
  }

  // ---------- Живая проверка ника ----------

  let checkTimer = null;

  usernameEl.addEventListener('input', () => {
    clearTimeout(checkTimer);
    const value = usernameEl.value.trim();
    if (!value) {
      nickStatusEl.textContent = '';
      nickStatusEl.className = 'nick-status';
      return;
    }
    nickStatusEl.textContent = '…';
    nickStatusEl.className = 'nick-status';
    checkTimer = setTimeout(checkUsername, 400); // дебаунс
  });

  async function checkUsername() {
    const value = usernameEl.value.trim();
    if (!value) return;
    try {
      const resp = await fetch('/api/auth/username-check?u=' + encodeURIComponent(value));
      const data = await resp.json();
      nickStatusEl.textContent = data.ok ? '✓ свободен' : '✗ ' + (data.error || 'не подходит');
      nickStatusEl.className = 'nick-status ' + (data.ok ? 'ok' : 'bad');
    } catch (e) {
      nickStatusEl.textContent = '';
      nickStatusEl.className = 'nick-status';
    }
  }

  // ---------- PoW ----------

  async function fetchChallenge() {
    const resp = await fetch('/api/auth/challenge');
    if (!resp.ok) throw new Error('Не удалось получить челлендж (' + resp.status + ')');
    currentChallenge = await resp.json();
    powSolution = null;
    // Решаем в фоне, не мешая вводу
    window.CabanPow
      .solveChallenge(currentChallenge.prefix, currentChallenge.difficulty)
      .then((sol) => { powSolution = sol; })
      .catch((e) => { console.error('PoW error:', e); });
  }

  async function ensurePow() {
    // Если челленджа нет или решение не готово — ждем/перевыбираем
    if (!currentChallenge) {
      await fetchChallenge();
    }
    const started = Date.now();
    while (!powSolution) {
      if (Date.now() - started > 30000) throw new Error('Не удалось решить защитную задачку');
      await new Promise((r) => setTimeout(r, 150));
    }
    return powSolution;
  }

  // ---------- Сабмит ----------

  form.addEventListener('submit', onSubmit);

  async function onSubmit(event) {
    event.preventDefault();

    const username = usernameEl.value.trim();
    const password = passwordEl.value;
    const password2 = password2El.value;

    if (username.length < 3) return showMessage('Ник должен быть не короче 3 символов', 'error');
    if (password.length < 6) return showMessage('Пароль должен быть не короче 6 символов', 'error');
    if (password !== password2) return showMessage('Пароли не совпадают', 'error');
    if (honeypotEl.value) return; // бот, беги

    btnEl.disabled = true;
    try {
      showMessage('Считаем хеши (защита от ботов)&#8230;', 'loading');
      const pow = await ensurePow();

      showMessage('Регистрируем&#8230;', 'loading');
      const resp = await fetch('/api/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          website: honeypotEl.value, // honeypot: должно быть пусто
          formLoadedAt: pageLoadedAt,
          pow_id: currentChallenge.id,
          pow_nonce: pow.nonce,
        }),
      });

      const data = await resp.json().catch(() => ({}));

      if (resp.ok && data.status === 'instant') {
        showMessage('&#10003; Добро пожаловать, <b>' + escapeHtml(data.username) + '</b>!', 'success');
        disableForm();
        return;
      }

      if (resp.ok && data.status === 'pending') {
        // ЗАДЕЛ: подтверждение через бота или почту
        showMessage('&#10003; Заявка создана. ' + escapeHtml(data.message || ''), 'success');
        showPending(data);
        return;
      }

      showMessage(escapeHtml(data.detail || ('Ошибка ' + resp.status)), 'error');
      // Челлендж мог протухнуть — тихо обновим на будущее
      fetchChallenge().catch(() => {});
    } catch (e) {
      showMessage('Ошибка соединения: ' + escapeHtml(e.message), 'error');
    } finally {
      btnEl.disabled = false;
    }
  }

  function disableForm() {
    [usernameEl, passwordEl, password2El, honeypotEl, btnEl].forEach((el) => { el.disabled = true; });
  }

  // ---------- Pending (задел: telegram/email подтверждение) ----------

  function showPending(data) {
    form.style.display = 'none';
    hideMessage();
    pendingBlockEl.style.display = 'block';
    pendingCodeEl.textContent = data.code || '';
    pendingLinkEl.href = 'https://t.me/cabanreports_bot?start=' + encodeURIComponent(data.code || '');
    pendingStatusEl.textContent = 'Ждем подтверждения…';

    if (polling) clearInterval(polling);
    polling = setInterval(async () => {
      try {
        const resp = await fetch('/api/auth/register/status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: data.code }),
        });
        const st = await resp.json();
        if (st.confirmed) {
          clearInterval(polling);
          pendingBlockEl.style.display = 'none';
          showMessage('&#10003; Подтверждено! Регистрация завершена.', 'success');
        }
      } catch (e) { /* сеть моргнула — попробуем на следующем тике */ }
    }, 3000);
  }

  // Старт: сразу тянем челлендж
  fetchChallenge().catch((e) => console.error('challenge error:', e));
})();