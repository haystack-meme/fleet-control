'use strict';
// Backup = a copy of the whole SQLite database (VACUUM INTO, safe while the server runs).
// Restore = replace machines, settings, services and their versions with those in an uploaded backup, in one
// transaction. Sign-in sessions are kept (restoring doesn't sign anyone out).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
// Delete children first, insert parents first (foreign keys stay on).
const TABLES = ['machines', 'settings', 'services', 'service_versions'];
const tmpFile = () => path.join(path.dirname(db.file), `tmp-${crypto.randomBytes(8).toString('hex')}.db`);
const columns = (conn, schema, table) => conn.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema).map((r) => r.name);

// Writes a backup to `file` (must not exist).
function backupTo(file) {
  if (fs.existsSync(file)) throw new Error(`${file} already exists`);
  db.run('VACUUM INTO ?', file);
}

// A backup in a temporary file (next to the database); the caller deletes it.
function backupTemp() {
  const f = tmpFile();
  backupTo(f);
  return f;
}

// Checks an uploaded database file: intact, and has every table and column this version uses.
function check(file) {
  let up;
  try { up = new DatabaseSync(file, { readOnly: true }); }
  catch { throw httpErr(400, 'not an SQLite database'); }
  try {
    let ok;
    try { ok = up.prepare('PRAGMA integrity_check').get(); } catch { throw httpErr(400, 'not an SQLite database'); }
    if (Object.values(ok)[0] !== 'ok') throw httpErr(400, 'the database file is damaged');
    for (const t of TABLES) {
      const have = new Set(columns(up, 'main', t));
      if (!have.size) throw httpErr(400, `not a fleet backup (no ${t} table)`);
      const missing = columns(db.db, 'main', t).filter((c) => !have.has(c));
      if (missing.length) throw httpErr(400, `not a fleet backup from this version (${t} has no ${missing.join(', ')})`);
    }
    const n = (t) => up.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { machines: n("machines WHERE activated_at IS NOT NULL"), services: n('services') };
  } finally { up.close(); }
}

// Restores from the backup bytes `buf`. Returns the counts restored.
function restore(buf) {
  const f = tmpFile();
  fs.writeFileSync(f, buf);
  try {
    const counts = check(f);
    db.run('ATTACH DATABASE ? AS up', f);
    try {
      db.tx(() => {
        for (const t of [...TABLES].reverse()) db.run(`DELETE FROM main.${t}`);
        for (const t of TABLES) {
          const cols = columns(db.db, 'main', t).join(', ');
          db.run(`INSERT INTO main.${t} (${cols}) SELECT ${cols} FROM up.${t}`);
        }
      });
    } catch (e) {
      throw db.isForeignKey(e) ? httpErr(400, 'the backup has services on machines it does not contain') : e;
    } finally { db.run('DETACH DATABASE up'); }
    return counts;
  } finally { fs.rmSync(f, { force: true }); }
}

module.exports = { backupTo, backupTemp, restore };
