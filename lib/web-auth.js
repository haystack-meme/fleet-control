'use strict';
// Password sign-in for the web site: scrypt hash in settings.password, sessions in the database.
// With no password set (a new install, or after `node bin/admin.js clear-password`), the first sign-in sets it.
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
function logout(req, res) {
  const s = sid(req);
  if (s) db.run('DELETE FROM sessions WHERE id_hash = ?', sha(s));
  res.set('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  res.json({ ok: true });
}
// Drop expired sessions.
const prune = () => db.run('DELETE FROM sessions WHERE last_seen_at <= ?', db.ago(IDLE_SEC));

module.exports = { valid, login, logout, prune, passwordSet, clearPassword };
