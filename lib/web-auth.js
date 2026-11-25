'use strict';
// Password sign-in for the web site: scrypt hash in settings.password, sessions in MariaDB.
const crypto = require('node:crypto');
const { pool, getSetting } = require('./db');

const COOKIE = 'fleet_sid';
const IDLE_SEC = 12 * 60 * 60;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hash(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
async function check(pw) {
  const stored = await getSetting('password');
  if (!stored) return false;
  const { salt, hash: h } = JSON.parse(stored);
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'hex'), 32);
  return crypto.timingSafeEqual(got, Buffer.from(h, 'hex'));
}

function sid(req) {
  const m = (req.get('cookie') || '').match(/(?:^|;\s*)fleet_sid=([a-f0-9]{64})/);
  return m && m[1];
}
// True if the request has a live session; bumps last_seen_at.
async function valid(req) {
  const s = sid(req);
  if (!s) return false;
  const [r] = await pool.query(
    'UPDATE sessions SET last_seen_at=UTC_TIMESTAMP() WHERE id_hash=? AND last_seen_at > UTC_TIMESTAMP() - INTERVAL ? SECOND',
    [sha(s), IDLE_SEC]);
  return r.affectedRows === 1;
}

async function login(req, res) {
  const ip = req.ip;
  if (!(await check((req.body || {}).password || ''))) {
    console.log(`[auth] failed sign-in from ${ip}`);
    return res.status(401).json({ error: 'wrong password' });
  }
  const s = crypto.randomBytes(32).toString('hex');
  await pool.query('INSERT INTO sessions (id_hash, ip) VALUES (?, ?)', [sha(s), ip]);
  console.log(`[auth] sign-in from ${ip}`);
  res.set('Set-Cookie', `${COOKIE}=${s}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  res.json({ ok: true });
}
async function logout(req, res) {
  const s = sid(req);
  if (s) await pool.query('DELETE FROM sessions WHERE id_hash=?', [sha(s)]);
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}
// Drop expired sessions.
function prune() {
  return pool.query('DELETE FROM sessions WHERE last_seen_at <= UTC_TIMESTAMP() - INTERVAL ? SECOND', [IDLE_SEC]);
}

module.exports = { hash, valid, login, logout, prune };
