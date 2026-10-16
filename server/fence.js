'use strict';
const core = require('../scripts/fence-core.js');
const { W, H, BASE } = core;

module.exports = function mountFence(app, { pool, getSessionUser }) {
  let buf = Buffer.alloc(W * H * 3);
  let dirty = false;
  const clients = new Set();
  const lastBucket = new Map();
  const MAX_PTS = 400;
  const BUCKET_COOLDOWN_MS = 5 * 60 * 1000;
  const COLOR_RE = /^#[0-9a-fA-F]{6}$/;

  async function save() {
    if (!dirty) return;
    dirty = false;
    try {
      await pool.query(
        `INSERT INTO fence_canvas (id, data) VALUES (1, $1)
         ON CONFLICT (id) DO UPDATE SET data = excluded.data`, [buf]);
    } catch (e) { dirty = true; throw e; }
  }

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS fence_canvas (
      id INT PRIMARY KEY, data BYTEA NOT NULL)`);
    const r = await pool.query('SELECT data FROM fence_canvas WHERE id = 1');
    if (r.rows[0] && r.rows[0].data.length === W * H * 3) {
      buf = Buffer.from(r.rows[0].data);
    } else {
      for (let i = 0; i < buf.length; i += 3) {
        buf[i] = BASE[0]; buf[i + 1] = BASE[1]; buf[i + 2] = BASE[2];
      }
      dirty = true;
      await save();
    }
    setInterval(() => save().catch(e => console.error('[fence] save', e.message)), 5000).unref();
    for (const sig of ['SIGTERM', 'SIGINT']) {
      process.once(sig, async () => { try { await save(); } finally { process.exit(0); } });
    }
  }

  function broadcast(obj) {
    const msg = 'data: ' + JSON.stringify(obj) + '\n\n';
    for (const c of clients) c.write(msg);
  }

  app.get('/api/fence/canvas', (req, res) => {
    res.set({ 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.send(buf);
  });

  app.get('/api/fence/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
  });

  app.post('/api/fence/stroke', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ detail: 'Требуется вход' });

    const b = req.body || {};
    if (!['s', 'm', 'b'].includes(b.t)) return res.status(400).json({ detail: 'Плохой инструмент' });
    if (typeof b.c !== 'string' || !COLOR_RE.test(b.c)) return res.status(400).json({ detail: 'Плохой цвет' });
    if (!Array.isArray(b.pts) || !b.pts.length || b.pts.length > MAX_PTS) {
      return res.status(400).json({ detail: 'Плохая пачка' });
    }

    const pts = [];
    for (const p of b.pts) {
      if (!Array.isArray(p)) return res.status(400).json({ detail: 'Плохая точка' });
      const x = p[0], y = p[1], a = p[2] || 0;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= W || y >= H || !Number.isFinite(a)) {
        return res.status(400).json({ detail: 'Плохая точка' });
      }
      pts.push([x, y, ((Math.round(a) % 360) + 360) % 360]);
    }

    const color = b.c.toLowerCase();
    core.applyBatch(buf, b.t, color, pts);
    dirty = true;
    broadcast({ k: 'stroke', cid: String(b.cid || '').slice(0, 32), t: b.t, c: color, pts });
    res.json({ ok: true });
  });

  app.get('/api/fence/bucket', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.json({ left: 0 });
    const left = Math.max(0, BUCKET_COOLDOWN_MS - (Date.now() - (lastBucket.get(user.userId) || 0)));
    res.json({ left: Math.ceil(left / 1000) });
  });

  app.post('/api/fence/bucket', async (req, res) => {
    const user = await getSessionUser(req);
    if (!user) return res.status(401).json({ detail: 'Требуется вход' });

    const b = req.body || {};
    if (typeof b.c !== 'string' || !COLOR_RE.test(b.c)) return res.status(400).json({ detail: 'Плохой цвет' });
    if (!Number.isInteger(b.x) || !Number.isInteger(b.y) || b.x < 0 || b.y < 0 || b.x >= W || b.y >= H) {
      return res.status(400).json({ detail: 'Плохая точка' });
    }
    if (!Number.isInteger(b.seed) || b.seed < 0 || b.seed > 4294967295) {
      return res.status(400).json({ detail: 'Плохой seed' });
    }

    const now = Date.now();
    const passed = now - (lastBucket.get(user.userId) || 0);
    if (passed < BUCKET_COOLDOWN_MS) {
      return res.status(429).json({
        detail: 'Бежим в лемана про за новым ведром...',
        left: Math.ceil((BUCKET_COOLDOWN_MS - passed) / 1000),
      });
    }
    lastBucket.set(user.userId, now);

    const color = b.c.toLowerCase();
    core.bucket(buf, color, b.x, b.y, b.seed);
    dirty = true;
    broadcast({ k: 'bucket', cid: String(b.cid || '').slice(0, 32), c: color, x: b.x, y: b.y, seed: b.seed });
    res.json({ ok: true, left: BUCKET_COOLDOWN_MS / 1000 });
  });

  return { init };
};