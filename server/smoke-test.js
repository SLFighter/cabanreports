/**
 * Smoke-тест API регистрации.
 * Запуск: сервер должен быть поднят (npm start), затем в другом терминале — npm run smoke.
 */

'use strict';

const crypto = require('crypto');

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000'; // 127.0.0.1: localhost в Node 20 может резолвиться в ::1

// fetch с ретраем: keep-alive сокет мог быть закрыт сервером (ECONNRESET) —
// это гонка клиента и сервера, а не ошибка приложения
async function fetchRetry(url, opts = {}, attempts = 3) {
  for (let i = 1; ; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, 200 * i));
    }
  }
}

function leadingZeroBits(hex) {
  let bits = 0;
  for (const c of hex) {
    const v = parseInt(c, 16);
    if (v === 0) { bits += 4; continue; }
    if (v < 2) bits += 3; else if (v < 4) bits += 2; else if (v < 8) bits += 1;
    break;
  }
  return bits;
}

async function solvePow() {
  const resp = await fetchRetry(`${BASE}/api/auth/challenge`);
  const ch = await resp.json();
  let nonce = 0;
  for (;;) {
    const digest = crypto.createHash('sha256').update(`${ch.prefix}:${nonce}`).digest('hex');
    if (leadingZeroBits(digest) >= ch.difficulty) {
      return { id: ch.id, nonce };
    }
    nonce++;
  }
}

async function register(body) {
  const resp = await fetchRetry(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: resp.status, data: await resp.json().catch(() => ({})) };
}

const FORM_LOADED_AT = Date.now() - 10000; // «форма открыта 10 секунд назад»

async function validBody(nick) {
  const pow = await solvePow();
  return {
    username: nick,
    password: 'hunter2sekret',
    formLoadedAt: FORM_LOADED_AT,
    pow_id: pow.id,
    pow_nonce: pow.nonce,
  };
}

let failed = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${extra ? ' :: ' + JSON.stringify(extra) : ''}`);
  }
}

async function main() {
  console.log(`smoke-test против ${BASE}\n`);

  // 1. Статика отдается
  const home = await fetchRetry(`${BASE}/`);
  check('GET / отдает главную', home.ok, home.status);

  // 2. Страница регистрации доступна
  const regPage = await fetchRetry(`${BASE}/pages/register.html`);
  check('GET /pages/register.html доступна', regPage.ok, regPage.status);

  // 3. Challenge выдается
  const chResp = await fetchRetry(`${BASE}/api/auth/challenge`);
  const ch = await chResp.json();
  check('GET /api/auth/challenge выдает челлендж', Boolean(ch.id && ch.prefix && ch.difficulty), ch);

  // 4. Регистрация без PoW отклоняется
  let r = await register({
    username: 'nopow_user', password: '123456',
    formLoadedAt: FORM_LOADED_AT, pow_id: ch.id, pow_nonce: 0,
  });
  check('Регистрация без решения PoW отклоняется', r.status === 400, r);

  // 5. Регистрация со «мгновенным» сабмитом отклоняется (бот)
  const powFast = await solvePow();
  r = await register({
    username: 'fast_bot', password: '123456',
    formLoadedAt: Date.now(), pow_id: powFast.id, pow_nonce: powFast.nonce,
  });
  check('Слишком быстрая отправка формы отклоняется', r.status === 400, r);

  // 6. Honeypot
  r = await register({ ...(await validBody('hp_bot')), website: 'http://spam.example' });
  check('Заполненный honeypot отклоняется', r.status === 400, r);

  // 7. Успешная регистрация
  const nick = 'smoke_' + crypto.randomBytes(3).toString('hex');
  r = await register(await validBody(nick));
  check('Успешная регистрация (status=instant)', r.status === 201 && r.data.status === 'instant', r);

  // 8. Дубликат ника
  r = await register(await validBody(nick));
  check('Повторный ник отклоняется (409/400)', r.status === 409 || r.status === 400, r);

  // 9. Дубликат ника в другом регистре
  r = await register(await validBody(nick.toUpperCase()));
  check('Ник в другом регистре тоже занят', r.status === 409 || r.status === 400, r);

  // 10. username-check
  const ucBusy = await (await fetchRetry(`${BASE}/api/auth/username-check?u=${nick}`)).json();
  check('username-check: занятый ник -> ok:false', ucBusy.ok === false, ucBusy);
  const ucFree = await (await fetchRetry(`${BASE}/api/auth/username-check?u=svobodniynik123`)).json();
  check('username-check: свободный ник -> ok:true', ucFree.ok === true, ucFree);

  // 11. Слишком короткий пароль
  const powShort = await solvePow();
  r = await register({
    username: 'shortpw', password: '123',
    formLoadedAt: FORM_LOADED_AT, pow_id: powShort.id, pow_nonce: powShort.nonce,
  });
  check('Короткий пароль отклоняется', r.status === 400, r);

  // 12. Зарезервированный ник
  const powRes = await solvePow();
  r = await register({
    username: 'admin', password: '123456',
    formLoadedAt: FORM_LOADED_AT, pow_id: powRes.id, pow_nonce: powRes.nonce,
  });
  check('Зарезервированный ник отклоняется', r.status === 400, r);

  // ---------- Вход / сессии ----------

  const loginNick = 'logintest_' + crypto.randomBytes(3).toString('hex');
  r = await register(await validBody(loginNick));
  check('Регистрация тестового пользователя для входа', r.status === 201, r);

  // 13. Успешный вход
  let loginResp = await fetchRetry(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: loginNick, password: 'hunter2sekret', remember: true }),
  });
  let loginData = await loginResp.json().catch(() => ({}));
  check('Успешный вход', loginResp.status === 200 && loginData.username === loginNick, loginResp.status);
  const setCookie = loginResp.headers.get('set-cookie') || '';
  const cookie = setCookie.split(';')[0];
  check('Cookie сессии выдана (HttpOnly)', /caban_sid=/.test(setCookie) && /httponly/i.test(setCookie), setCookie);

  // 14. /me с cookie -> имя пользователя
  let meResp = await fetchRetry(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
  let meData = await meResp.json();
  check('/me с сессией возвращает ник', meData.username === loginNick, meData);

  // 15. /me без cookie -> null
  meResp = await fetchRetry(`${BASE}/api/auth/me`);
  meData = await meResp.json();
  check('/me без сессии возвращает null', meData.username === null, meData);

  // 16. Неверный пароль
  loginResp = await fetchRetry(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: loginNick, password: 'wrong-password', remember: true }),
  });
  check('Неверный пароль -> 401 с общей ошибкой', loginResp.status === 401, loginResp.status);

  // 17. Несуществующий ник -> та же ошибка 401
  loginResp = await fetchRetry(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'nonexistent_user_xyz', password: 'whatever123', remember: true }),
  });
  check('Несуществующий ник -> 401 с той же ошибкой', loginResp.status === 401, loginResp.status);

  // 18. Выход: сессия умирает
  const logoutResp = await fetchRetry(`${BASE}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  check('Logout отвечает ok', logoutResp.ok, logoutResp.status);
  meResp = await fetchRetry(`${BASE}/api/auth/me`, { headers: { Cookie: cookie } });
  meData = await meResp.json();
  check('После logout сессия недействительна', meData.username === null, meData);

  // 19. Вход с remember=false — cookie без Max-Age
  loginResp = await fetchRetry(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: loginNick, password: 'hunter2sekret', remember: false }),
  });
  const setCookie2 = loginResp.headers.get('set-cookie') || '';
  check('Вход без «запомнить» (cookie без Max-Age)', loginResp.status === 200 && !/max-age/i.test(setCookie2), setCookie2);
  console.log(failed === 0 ? '\nВсе проверки прошли ✓' : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('smoke-test упал:', e.message);
  process.exit(1);
});