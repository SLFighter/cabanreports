/**
 * «Кабаньи сводки» — сервер.
 *
 * Раздает статику сайта (корень репозитория) и API регистрации.
 *
 * API:
 *   GET  /api/auth/challenge          — выдать PoW-челлендж
 *   GET  /api/auth/username-check?u=… — проверить ник (занятость/валидность)
 *   POST /api/auth/register           — регистрация
 *   POST /api/auth/register/status    — статус заявки (для будущего подтверждения)
 *
 * Конфиг — .env рядом с index.js (см. .env.example).
 */

'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { stmts, createUser, verifyPassword, hashPassword } = require('./db');
const { startBot } = require('./tgbot');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// ---------- Конфиг ----------

const PORT = Number(process.env.PORT) || 3000;
const REQUIRE_VERIFICATION = (process.env.REQUIRE_VERIFICATION || 'none').toLowerCase(); // none | telegram | email
const REGISTRATIONS_PER_IP_PER_DAY = Number(process.env.REGISTRATIONS_PER_IP_PER_DAY) || 3;
const SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 30;
const LOGIN_ATTEMPTS_WINDOW = 15 * 60 * 1000; // 15 минут
const LOGIN_MAX_ATTEMPTS = 10;
const COOKIE_NAME = 'caban_sid';
const POW_DIFFICULTY_BITS = Number(process.env.POW_DIFFICULTY_BITS) || 19;
const POW_CHALLENGE_TTL_MS = 10 * 60 * 1000;
const USERNAME_MIN = 3;
const USERNAME_MAX = 20;
const USERNAME_RE = /^[A-Za-z0-9_-]+$/;
const RESERVED_NAMES = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'root', 'support', 'system',
  'caban', 'cabanreports', 'reports', 'author', 'official', 'help', 'security',
]);

// ---------- Утилиты ----------

function getClientIpHash(req) {
  // ЗАДЕЛ НА БУДУЩЕЕ: за реверс-прокси смотреть в X-Forwarded-For.
  // Сейчас сервер торчит наружу напрямую — берем socket-адрес.
  const ip = req.socket.remoteAddress || 'unknown';
  const secret = process.env.IP_HASH_SECRET || 'dev-secret-change-me';
  return crypto.createHash('sha256').update(`${secret}:${ip}`).digest('hex');
}

function rateLimitExceeded(ipHash) {
  const day = new Date().toISOString().slice(0, 10);
  stmts.rlCleanup.run();
  const row = stmts.rlGet.get(ipHash, day);
  return Boolean(row && row.count >= REGISTRATIONS_PER_IP_PER_DAY);
}

function bumpRateLimit(ipHash) {
  const day = new Date().toISOString().slice(0, 10);
  stmts.rlUpsert.run(ipHash, day);
}

/** Окно брутфорс-лимита: 15-минутные слоты, округленные от текущего времени */
function attemptWindow() {
  const windowMs = Math.floor(Date.now() / LOGIN_ATTEMPTS_WINDOW) * LOGIN_ATTEMPTS_WINDOW;
  return new Date(windowMs).toISOString().replace('T', ' ').slice(0, 19);
}

function loginAttemptsExceeded(ipHash) {
  stmts.laCleanup.run();
  const row = stmts.laGet.get(ipHash, attemptWindow());
  return Boolean(row && row.count >= LOGIN_MAX_ATTEMPTS);
}

function bumpLoginAttempts(ipHash) {
  stmts.laUpsert.run(ipHash, attemptWindow());
}

// ---------- Сессии ----------

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId, remember) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const ttl = `+${SESSION_TTL_DAYS} days`;
  stmts.sessionInsert.run(tokenHash, userId, ttl);
  // remember=false -> сессионная cookie (умрет с браузером); true -> 30 дней
  const cookieOpts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    remember ? `Max-Age=${SESSION_TTL_DAYS * 24 * 3600}` : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookieOpts);
}

function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    stmts.sessionDelete.run(tokenHash);
  }
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function getSessionUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const row = stmts.sessionGet.get(tokenHash);
  if (!row) return null;
  // Продлеваем сессию при активности (скользящее окно)
  stmts.sessionExtend.run(`+${SESSION_TTL_DAYS} days`, tokenHash);
  return { userId: row.user_id, username: row.username };
}

function validateUsername(raw) {
  const username = String(raw || '').trim();
  if (username.length < USERNAME_MIN) {
    return { error: `Ник должен быть не короче ${USERNAME_MIN} символов` };
  }
  if (username.length > USERNAME_MAX) {
    return { error: `Ник должен быть не длиннее ${USERNAME_MAX} символов` };
  }
  if (!USERNAME_RE.test(username)) {
    return { error: 'Ник может содержать только латиницу, цифры, "_" и "-"' };
  }
  if (RESERVED_NAMES.has(username.toLowerCase())) {
    return { error: 'Этот ник зарезервирован' };
  }
  if (stmts.getUserByName.get(username)) {
    return { error: 'Ник уже занят' };
  }
  return { username };
}

// ---------- PoW (hashcash) ----------

/**
 * Челленджи держим в памяти — это ок: они дешевые, TTL 10 минут.
 * id -> { prefix, difficulty, expires, used }
 * @type {Map<string, {prefix:string, difficulty:number, expires:number, used:boolean}>}
 */
const challenges = new Map();

function pruneChallenges() {
  const now = Date.now();
  for (const [id, ch] of challenges) {
    if (ch.expires < now) challenges.delete(id);
  }
}
setInterval(pruneChallenges, 60 * 1000).unref();

/** Число ведущих нулевых бит hex-строки */
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

/** Проверка решения PoW: sha256(prefix:nonce) должен иметь >= difficulty нулевых бит */
function verifyPow(prefix, nonce, difficulty) {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > Number.MAX_SAFE_INTEGER) return false;
  const digest = crypto.createHash('sha256').update(`${prefix}:${nonce}`).digest('hex');
  return leadingZeroBits(digest) >= difficulty;
}

// ---------- API ----------

// Выдать PoW-челлендж
app.get('/api/auth/challenge', (req, res) => {
  pruneChallenges();
  const id = crypto.randomBytes(16).toString('hex');
  const challenge = {
    id,
    difficulty: POW_DIFFICULTY_BITS, // сколько ведущих нулевых бит искать
    prefix: crypto.randomBytes(8).toString('hex'),
  };
  challenges.set(id, {
    prefix: challenge.prefix,
    difficulty: challenge.difficulty,
    expires: Date.now() + POW_CHALLENGE_TTL_MS,
    used: false,
  });
  res.json(challenge);
});

// Проверка ника (живая, при вводе)
app.get('/api/auth/username-check', (req, res) => {
  const { error } = validateUsername(req.query.u);
  if (error) return res.json({ ok: false, error });
  res.json({ ok: true });
});

// Регистрация
app.post('/api/auth/register', (req, res) => {
  const body = req.body || {};

  // 1) Honeypot: люди это скрытое поле не видят и не заполняют
  if (body.website) {
    return res.status(400).json({ detail: 'Регистрация отклонена' });
  }

  // 2) Время заполнения: человек не отправит форму быстрее 3 секунд
  const elapsed = Date.now() - Number(body.formLoadedAt || 0);
  if (!Number.isFinite(elapsed) || elapsed < 3000) {
    return res.status(400).json({ detail: 'Слишком быстро. Так делают только боты.' });
  }

  // 3) PoW: браузер должен был честно посчитать хеши
  const chId = String(body.pow_id || '');
  const ch = challenges.get(chId);
  if (!ch) {
    return res.status(400).json({ detail: 'Челлендж не найден или устарел — обнови страницу' });
  }
  if (ch.used) {
    return res.status(400).json({ detail: 'Челлендж уже использован — обнови страницу' });
  }
  if (!verifyPow(ch.prefix, body.pow_nonce, ch.difficulty)) {
    return res.status(400).json({ detail: 'Проверка вычислений не пройдена — обнови страницу' });
  }
  ch.used = true; // одноразовость

  // 4) Rate limit по IP (хранится только хеш IP, не сам IP).
  //    Проверяем сразу, а увеличиваем счетчик только при успешной регистрации,
  //    чтобы кривые запросы не сжигали лимит.
  const ipHash = getClientIpHash(req);
  if (rateLimitExceeded(ipHash)) {
    return res.status(429).json({ detail: 'Слишком много регистраций с этого адреса. Попробуй завтра.' });
  }

  // 5) Ник
  const { username, error: nameError } = validateUsername(body.username);
  if (nameError) {
    return res.status(400).json({ detail: nameError });
  }

  // 6) Пароль
  const password = String(body.password || '');
  if (password.length < 6) {
    return res.status(400).json({ detail: 'Пароль должен быть не короче 6 символов' });
  }
  if (password.length > 128) {
    return res.status(400).json({ detail: 'Пароль слишком длинный' });
  }

  // 7) Создание учетки или заявки — по режиму верификации
  try {
    if (REQUIRE_VERIFICATION === 'none') {
      bumpRateLimit(ipHash);
      const user = createUser(username, password);
      return res.status(201).json({
        status: 'instant',
        message: 'Регистрация завершена',
        username: user.username,
      });
    }

    // ЗАДЕЛ: telegram | email — заявка с одноразовым кодом (20 минут)
    const { hashPassword } = require('./db');
    const { salt, hash } = hashPassword(password);
    const code = [
      crypto.randomBytes(2).toString('hex').toUpperCase(),
      crypto.randomBytes(2).toString('hex').toUpperCase(),
      crypto.randomBytes(2).toString('hex').toUpperCase(),
    ].join('-');
    stmts.insertPending.run(code, username, hash, salt, null, null);
    bumpRateLimit(ipHash);
    return res.status(202).json({
      status: 'pending',
      code,
      message: REQUIRE_VERIFICATION === 'telegram'
        ? 'Подтверди регистрацию в Telegram-боте'
        : 'Подтверди регистрацию по email',
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE constraint failed: users.username')) {
      return res.status(409).json({ detail: 'Ник уже занят' });
    }
    console.error('register error:', err);
    return res.status(500).json({ detail: 'Внутренняя ошибка сервера' });
  }
});

// Статус заявки (polling; понадобится для telegram/email верификации)
app.post('/api/auth/register/status', (req, res) => {
  const code = String((req.body || {}).code || '');
  const row = stmts.getPendingByCode.get(code);
  if (!row) {
    return res.json({ status: 'not_found' });
  }
  return res.json({
    status: 'pending',
    confirmed: Boolean(row.telegram_id || row.email),
  });
});

// ---------- Вход / выход / текущий пользователь ----------

// Вход: ник + пароль -> cookie сессии
app.post('/api/auth/login', (req, res) => {
  const body = req.body || {};
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  const remember = Boolean(body.remember);

  const ipHash = getClientIpHash(req);

  // Брутфорс-лимит: 10 неудач за 15 минут с одного IP
  if (loginAttemptsExceeded(ipHash)) {
    return res.status(429).json({ detail: 'Слишком много попыток входа. Подожди четверть часа.' });
  }

  const user = stmts.getUserByName.get(username);

  // ВАЖНО: даже если ника нет — гоняем scrypt с фейковой солью,
  // чтобы время ответа не раскрывало существование ника.
  if (!user) {
    hashPassword(password, 'timing-equalizer-salt');
  }
  const ok = user ? verifyPassword(password, user.password_salt, user.password_hash) : false;
  if (!ok) {
    bumpLoginAttempts(ipHash);
    // Одна и та же ошибка и для неверного пароля, и для несуществующего ника
    return res.status(401).json({ detail: 'Неверный ник или пароль' });
  }

  createSession(res, user.id, remember);
  return res.json({ username: user.username });
});

// Текущий пользователь (для шапки сайта)
app.get('/api/auth/me', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.json({ username: null });
  return res.json({ username: user.username });
});

// Выход
app.post('/api/auth/logout', (req, res) => {
  destroySession(req, res);
  return res.json({ ok: true });
});

// ---------- Комментарии и реакции ----------

// page_id из URL запроса: только безопасные символы
function pageIdFromRequest(raw) {
  const pageId = String(raw || '').replace(/^\/+|\/+$/g, '');
  if (!pageId || pageId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(pageId)) return null;
  return pageId;
}

// Список комментариев (видно всем)
app.get('/api/pages/:page/comments', (req, res) => {
  const pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });
  const rows = stmts.commentsList.all(pageId);
  return res.json({ comments: rows });
});

// Отправить комментарий (только для вошедших)
app.post('/api/pages/:page/comments', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  const pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  const body = req.body || {};
  const text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ detail: 'Комментарий пуст' });
  if (text.length > 1000) return res.status(400).json({ detail: 'Комментарий слишком длинный (макс. 1000 символов)' });

  // Антиспам: не чаще одного комментария в 10 секунд
  if (stmts.commentCountRecent.get(user.userId).n > 0) {
    return res.status(429).json({ detail: 'Не так часто — подожди немного' });
  }

  // ЗАДЕЛ: анонимные комментарии — ник из nicks.csv (файл пока не существует)
  if (body.anonymous) {
    return res.status(400).json({ detail: 'Анонимные комментарии пока недоступны' });
  }

  const displayName = user.username;
  const info = stmts.commentInsert.run(pageId, user.userId, displayName, text);
  const created = stmts.commentGetById.get(info.lastInsertRowid);
  return res.status(201).json({ comment: created });
});

// Реакции: счетчики + голос текущего пользователя
app.get('/api/pages/:page/reactions', (req, res) => {
  const pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });
  const counts = stmts.reactionCounts.get(pageId);
  const user = getSessionUser(req);
  const my = user ? (stmts.reactionGet.get(pageId, user.userId) || {}).value || 0 : 0;
  return res.json({ likes: counts.likes, dislikes: counts.dislikes, my });
});

// Поставить/переключить/снять реакцию (только для вошедших)
app.post('/api/pages/:page/reactions', (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  const pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  const value = (req.body || {}).value;
  if (value === 0) {
    stmts.reactionDelete.run(pageId, user.userId);
  } else if (value === 1 || value === -1) {
    stmts.reactionUpsert.run(pageId, user.userId, value);
  } else {
    return res.status(400).json({ detail: 'Значение реакции: 1, -1 или 0' });
  }

  const counts = stmts.reactionCounts.get(pageId);
  const my = (stmts.reactionGet.get(pageId, user.userId) || {}).value || 0;
  return res.json({ likes: counts.likes, dislikes: counts.dislikes, my });
});

// ---------- Статика ----------

// Сам сайт лежит на уровень выше (корень репозитория)
const WEB_ROOT = path.join(__dirname, '..');
app.use(express.static(WEB_ROOT, { extensions: ['html'] }));

// ---------- Запуск ----------

app.listen(PORT, () => {
  console.log(`[cabanreports] сервер: http://localhost:${PORT}`);
  console.log(`[cabanreports] верификация: ${REQUIRE_VERIFICATION}`);
  startBot();
});