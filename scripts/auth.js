/**
 * Состояние авторизации в шапке сайта.
 *
 * На каждой странице спрашивает /api/auth/me и рисует в .top-auth:
 *   гость    -> «Вход · Регистрация» (как в статике)
 *   вошедший -> «Привет, ник · Выйти»
 * Клик по «Выйти» -> POST /api/auth/logout -> перезагрузка страницы.
 *
 * Скрипт подключается на всех страницах; если .top-auth нет — тихо выходит.
 */

'use strict';

(function () {
  const box = document.querySelector('.top-auth');
  if (!box) return;

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

  async function render() {
    let username = null;
    try {
      const resp = await fetch('/api/auth/me');
      const data = await resp.json();
      username = data.username || null;
    } catch (e) {
      // Сервер недоступен — оставляем статичную плашку как есть
      return;
    }

    if (!username) return; // гость: статичная «Вход · Регистрация» уже на месте

    box.innerHTML =
      'Привет, <span class="top-auth-name">' + escapeHtml(username) + '</span>' +
      ' · <a href="#" id="logout-link">Выйти</a>';

    document.getElementById('logout-link').addEventListener('click', async (event) => {
      event.preventDefault();
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch (e) { /* всё равно перезагружаемся */ }
      window.location.reload();
    });
  }

  render();
})();