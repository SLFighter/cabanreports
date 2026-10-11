'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { stmts, createUser, verifyPassword, hashPassword, migrate } = require('./db');
const { startBot } = require('./tgbot');

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

var PORT = Number(process.env.PORT) || 3000;
var REQUIRE_VERIFICATION = (process.env.REQUIRE_VERIFICATION || 'none').toLowerCase();
var REGISTRATIONS_PER_IP_PER_DAY = Number(process.env.REGISTRATIONS_PER_IP_PER_DAY) || 3;
var SESSION_TTL_DAYS = Number(process.env.SESSION_TTL_DAYS) || 30;
var LOGIN_ATTEMPTS_WINDOW = 15 * 60 * 1000;
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

function getClientIpHash(req) {
  var ip = req.socket.remoteAddress || 'unknown';
  var secret = process.env.IP_HASH_SECRET || 'dev-secret-change-me';
  return crypto.createHash('sha256').update(secret + ':' + ip).digest('hex');
}

async function rateLimitExceeded(ipHash) {
  var day = new Date().toISOString().slice(0, 10);
  await stmts.rlCleanup();
  var row = await stmts.rlGet(ipHash, day);
  return Boolean(row && row.count >= REGISTRATIONS_PER_IP_PER_DAY);
}

async function bumpRateLimit(ipHash) {
  var day = new Date().toISOString().slice(0, 10);
  await stmts.rlUpsert(ipHash, day);
}

function attemptWindow() {
  var windowMs = Math.floor(Date.now() / LOGIN_ATTEMPTS_WINDOW) * LOGIN_ATTEMPTS_WINDOW;
  return new Date(windowMs).toISOString().replace('T', ' ').slice(0, 19);
}

async function loginAttemptsExceeded(ipHash) {
  await stmts.laCleanup();
  var row = await stmts.laGet(ipHash, attemptWindow());
  return Boolean(row && row.count >= LOGIN_MAX_ATTEMPTS);
}

async function bumpLoginAttempts(ipHash) {
  await stmts.laUpsert(ipHash, attemptWindow());
}

function parseCookies(req) {
  var header = req.headers.cookie || '';
  var out = {};
  for (var part of header.split(';')) {
    var i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function createSession(res, userId, remember) {
  var token = crypto.randomBytes(32).toString('hex');
  var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await stmts.sessionInsert(tokenHash, userId, SESSION_TTL_DAYS);
  var cookieOpts = [
    COOKIE_NAME + '=' + token,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    remember ? 'Max-Age=' + (SESSION_TTL_DAYS * 24 * 3600) : '',
  ].filter(Boolean).join('; ');
  res.setHeader('Set-Cookie', cookieOpts);
}

async function destroySession(req, res) {
  var token = parseCookies(req)[COOKIE_NAME];
  if (token) {
    var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await stmts.sessionDelete(tokenHash);
  }
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

async function getSessionUser(req) {
  var token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  var tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  var row = await stmts.sessionGet(tokenHash);
  if (!row) return null;
  await stmts.sessionExtend(SESSION_TTL_DAYS, tokenHash);
  return { userId: row.user_id, username: row.username, anonNick: row.anon_nick, isAdmin: row.is_admin };
}

async function validateUsername(raw) {
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
  if (await stmts.getUserByName(username)) {
    return { error: 'Ник уже занят' };
  }
  return { username: username };
}

var challenges = new Map();

function pruneChallenges() {
  var now = Date.now();
  for (var [id, ch] of challenges) {
    if (ch.expires < now) challenges.delete(id);
  }
}
setInterval(pruneChallenges, 60 * 1000).unref();

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

function verifyPow(prefix, nonce, difficulty) {
  if (!Number.isInteger(nonce) || nonce < 0 || nonce > Number.MAX_SAFE_INTEGER) return false;
  var digest = crypto.createHash('sha256').update(prefix + ':' + nonce).digest('hex');
  return leadingZeroBits(digest) >= difficulty;
}

app.get('/api/auth/challenge', function (req, res) {
  pruneChallenges();
  var id = crypto.randomBytes(16).toString('hex');
  var challenge = {
    id: id,
    difficulty: POW_DIFFICULTY_BITS,
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

app.get('/api/auth/username-check', async function (req, res) {
  var { error } = await validateUsername(req.query.u);
  if (error) return res.json({ ok: false, error: error });
  res.json({ ok: true });
});

app.post('/api/auth/register', async function (req, res) {
  var body = req.body || {};

  if (body.website) {
    return res.status(400).json({ detail: 'Регистрация отклонена' });
  }

  var elapsed = Date.now() - Number(body.formLoadedAt || 0);
  if (!Number.isFinite(elapsed) || elapsed < 3000) {
    return res.status(400).json({ detail: 'Слишком быстро. Так делают только боты.' });
  }

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
  ch.used = true;

  var ipHash = getClientIpHash(req);
  if (await rateLimitExceeded(ipHash)) {
    return res.status(429).json({ detail: 'Слишком много регистраций с этого адреса. Попробуй завтра.' });
  }

  var { username, error: nameError } = await validateUsername(body.username);
  if (nameError) {
    return res.status(400).json({ detail: nameError });
  }

  var password = String(body.password || '');
  if (password.length < 6) {
    return res.status(400).json({ detail: 'Пароль должен быть не короче 6 символов' });
  }
  if (password.length > 128) {
    return res.status(400).json({ detail: 'Пароль слишком длинный' });
  }

  try {
    if (REQUIRE_VERIFICATION === 'none') {
      await bumpRateLimit(ipHash);
      var user = await createUser(username, password);
      return res.status(201).json({
        status: 'instant',
        message: 'Регистрация завершена',
        username: user.username,
      });
    }

    var { salt, hash } = hashPassword(password);
    var code = [
      crypto.randomBytes(2).toString('hex').toUpperCase(),
      crypto.randomBytes(2).toString('hex').toUpperCase(),
      crypto.randomBytes(2).toString('hex').toUpperCase(),
    ].join('-');
    await stmts.insertPending(code, username, hash, salt, null, null);
    await bumpRateLimit(ipHash);
    return res.status(202).json({
      status: 'pending',
      code: code,
      message: REQUIRE_VERIFICATION === 'telegram'
        ? 'Подтверди регистрацию в Telegram-боте'
        : 'Подтверди регистрацию по email',
    });
  } catch (err) {
    if (err && err.code === '23505' && String(err.detail || '').includes('username')) {
      return res.status(409).json({ detail: 'Ник уже занят' });
    }
    console.error('register error:', err);
    return res.status(500).json({ detail: 'Внутренняя ошибка сервера' });
  }
});

app.post('/api/auth/register/status', async function (req, res) {
  var code = String((req.body || {}).code || '');
  var row = await stmts.getPendingByCode(code);
  if (!row) {
    return res.json({ status: 'not_found' });
  }
  return res.json({
    status: 'pending',
    confirmed: Boolean(row.telegram_id || row.email),
  });
});

app.post('/api/auth/login', async function (req, res) {
  var body = req.body || {};
  var username = String(body.username || '').trim();
  var password = String(body.password || '');
  var remember = Boolean(body.remember);

  var ipHash = getClientIpHash(req);

  if (await loginAttemptsExceeded(ipHash)) {
    return res.status(429).json({ detail: 'Слишком много попыток входа. Подожди четверть часа.' });
  }

  var user = await stmts.getUserByName(username);

  if (!user) {
    hashPassword(password, 'timing-equalizer-salt');
  }
  var ok = user ? verifyPassword(password, user.password_salt, user.password_hash) : false;
  if (!ok) {
    await bumpLoginAttempts(ipHash);
    return res.status(401).json({ detail: 'Неверный ник или пароль' });
  }

  await createSession(res, user.id, remember);
  return res.json({ username: user.username });
});

app.get('/api/auth/me', async function (req, res) {
  var user = await getSessionUser(req);
  if (!user) return res.json({ username: null, id: null });
  return res.json({ username: user.username, id: user.userId, isAdmin: user.isAdmin });
});

app.post('/api/auth/logout', async function (req, res) {
  await destroySession(req, res);
  return res.json({ ok: true });
});

function pageIdFromRequest(raw) {
  var pageId = String(raw || '').replace(/^\/+|\/+$/g, '');
  if (!pageId || pageId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(pageId)) return null;
  return pageId;
}

app.get('/api/pages/:page/comments', async function (req, res) {
  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });
  var rows = await stmts.commentsList(pageId);
  var user = await getSessionUser(req);
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

app.post('/api/pages/:page/comments', async function (req, res) {
  var user = await getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  var body = req.body || {};
  var text = String(body.text || '').trim();
  if (!text) return res.status(400).json({ detail: 'Комментарий пуст' });
  if (text.length > 1000) return res.status(400).json({ detail: 'Комментарий слишком длинный (макс. 1000 символов)' });

  var recent = await stmts.commentCountRecent(user.userId);
  if (recent > 0) {
    return res.status(429).json({ detail: 'Не так часто — подожди немного' });
  }

  var anonymous = Boolean(body.anonymous);
  var displayName;
  if (anonymous) {
    if (!user.anonNick) {
      var nick = pickAnonNick();
      if (!nick) return res.status(400).json({ detail: 'Анонимные комментарии пока недоступны' });
      await stmts.userSetAnonNick(nick, user.userId);
      displayName = nick;
    } else {
      displayName = user.anonNick;
    }
  } else {
    displayName = user.username;
  }

  var created = await stmts.commentInsert(pageId, user.userId, displayName, text);
  created.mine = true;
  return res.status(201).json({ comment: created });
});

app.delete('/api/pages/:page/comments/:id', async function (req, res) {
  var user = await getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  var id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ detail: 'Плохой id комментария' });

  var info = await stmts.commentDeleteByAuthor(id, user.userId);
  if (info.changes === 0) {
    return res.status(404).json({ detail: 'Комментарий не найден или вы не его автор' });
  }
  return res.json({ ok: true });
});

app.get('/api/pages/:page/reactions', async function (req, res) {
  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });
  var counts = await stmts.reactionCounts(pageId);
  var commentsCount = await stmts.commentsCount(pageId);
  var user = await getSessionUser(req);
  var my = user ? ((await stmts.reactionGet(pageId, user.userId)) || {}).value || 0 : 0;
  return res.json({ likes: counts.likes, dislikes: counts.dislikes, comments: commentsCount, my: my });
});

app.post('/api/pages/:page/reactions', async function (req, res) {
  var user = await getSessionUser(req);
  if (!user) return res.status(401).json({ detail: 'Требуется вход' });

  var pageId = pageIdFromRequest(req.params.page);
  if (!pageId) return res.status(400).json({ detail: 'Плохой идентификатор страницы' });

  var value = (req.body || {}).value;
  if (value === 0) {
    await stmts.reactionDelete(pageId, user.userId);
  } else if (value === 1 || value === -1) {
    await stmts.reactionUpsert(pageId, user.userId, value);
  } else {
    return res.status(400).json({ detail: 'Значение реакции: 1, -1 или 0' });
  }

  var counts = await stmts.reactionCounts(pageId);
  var my = ((await stmts.reactionGet(pageId, user.userId)) || {}).value || 0;
  return res.json({ likes: counts.likes, dislikes: counts.dislikes, my: my });
});

// ---------- ADMIN ----------
const { pool } = require('./db');

const ADMIN_TABLES = {
  users: {
    pk: ['id'],
    cols: ['id', 'username', 'anon_nick', 'telegram_id', 'email', 'status', 'is_admin', 'created_at'],
    editable: ['username', 'anon_nick', 'telegram_id', 'email', 'status'],
    search: ['username', 'email'],
    order: 'id',
  },
  comments: {
    pk: ['id'],
    cols: ['id', 'page_id', 'user_id', 'display_name', 'text', 'created_at'],
    editable: ['page_id', 'display_name', 'text'],
    search: ['page_id', 'display_name', 'text'],
    order: 'id',
  },
  reactions: {
    pk: ['page_id', 'user_id'],
    cols: ['page_id', 'user_id', 'value', 'updated_at'],
    editable: ['value'],
    search: ['page_id'],
    order: 'updated_at',
  },
};

async function requireAdmin(req, res, next) {
  try {
    var user = await getSessionUser(req);
    if (!user) return res.status(401).json({ detail: 'Требуется вход' });
    if (!user.isAdmin) return res.status(403).json({ detail: 'Только для админа' });
    req.admin = user;
    next();
  } catch (e) { next(e); }
}

function tableCfg(req, res) {
  var cfg = ADMIN_TABLES[req.params.table];
  if (!cfg) res.status(404).json({ detail: 'Нет такой таблицы' });
  return cfg;
}

// whereByPk: строим WHERE только из pk-колонок конфига (имена колонок берутся из whitelist, не от клиента)
function whereByPk(cfg, pk, startIdx) {
  var params = [], parts = [];
  for (var i = 0; i < cfg.pk.length; i++) {
    var v = pk && pk[cfg.pk[i]];
    if (v === undefined || v === null) return null;
    params.push(v);
    parts.push(cfg.pk[i] + ' = $' + (startIdx + i));
  }
  return { sql: parts.join(' AND '), params: params };
}

app.get('/api/admin/tables', requireAdmin, function (req, res) {
  var out = {};
  for (var name in ADMIN_TABLES) out[name] = { cols: ADMIN_TABLES[name].cols, editable: ADMIN_TABLES[name].editable, pk: ADMIN_TABLES[name].pk };
  res.json(out);
});

app.get('/api/admin/tables/:table', requireAdmin, async function (req, res) {
  var cfg = tableCfg(req, res); if (!cfg) return;
  var limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  var offset = Math.max(Number(req.query.offset) || 0, 0);
  var q = String(req.query.q || '').trim();
  var params = [], where = '';
  if (q) {
    params.push('%' + q + '%');
    where = 'WHERE ' + cfg.search.map(function (c) { return c + '::text ILIKE $1'; }).join(' OR ');
  }
  var total = (await pool.query('SELECT count(*)::int AS n FROM ' + req.params.table + ' ' + where, params)).rows[0].n;
  params.push(limit, offset);
  var rows = (await pool.query(
    'SELECT ' + cfg.cols.join(', ') + ' FROM ' + req.params.table + ' ' + where +
    ' ORDER BY ' + cfg.order + ' DESC LIMIT $' + (params.length - 1) + ' OFFSET $' + params.length, params
  )).rows;
  res.json({ total: total, rows: rows });
});

app.patch('/api/admin/tables/:table', requireAdmin, async function (req, res) {
  var cfg = tableCfg(req, res); if (!cfg) return;
  var body = req.body || {};
  var changes = body.changes || {};
  var keys = Object.keys(changes).filter(function (k) { return cfg.editable.includes(k); });
  if (!keys.length) return res.status(400).json({ detail: 'Нечего менять' });

  var sets = [], params = [];
  keys.forEach(function (k) {
    var v = changes[k];
    if (v === '') v = null;
    params.push(v);
    sets.push(k + ' = $' + params.length);
  });
  if (req.params.table === 'users' && keys.includes('username')) {
    params.push(String(changes.username).toLowerCase());
    sets.push('username_lc = $' + params.length);
  }
  var w = whereByPk(cfg, body.pk, params.length + 1);
  if (!w) return res.status(400).json({ detail: 'Нет первичного ключа' });
  try {
    var r = await pool.query('UPDATE ' + req.params.table + ' SET ' + sets.join(', ') +
      ' WHERE ' + w.sql + ' RETURNING ' + cfg.cols.join(', '), params.concat(w.params));
    if (!r.rowCount) return res.status(404).json({ detail: 'Строка не найдена' });
    res.json({ row: r.rows[0] });
  } catch (e) {
    res.status(400).json({ detail: e.detail || e.message });
  }
});

app.delete('/api/admin/tables/:table', requireAdmin, async function (req, res) {
  var cfg = tableCfg(req, res); if (!cfg) return;
  var pk = (req.body || {}).pk;
  if (req.params.table === 'users' && String(pk && pk.id) === String(req.admin.userId)) {
    return res.status(400).json({ detail: 'Себя удалять нельзя' });
  }
  var w = whereByPk(cfg, pk, 1);
  if (!w) return res.status(400).json({ detail: 'Нет первичного ключа' });
  var r = await pool.query('DELETE FROM ' + req.params.table + ' WHERE ' + w.sql, w.params);
  if (!r.rowCount) return res.status(404).json({ detail: 'Строка не найдена' });
  res.json({ ok: true });
});

var WEB_ROOT = path.join(__dirname, '..');
app.use(express.static(WEB_ROOT, { extensions: ['html'] }));

async function main() {
  await migrate();
  app.listen(PORT, function () {
    console.log('[cabanreports] сервер: http://localhost:' + PORT);
    console.log('[cabanreports] верификация: ' + REQUIRE_VERIFICATION);
    startBot();
  });
}

main().catch(function (err) {
  console.error('[cabanreports] не удалось запуститься:', err.message);
  process.exit(1);
});
