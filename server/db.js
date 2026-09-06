/**
 * База данных «Кабаньих сводок».
 * SQLite, один файл — data.sqlite рядом со скриптом.
 *
 * users                 — подтвержденные учетки.
 * pending_registrations — заявки, ждущие подтверждения (telegram/email в будущем).
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const crypto = require('crypto');

const db = new Database(path.join(__dirname, 'data.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------- Схема ----------

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    password_salt TEXT    NOT NULL,
    telegram_id   INTEGER UNIQUE,
    email         TEXT UNIQUE,
    status        TEXT    NOT NULL DEFAULT 'active',
    created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_registrations (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL UNIQUE,
    username      TEXT    NOT NULL COLLATE NOCASE,
    password_hash TEXT    NOT NULL,
    password_salt TEXT    NOT NULL,
    telegram_id   INTEGER,
    email         TEXT,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at    TEXT    NOT NULL
  );

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
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions (user_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);

  CREATE INDEX IF NOT EXISTS idx_pending_expires ON pending_registrations (expires_at);
`);

// ---------- Пароли (scrypt, встроенный crypto) ----------

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

// ---------- Запросы ----------

const stmts = {
  getUserByName:     db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE'),
  getUserByTelegram: db.prepare('SELECT * FROM users WHERE telegram_id = ?'),
  getUserByEmail:    db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE'),

  insertUser: db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, telegram_id, email, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  ),

  insertPending: db.prepare(
    `INSERT INTO pending_registrations
       (code, username, password_hash, password_salt, telegram_id, email, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now', '+20 minutes'))`
  ),

  getPendingByCode: db.prepare('SELECT * FROM pending_registrations WHERE code = ?'),
  confirmTelegram: db.prepare(
    'UPDATE pending_registrations SET telegram_id = ? WHERE code = ? AND telegram_id IS NULL'
  ),

  confirmPending: db.prepare(
    `INSERT INTO users (username, password_hash, password_salt, telegram_id, email, status)
     VALUES (@username, @password_hash, @password_salt, @telegram_id, @email, 'active')`
  ),

  deletePending:  db.prepare('DELETE FROM pending_registrations WHERE id = ?'),
  cleanupExpired: db.prepare(`DELETE FROM pending_registrations WHERE expires_at < datetime('now')`),

  // rate limit: вместо IP храним только его хеш с серверной солью
  rlGet:     db.prepare('SELECT count FROM rate_limit_ip WHERE ip_hash = ? AND day = ?'),
  rlUpsert:  db.prepare(
    `INSERT INTO rate_limit_ip (ip_hash, day, count) VALUES (?, ?, 1)
     ON CONFLICT(ip_hash, day) DO UPDATE SET count = count + 1`
  ),
  rlCleanup: db.prepare(`DELETE FROM rate_limit_ip WHERE day < date('now', '-2 days')`),

  // сессии: в БД только sha256-хеш токена, сам токен живет в cookie пользователя
  sessionInsert: db.prepare(
    `INSERT INTO sessions (token_hash, user_id, expires_at)
     VALUES (?, ?, datetime('now', ?))`
  ),
  sessionGet: db.prepare(
    `SELECT s.token_hash, s.expires_at, u.id AS user_id, u.username
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > datetime('now')`
  ),
  sessionExtend: db.prepare(
    `UPDATE sessions SET expires_at = datetime('now', ?) WHERE token_hash = ?`
  ),
  sessionDelete: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  sessionCleanup: db.prepare(`DELETE FROM sessions WHERE expires_at < datetime('now')`),

  // брутфорс-лимит: счетчик неудачных попыток входа за окно времени
  laGet: db.prepare('SELECT count FROM login_attempts_ip WHERE ip_hash = ? AND window_at = ?'),
  laUpsert: db.prepare(
    `INSERT INTO login_attempts_ip (ip_hash, window_at, count) VALUES (?, ?, 1)
     ON CONFLICT(ip_hash, window_at) DO UPDATE SET count = count + 1`
  ),
  laCleanup: db.prepare(`DELETE FROM login_attempts_ip WHERE window_at < datetime('now', '-1 hour')`),
};

// Периодическая чистка протухших сессий и счетчиков попыток
function maintenance() {
  stmts.sessionCleanup.run();
  stmts.laCleanup.run();
}
setInterval(maintenance, 10 * 60 * 1000).unref();

function createUser(username, password, telegramId = null, email = null) {
  const { salt, hash } = hashPassword(password);
  stmts.insertUser.run(username, hash, salt, telegramId, email);
  return stmts.getUserByName.get(username);
}

module.exports = { db, stmts, hashPassword, verifyPassword, createUser };