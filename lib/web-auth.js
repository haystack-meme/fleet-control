'use strict';
// Password sign-in for the web site: scrypt hash in settings.password, sessions in the database.
// With no password set (a new install, or after `node bin/admin.js clear-password`), the first sign-in sets it.
// The API also accepts the API key (settings.api_key; there is always exactly one: made at first start, replaced
// with "reroll" on the page) as `Authorization: Bearer <key>` or `X-API-Key: <key>`.
const crypto = require('node:crypto');
const db = require('./db');

const COOKIE = 'fleet_sid';
const IDLE_SEC = 12 * 60 * 60;

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function hash(pw) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('hex'), hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function check(pw) {
  const stored = db.getSetting('password');
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
function valid(req) {
  const s = sid(req);
  if (!s) return false;
  return db.run(`UPDATE sessions SET last_seen_at = ${db.NOW} WHERE id_hash = ? AND last_seen_at > ?`, sha(s), db.ago(IDLE_SEC)).changes === 1;
}

// ---- API key ----
const newKey = () => crypto.randomBytes(32).toString('hex');
// Makes a key if there is none (first start, or a restored backup without one).
function ensureApiKey() {
  if (db.run('INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)', 'api_key', newKey()).changes) console.log('[auth] new API key created');
}
const apiKey = () => db.getSetting('api_key');
// Replaces the key; the old one stops working at once.
function rerollApiKey() {
  const k = newKey();
  db.setSetting('api_key', k);
  return k;
}
function keyFrom(req) {
  const m = (req.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  return m ? m[1] : req.get('x-api-key') || null;
}
// True if the request carries the current API key.
function validKey(req) {
  const got = keyFrom(req), want = apiKey();
  return !!(got && want) && crypto.timingSafeEqual(Buffer.from(sha(got), 'hex'), Buffer.from(sha(want), 'hex'));
}

const passwordSet = () => db.getSetting('password') !== null;
// Sets the password only if none is set (atomic: two people setting it at once can't both win).
const setFirstPassword = (pw) => db.run('INSERT OR IGNORE INTO settings (name, value) VALUES (?, ?)', 'password', JSON.stringify(hash(pw))).changes === 1;
// Clears the password and signs everyone out; the next visitor to the page sets a new one.
function clearPassword() {
  db.tx(() => { db.run("DELETE FROM settings WHERE name = 'password'"); db.run('DELETE FROM sessions'); });
}

function login(req, res) {
  const ip = req.ip, pw = (req.body || {}).password;
  if (!passwordSet()) {
    if (typeof pw !== 'string' || !pw) return res.status(400).json({ error: 'enter a password' });
    if (!setFirstPassword(pw)) return res.status(409).json({ error: 'a password was just set: reload and sign in' });
    console.log(`[auth] password set from ${ip} (none was set)`);
    return startSession(req, res);
  }
  if (!check(pw || '')) {
    console.log(`[auth] failed sign-in from ${ip}`);
    return res.status(401).json({ error: 'wrong password' });
  }
  console.log(`[auth] sign-in from ${ip}`);
  startSession(req, res);
}
function startSession(req, res) {
  const s = crypto.randomBytes(32).toString('hex');
  db.run('INSERT INTO sessions (id_hash, ip) VALUES (?, ?)', sha(s), req.ip);
  res.set('Set-Cookie', `${COOKIE}=${s}; Path=/; HttpOnly; Secure; SameSite=Strict`);
  res.json({ ok: true });
}
// Change the password (signed in): needs the current one; every other session is signed out, this one stays.
function changePassword(req, res) {
  const { current, password } = req.body || {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'enter a new password' });
  if (!check(typeof current === 'string' ? current : '')) {
    console.log(`[auth] password change refused from ${req.ip}: wrong current password`);
    return res.status(403).json({ error: 'the current password is wrong' });
  }
  db.tx(() => {
    db.setSetting('password', JSON.stringify(hash(password)));
    const s = sid(req); // with the API key there may be no session: then everyone is signed out
    db.run('DELETE FROM sessions WHERE id_hash <> ?', s ? sha(s) : '');
  });
  console.log(`[auth] password changed from ${req.ip}; other sessions signed out`);
  res.json({ ok: true });
}
function logout(req, res) {
  const s = sid(req);
  if (s) db.run('DELETE FROM sessions WHERE id_hash = ?', sha(s));
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}
// Drop expired sessions.
const prune = () => db.run('DELETE FROM sessions WHERE last_seen_at <= ?', db.ago(IDLE_SEC));

module.exports = { valid, validKey, ensureApiKey, apiKey, rerollApiKey, login, logout, prune, passwordSet, clearPassword, changePassword };
