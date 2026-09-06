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
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { stmts, createUser, verifyPassword, hashPassword } = require('./db');
const { startBot } = require('./tgbot');

// ---------- Анонимные ники ----------
const NICKS_FILE = path.join(__dirname, '..', 'nicks.csv');
var anonNicks = null;
function loadAnonNicks() {
  if (anonNicks) return anonNicks;
  try {
    var raw = fs.readFileSync(NICKS_FILE, 'utf8');
    anonNicks = raw.split(/\r?\n/).map(function (s) { return s.trim(); })
      .filter(function (s) { return s && !/^name$/i.test(s); });
  } catch (e) {
    console.error('[nicks] не удалось прочитать', NICKS_FILE, e.message);
    anonNicks = [];
  }
  return anonNicks;
}
function pickAnonNick() {
  var nicks = loadAnonNicks();
  if (!nicks.length) return null;
  return nicks[Math.floor(Math.random() * nicks.length)];
}

var app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10kb' }));

// ---------- Конфиг ----------

var PORT = Number(process.env.PORT) || 3000;
var REQUIRE_VERIFICATION = (process.env.REQUIRE_VERIFICATION || 'none').toLowerCase(); // none | telegram | email
var REGISTRATIONS_PER_IP_PER_DAY = Number(process.env.REGISTRATIONS_PER_IP_PER_DAY) || 3;
var SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 30;
var LOGIN_ATTEMPTS_WINDOW = 15 * 60 * 1000; // 15 минут
var LOGIN_MAX_ATTEMPTS = 10;
var COOKIE_NAME = 'caban_sid';
var POW_DIFFICULTY_BITS = Number(process.env.POW_DIFFICULTY_BITS) || 19;
var POW_CHALLENGE_TTL_MS = 10 * 60 * 1000;
var USERNAME_MIN = 3;
var USERNAME_MAX = 20;
var USERNAME_RE = /^[A-Za-z0-9_-]+$/;
var RESERVED_NAMES = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'root', 'support', 'system',
  'caban', 'cabanreports', 'reports', 'author', 'official', 'help', 'security',
]);

// ---------- Утилиты ----------

function getClientIpHash(req) {
  // ЗАДЕЛ НА БУДУЩЕЕ: за реверс-прокси смотреть в X-Forwarded-For.
  // Сейчас сервер торчит наружу напрямую — берем socket-адрес.
  var ip = req.socket.remoteAddress || 'unknown';
  var secret = process.env.IP_HASH_SECRET || 'dev-secret-change-me';
  return crypto.createHash('sha256').update(secret + ':' + ip).digest('hex');
}

function rateLimitExceeded(ipHash) {
  var day = new Date().toISOString().slice(0, 10);
  stmts.rlCleanup.run();
  var row = stmts.rlGet.get(ipHash, day);
  return Boolean(row && row.count >= REGISTRATIONS_PER_IP_PER_DAY);
}

function bumpRateLimit(ipHash) {
  var day = new Date().toISOString().slice(0, 10);
  stmts.rlUpsert.run(ipHash, day);
}

/** Окно брутфорс-лимита: 15-минутные слоты, округленные от текущего времени */
function attemptWindow() {
  var windowMs = Math.floor(Date.now() / LOGIN_ATTEMPTS_WINDOW) * LOGIN_ATTEMPTS_WINDOW;
  return new Date(windowMs).toISOString().replace('T', ' ').slice(0, 19);
}

function loginAttemptsExceeded(ipHash) {
  stmts.laCleanup.run();
  var row = stmts.laGet.get(ipHash, attemptWindow());
  return Boolean(row && row.count >= LOGIN_MAX_ATTEMPTS);
}

function bumpLoginAttempts(ipHash) {
  stmts.laUpsert.run(ipHash, attemptWindow());
}

// ---------- Сессии ----------

function parseCookies(req) {
  var header = req.headers.cookie || '';
  var out = {};
  for (var part of header.split(';')) {
    var i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(res, userId, remember) {
  var token = crypto.randomBytes(32).toString('hex');
  var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  var ttl = '+' + SESSION_TTL_DAYS + ' days';
  stmts.sessionInsert.run(tokenHash, userId, ttl);
  // remember=false -> сессионная cookie (умрет с браузером); true -> 30 дней
  var cookieOpts = [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    remember ? 'Max-Age=' + (SESSION_TTL_DAYS * 24 * 3600) : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookieOpts);
}

function destroySession(req, res) {
  var token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    stmts.sessionDelete.run(tokenHash);
  }
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

function getSessionUser(req) {
  var token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  var row = stmts.sessionGet.get(tokenHash);
  if (!row) return null;
  // Продлеваем сессию при активности (скользящее окно)
  stmts.sessionExtend.run('+' + SESSION_TTL_DAYS + ' days', tokenHash);
  return { userId: row.user_id, username: row.username, anonNick: row.anon_nick };
}

function validateUsername(raw) {
  var username = String(raw || '').trim();
  if (username.length < USERNAME_MIN) {
    return { error: 'Ник должен быть не короче ' + USERNAME_MIN + ' символов' };
  }
  if (username.length > USERNAME_MAX) {
    return { error: 'Ник должен быть не длиннее ' + USERNAME_MAX + ' символов' };
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
  return { username: username };
}

// ---------- PoW (hashcash) ----------

/**
 * Челленджи держим в памяти — это ок: они дешевые, TTL 10 минут.
 * id -> { prefix, difficulty, expires, used }
 * @type {Map<string, {prefix:string, difficulty:number, expires:number, used:boolean}>}
 */
var challenges = new Map();

function pruneChallenges() {
  var now = Date.now();
  for (var [id, ch] of challenges) {
    if (ch.expires < now) challenges.delete(id);
  }
}
setInterval(pruneChallenges, 60 * 1000).unref();

/** Число ведущих нулевых бит hex-строки */
function leadingZeroBits(hex) {
  var bits = 0;
  for (var c of hex) {
    var v = parseInt(c, 16);
    if (v === 0) { bits += 4; continue; }
    if (v < 2) bits += 3; else if (v < 4) bits += 2; else if (v < 8) bits += 1;
    break;
  }
  return bits;
}

/** Проверка решения PoW: sha256(prefix:nonce) должен иметь >= difficulty нулевых бит */
function verifyPow(prefix, nonce, difficulty) {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > Number.MAX_SAFE_INTEGER) return false;
  var digest = crypto.createHash('sha256').update(prefix + ':' + nonce).digest('hex');
  return leadingZeroBits(digest) >= difficulty;
}

// ---------- API ----------

// Выдать PoW-челлендж
app.get('/api/auth/challenge', function (req, res) {
  pruneChallenges();
  var id = crypto.randomBytes(16).toString('hex');
  var challenge = {
    id: id,
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
app.get('/api/auth/username-check', function (req, res) {
  var { error } = validateUsername(req.query.u);
  if (error) return res.json({ ok: false, error: error });
  res.json({ ok: true });
});

// Регистрация
app.post('/api/auth/register', function (req, res) {
  var body = req.body || {};

  // 1) Honeypot: люди это скрытое поле не видят и не заполняют
  if (body.website) {
    return res.status(400).json({ detail: 'Регистрация отклонена' });
  }

  // 2) Время заполнения: человек не отправит форму быстрее 3 секунд
  var elapsed = Date.now() - Number(body.formLoadedAt || 0);
  if (!Number.isFinite(elapsed) || elapsed < 3000) {
    return res.status(400).json({ detail: 'Слишком быстро. Так делают только боты.' });
  }

  // 3) PoW: браузер должен был честно посчитать хеши
  var chId = String(body.pow_id || '');
  var ch = challenges.get(chId);
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
  var ipHash = getClientIpHash(req);
  if (rateLimitExceeded(ipHash)) {
    return res.status(429).json({ detail: 'Слишком много регистраций с этого адреса. Попробуй завтра.' });
  }

  // 5) Ник
  var { username, error: nameError } = validateUsername(body.username);
  if (nameError) {
    return res.status(400).json({ detail: nameError });
  }

  // 6) Пароль
  var password = String(body.password || '');
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
      var user = createUser(username, password);
      return res.status(201).json({
        status: 'instant',
        message: 'Регистрация завершена',
        username: user.username,
      });
    }

    // ЗАДЕЛ: telegram | email — заявка с одноразовым кодом (20 минут)
    var { hashPassword } = require('./db');
    var { salt, hash } = hashPassword(password);
    var code = [
      crypto.randomBytes(2).toString('hex').toUpperCase(),
      crypto.randomBytes(2).toString('hex').toUpperCase(),
      crypto.randomBytes(2).toString('hex').toUpperCase(),
    ].join('-');
    stmts.insertPending.run(code, username, hash, salt, null, null);
    bumpRateLimit(ipHash);
    return res.status(202).json({
      status: 'pending',
      code: code,
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
app.post('/api/auth/register/status', function (req, res) {
  var code = String((req.body || {}).code || '');
  var row = stmts.getPendingByCode.get(code);
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
app.post('/api/auth/login', function (req, res) {
  var body = req.body || {};
  var username = String(body.username || '').trim();
  var password = String(body.password || '');
  var remember = Boolean(body.remember);

  var ipHash = getClientIpHash(req);

  // Брутфорс-лимит: 10 неудач за 15 минут с одного IP
  if (loginAttemptsExceeded(ipHash)) {
    return res.status(429).json({ detail: 'Слишком много попыток входа. Подожди четверть часа.' });
  }

  var user = stmts.getUserByName.get(username);

  // ВАЖНО: даже если ника нет — гоняем scrypt с фейковой солью,
  // чтобы время ответа не раскрывало существование ника.
  if (!user) {
    hashPassword(password, 'timing-equalizer-salt');
  }
  var ok = user ? verifyPassword(password, user.password_salt, user.password_hash) : false;
  if (!ok) {
    bumpLoginAttempts(ipHash);
    // Одна и та же ошибка и для неверного пароля, и для несуществующего ника
    return res.status(401).json({ detail: 'Неверный ник или пароль' });
  }

  createSession(res, user.id, remember);
  return res.json({ username: user.username });
});

// Текущий пользователь (для шапки сайта)
app.get('/api/auth/me', function (req, res) {
  var user = getSessionUser(req);
  if (!user) return res.json({ username: null, id: null });
  return res.json({ username: user.username, id: user.userId });
});

// Выход
app.post('/api/auth/logout', function (req, res) {
  destroySession(req, res);
  return res.json({ ok: true });
});

// ---------- Комментарии и реакции ----------

// page_id из URL запроса: только безопасные символы
function pageIdFromRequest(raw) {
  var pageId = String(raw || '').replace(/^\/+|\/+$/g, '');
  if (!pageId || pageId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(pageId)) return null;
  return pageId;
}

// Список комментариев (видно всем)
app.get('/api/pages/:page/comments', function (req, res) {
  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });
  var rows = stmts.commentsList.all(pageId);
  var user = getSessionUser(req);
  var comments = rows.map(function (r) {
    return {
      id: r.id,
      display_name: r.display_name,
      text: r.text,
      created_at: r.created_at,
      mine: Boolean(user && r.user_id === user.userId),
    };
  });
  return res.json({ comments: comments });
});

// Отправить комментарий (только для вошедших)
app.post('/api/pages/:page/comments', function (req, res) {
  var user = getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  var body = req.body || {};
  var text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ detail: 'Комментарий пуст' });
  if (text.length > 1000) return res.status(400).json({ detail: 'Комментарий слишком длинный (макс. 1000 символов)' });

  // Антиспам: не чаще одного комментария в 10 секунд
  if (stmts.commentCountRecent.get(user.userId).n > 0) {
    return res.status(429).json({ detail: 'Не так часто — подожди немного' });
  }

  var anonymous = Boolean(body.anonymous);
  var displayName;
  if (anonymous) {
    // Если у пользователя ещё нет анонимного ника — выбрать и сохранить
    if (!user.anonNick) {
      var nick = pickAnonNick();
      if (!nick) return res.status(400).json({ detail: 'Анонимные комментарии пока недоступны' });
      stmts.userSetAnonNick.run(nick, user.userId);
      displayName = nick;
    } else {
      displayName = user.anonNick;
    }
  } else {
    displayName = user.username;
  }

  var info = stmts.commentInsert.run(pageId, user.userId, displayName, text);
  var created = stmts.commentGetById.get(info.lastInsertRowid);
  created.mine = true;
  return res.status(201).json({ comment: created });
});

// Удалить комментарий (только автор)
app.delete('/api/pages/:page/comments/:id', function (req, res) {
  var user = getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  var id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ detail: 'Плохой id комментария' });

  var info = stmts.commentDeleteByAuthor.run(id, user.userId);
  if (info.changes === 0) {
    return res.status(404).json({ detail: 'Комментарий не найден или вы не его автор' });
  }
  return res.json({ ok: true });
});

// Реакции: счетчики + голос текущего пользователя
app.get('/api/pages/:page/reactions', function (req, res) {
  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });
  var counts = stmts.reactionCounts.get(pageId);
  var user = getSessionUser(req);
  var my = user ? (stmts.reactionGet.get(pageId, user.userId) || {}).value || 0 : 0;
  return res.json({ likes: counts.likes, dislikes: counts.dislikes, my: my });
});

// Поставить/переключить/снять реакцию (только для вошедших)
app.post('/api/pages/:page/reactions', function (req, res) {
  var user = getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  var value = (req.body || {}).value;
  if (value === 0) {
    stmts.reactionDelete.run(pageId, user.userId);
  } else if (value === 1 || value === -1) {
    stmts.reactionUpsert.run(pageId, user.userId, value);
  } else {
    return res.status(400).json({ detail: 'Значение реакции: 1, -1 или 0' });
  }

  var counts = stmts.reactionCounts.get(pageId);
  var my = (stmts.reactionGet.get(pageId, user.userId) || {}).value || 0;
  return res.json({ likes: counts.likes, dislikes: counts.dislikes, my: my });
});

// ---------- Статика ----------

// Сам сайт лежит на уровень выше (корень репозитория)
var WEB_ROOT = path.join(__dirname, '..');
app.use(express.static(WEB_ROOT, { extensions: ['html'] }));

// ---------- Запуск ----------

app.listen(PORT, function () {
  console.log('[cabanreports] сервер: http://localhost:' + PORT);
  console.log('[cabanreports] верификация: ' + REQUIRE_VERIFICATION);
  startBot();
});