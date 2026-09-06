'use strict';

const { Pool } = require('pg');
const crypto = require('crypto');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('[db] DATABASE_URL не задан — серверу нужна база Postgres.');
  process.exit(1);
}

const pool = new Pool({ connectionString });

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            BIGSERIAL PRIMARY KEY,
      username      TEXT    NOT NULL UNIQUE,
      username_lc   TEXT    NOT NULL UNIQUE,
      password_hash TEXT    NOT NULL,
      password_salt TEXT    NOT NULL,
      anon_nick     TEXT,
      telegram_id   BIGINT UNIQUE,
      email         TEXT,
      status        TEXT    NOT NULL DEFAULT 'active',
      created_at    TEXT    NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS pending_registrations (
      id            BIGSERIAL PRIMARY KEY,
      code          TEXT    NOT NULL UNIQUE,
      username      TEXT    NOT NULL,
      password_hash TEXT    NOT NULL,
      password_salt TEXT    NOT NULL,
      telegram_id   BIGINT,
      email         TEXT,
      created_at    TEXT    NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      expires_at    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_registrations (expires_at);

    CREATE TABLE IF NOT EXISTS rate_limit_ip (
      ip_hash TEXT NOT NULL,
      day     TEXT NOT NULL,
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip_hash, day)
    );

    CREATE TABLE IF NOT EXISTS login_attempts_ip (
      ip_hash   TEXT NOT NULL,
      window_at TEXT NOT NULL,
      count     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip_hash, window_at)
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

    CREATE TABLE IF NOT EXISTS comments (
      id           BIGSERIAL PRIMARY KEY,
      page_id      TEXT    NOT NULL,
      user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      display_name TEXT    NOT NULL,
      text         TEXT    NOT NULL,
      created_at   TEXT    NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')
    );
    CREATE INDEX IF NOT EXISTS idx_comments_page ON comments (page_id, id);

    CREATE TABLE IF NOT EXISTS reactions (
      page_id    TEXT NOT NULL,
      user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      value      INTEGER NOT NULL CHECK (value IN (-1, 1)),
      updated_at TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'),
      PRIMARY KEY (page_id, user_id)
    );
  `);
}

function mkHelpers() {
  const q = (text, params) => pool.query(text, params);

  async function one(text, params) {
    const r = await q(text, params);
    return r.rows[0] || null;
  }

  async function val(text, params) {
    const r = await q(text, params);
    return r.rows[0] ? Object.values(r.rows[0])[0] : null;
  }

  async function run(text, params) {
    const r = await q(text, params);
    return { changes: r.rowCount, lastInsertRowid: r.rows[0] ? r.rows[0].id : null };
  }

  return { q, one, val, run };
}

const h = mkHelpers();

const stmts = {
  getUserByName: (username) =>
    h.one('SELECT * FROM users WHERE lower(username) = lower($1)', [username]),
  getUserByTelegram: (telegramId) =>
    h.one('SELECT * FROM users WHERE telegram_id = $1', [telegramId]),
  getUserByEmail: (email) =>
    h.one('SELECT * FROM users WHERE lower(email) = lower($1)', [email]),

  insertUser: (username, password_hash, password_salt, telegramId, email) =>
    h.one(
      `INSERT INTO users (username, username_lc, password_hash, password_salt, telegram_id, email, status)
       VALUES ($1, lower($1), $2, $3, $4, $5, 'active')
       RETURNING *`,
      [username, password_hash, password_salt, telegramId, email]
    ),

  insertPending: (code, username, password_hash, password_salt, telegramId, email) =>
    h.one(
      `INSERT INTO pending_registrations
         (code, username, password_hash, password_salt, telegram_id, email, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, to_char(now() AT TIME ZONE 'utc' + interval '20 minutes', 'YYYY-MM-DD HH24:MI:SS'))
       RETURNING *`,
      [code, username, password_hash, password_salt, telegramId, email]
    ),

  getPendingByCode: (code) =>
    h.one('SELECT * FROM pending_registrations WHERE code = $1', [code]),

  confirmTelegram: (telegramId, code) =>
    h.run(
      'UPDATE pending_registrations SET telegram_id = $1 WHERE code = $2 AND telegram_id IS NULL',
      [telegramId, code]
    ),

  deletePending: (id) => h.run('DELETE FROM pending_registrations WHERE id = $1', [id]),

  cleanupExpired: () =>
    h.run("DELETE FROM pending_registrations WHERE expires_at < to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')"),

  rlGet: (ipHash, day) => h.one('SELECT count FROM rate_limit_ip WHERE ip_hash = $1 AND day = $2', [ipHash, day]),
  rlUpsert: (ipHash, day) =>
    h.run(
      `INSERT INTO rate_limit_ip (ip_hash, day, count) VALUES ($1, $2, 1)
       ON CONFLICT (ip_hash, day) DO UPDATE SET count = rate_limit_ip.count + 1`,
      [ipHash, day]
    ),
  rlCleanup: () => h.run("DELETE FROM rate_limit_ip WHERE day < to_char(now() AT TIME ZONE 'utc' - interval '2 days', 'YYYY-MM-DD')"),

  sessionInsert: (tokenHash, userId, ttlDays) =>
    h.run(
      `INSERT INTO sessions (token_hash, user_id, expires_at)
       VALUES ($1, $2, to_char(now() AT TIME ZONE 'utc' + make_interval(days => $3), 'YYYY-MM-DD HH24:MI:SS'))`,
      [tokenHash, userId, ttlDays]
    ),

  sessionGet: (tokenHash) =>
    h.one(
      `SELECT s.token_hash, s.expires_at, u.id AS user_id, u.username, u.anon_nick
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`,
      [tokenHash]
    ),

  sessionExtend: (ttlDays, tokenHash) =>
    h.run(
      `UPDATE sessions SET expires_at = to_char(now() AT TIME ZONE 'utc' + make_interval(days => $1), 'YYYY-MM-DD HH24:MI:SS')
       WHERE token_hash = $2`,
      [ttlDays, tokenHash]
    ),

  sessionDelete: (tokenHash) => h.run('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]),

  sessionCleanup: () =>
    h.run("DELETE FROM sessions WHERE expires_at < to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')"),

  laGet: (ipHash, windowAt) => h.one('SELECT count FROM login_attempts_ip WHERE ip_hash = $1 AND window_at = $2', [ipHash, windowAt]),
  laUpsert: (ipHash, windowAt) =>
    h.run(
      `INSERT INTO login_attempts_ip (ip_hash, window_at, count) VALUES ($1, $2, 1)
       ON CONFLICT (ip_hash, window_at) DO UPDATE SET count = login_attempts_ip.count + 1`,
      [ipHash, windowAt]
    ),
  laCleanup: () =>
    h.run("DELETE FROM login_attempts_ip WHERE window_at < to_char(now() AT TIME ZONE 'utc' - interval '1 hour', 'YYYY-MM-DD HH24:MI:SS')"),

  commentsList: (pageId) =>
    h.q(
      'SELECT id, user_id, display_name, text, created_at FROM comments WHERE page_id = $1 ORDER BY id ASC LIMIT 500',
      [pageId]
    ).then((r) => r.rows),

  commentInsert: (pageId, userId, displayName, text) =>
    h.one(
      `INSERT INTO comments (page_id, user_id, display_name, text)
       VALUES ($1, $2, $3, $4)
       RETURNING id, display_name, text, created_at`,
      [pageId, userId, displayName, text]
    ),

  commentCountRecent: (userId) =>
    h.val(
      `SELECT count(*)::int FROM comments
       WHERE user_id = $1 AND created_at > to_char(now() AT TIME ZONE 'utc' - interval '10 seconds', 'YYYY-MM-DD HH24:MI:SS')`,
      [userId]
    ),

  commentGetById: (id) =>
    h.one('SELECT id, display_name, text, created_at FROM comments WHERE id = $1', [id]),

  commentDeleteByAuthor: (id, userId) =>
    h.run('DELETE FROM comments WHERE id = $1 AND user_id = $2', [id, userId]),

  userSetAnonNick: (nick, userId) =>
    h.run('UPDATE users SET anon_nick = $1 WHERE id = $2', [nick, userId]),

  reactionCounts: (pageId) =>
    h.one(
      `SELECT
         COALESCE(SUM(CASE WHEN value = 1 THEN 1 ELSE 0 END), 0)::int  AS likes,
         COALESCE(SUM(CASE WHEN value = -1 THEN 1 ELSE 0 END), 0)::int AS dislikes
       FROM reactions WHERE page_id = $1`,
      [pageId]
    ),

  reactionGet: (pageId, userId) =>
    h.one('SELECT value FROM reactions WHERE page_id = $1 AND user_id = $2', [pageId, userId]),

  reactionUpsert: (pageId, userId, value) =>
    h.run(
      `INSERT INTO reactions (page_id, user_id, value, updated_at)
       VALUES ($1, $2, $3, to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS'))
       ON CONFLICT (page_id, user_id)
       DO UPDATE SET value = excluded.value, updated_at = to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD HH24:MI:SS')`,
      [pageId, userId, value]
    ),

  reactionDelete: (pageId, userId) =>
    h.run('DELETE FROM reactions WHERE page_id = $1 AND user_id = $2', [pageId, userId]),
};

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .scryptSync(String(password), salt, 64, { N: 16384, r: 8, p: 1 })
    .toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function createUser(username, password, telegramId = null, email = null) {
  const { salt, hash } = hashPassword(password);
  return stmts.insertUser(username, hash, salt, telegramId, email);
}

module.exports = { pool, stmts, hashPassword, verifyPassword, createUser, migrate };
