'use strict';
// Backup file (.fleetbackup) = gzip(copy of the whole SQLite database) followed by the SHA-256 of those gzip bytes
// (the last 32 bytes of the file). The copy is made with VACUUM INTO, safe while the server runs.
// Restore = check the hash, decompress, check that it is an intact fleet database, upgrade it to this version's schema
// (db.migrate, so backups from older versions restore), then replace machines, settings, services and their versions
// in one transaction. Sign-in sessions are kept (restoring doesn't sign anyone out).
// Any change to the file makes the hash not match. The hash is not secret, so this catches edits and damage, not
// someone who deliberately recomputes it.
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const db = require('./db');
const { ApiError } = require('./errors');

const bad = (msg) => new ApiError(400, 'bad_backup', msg);
// Delete children first, insert parents first (foreign keys stay on).
const TABLES = ['machines', 'settings', 'services', 'service_versions'];
const tmpFile = () => path.join(path.dirname(db.file), `tmp-${crypto.randomBytes(8).toString('hex')}.db`);
const columns = (conn, schema, table) => conn.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema).map((r) => r.name);

const HASH_LEN = 32;
// A fleet database is a few MB even with years of history; a backup that unpacks to more than this is refused.
const MAX_DATABASE_BYTES = 2 ** 30;
const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

// The backup file's bytes: gzip(database) + sha256(gzip(database)).
function backupFile() {
  const f = tmpFile();
  try {
    db.run('VACUUM INTO ?', f);
    const gz = zlib.gzipSync(fs.readFileSync(f), { level: 9 });
    return Buffer.concat([gz, sha256(gz)]);
  } finally { fs.rmSync(f, { force: true }); }
}
// Backup file bytes -> the database bytes; refuses a file whose hash doesn't match or that doesn't decompress.
function unpack(buf) {
  const changed = () => bad('not a fleet backup, or it was changed: its checksum does not match');
  if (buf.length <= HASH_LEN) throw changed();
  const gz = buf.subarray(0, buf.length - HASH_LEN);
  if (!crypto.timingSafeEqual(sha256(gz), buf.subarray(buf.length - HASH_LEN))) throw changed();
  try { return zlib.gunzipSync(gz, { maxOutputLength: MAX_DATABASE_BYTES }); }
  catch (e) {
    if (e.code === 'ERR_BUFFER_TOO_LARGE') throw bad(`the backup decompresses to more than ${MAX_DATABASE_BYTES / 2 ** 30} GB, which no fleet database comes near`);
    throw bad('the backup is damaged: it does not decompress');
  }
}

// Checks an uploaded database file and upgrades it to this version's schema: intact, has the fleet tables, then
// migrated, then has every column this version uses. Returns the counts it holds.
function checkAndMigrate(file) {
  let up;
  try { up = new DatabaseSync(file); }
  catch { throw bad('not an SQLite database'); }
  try {
    let ok;
    try { ok = up.prepare('PRAGMA integrity_check').get(); } catch { throw bad('not an SQLite database'); }
    if (Object.values(ok)[0] !== 'ok') throw bad('the database file is damaged');
    const { n: size } = up.prepare('SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()').get();
    if (size !== fs.statSync(file).size) throw bad('the backup was changed (extra data in the file)');
    // Must already be a fleet database: migrating first would turn any SQLite file into an empty fleet.
    for (const t of TABLES) if (!columns(up, 'main', t).length) throw bad(`not a fleet backup (no ${t} table)`);
    db.migrate(up);
    for (const t of TABLES) {
      const have = new Set(columns(up, 'main', t));
      const missing = columns(db.db, 'main', t).filter((c) => !have.has(c));
      if (missing.length) throw bad(`not a fleet backup this version can read (${t} has no ${missing.join(', ')})`);
    }
    const n = (t) => up.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    return { machines: n('machines WHERE activated_at IS NOT NULL'), services: n('services') };
  } finally { up.close(); }
}

// Restores from the backup file bytes `buf`. Returns the counts restored.
function restore(buf) {
  const raw = unpack(buf);
  const f = tmpFile();
  fs.writeFileSync(f, raw);
  try {
    const counts = checkAndMigrate(f);
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
      throw db.isForeignKey(e) ? bad('the backup has services on machines it does not contain') : e;
    } finally { db.run('DETACH DATABASE up'); }
    return counts;
  } finally { fs.rmSync(f, { force: true }); }
}

module.exports = { backupFile, restore };
