'use strict';
// SQLite (Node's built-in node:sqlite) holds all of fleet-server's data: machines, settings, sessions, services and
// their versions. One file: fleet.db in the data folder (FLEET_DATA_DIR, default data/ in the app folder).
// The API is synchronous; every multi-statement write runs inside tx() with no await in between.
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const file = path.join(require('./config').dataDir, 'fleet.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

// Times are ISO 8601 UTC text ("2026-11-25T08:03:41Z"), which also sorts and compares correctly as text.
const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const ago = (sec) => db.prepare(`SELECT strftime('%Y-%m-%dT%H:%M:%SZ', 'now', ?) AS t`).get(`-${sec} seconds`).t;

const all = (sql, ...params) => db.prepare(sql).all(...params);
const get = (sql, ...params) => db.prepare(sql).get(...params);
const run = (sql, ...params) => db.prepare(sql).run(...params); // { changes, lastInsertRowid }
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
// SQLite constraint errors (node:sqlite sets errcode).
const isUnique = (e) => e?.errcode === 2067 || e?.errcode === 1555;
const isForeignKey = (e) => e?.errcode === 787;

function migrate() {
  db.exec(`
  -- Machines in the fleet. A row starts as a pending enrollment code (POST /enroll, activated_at NULL, deleted after
  -- 1 minute if unused); the agent's first hello with it activates it, and from then on it is that machine's key.
  CREATE TABLE IF NOT EXISTS machines (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    key_sha256   TEXT    UNIQUE,                   -- sha256 of the machine's key (the key itself is only on the machine)
    name         TEXT    UNIQUE,                   -- display name = the machine's current hostname (NULL while pending)
    address      TEXT,                             -- where its agent last connected from
    status       TEXT    NOT NULL DEFAULT 'pending', -- pending | approved | rejected (set by the user on the page)
    sort_order   INTEGER NOT NULL DEFAULT 0,
    created_at   TEXT    NOT NULL DEFAULT (${NOW}),
    activated_at TEXT,
    decided_at   TEXT
  );
  -- Single values: password (scrypt {salt, hash} JSON; none = the sign-in page asks for a new one).
  CREATE TABLE IF NOT EXISTS settings (
    name  TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id_hash      TEXT PRIMARY KEY,                 -- sha256 of the cookie value
    ip           TEXT NOT NULL,
    created_at   TEXT NOT NULL DEFAULT (${NOW}),
    last_seen_at TEXT NOT NULL DEFAULT (${NOW})
  );
  CREATE INDEX IF NOT EXISTS sessions_last_seen_at ON sessions (last_seen_at);
  CREATE TABLE IF NOT EXISTS services (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,           -- unit is fleet-<name>.service
    version     INTEGER NOT NULL DEFAULT 1,        -- +1 on every save
    machine_id  INTEGER NOT NULL REFERENCES machines (id), -- a machine with services can't be removed
    description TEXT    NOT NULL DEFAULT '',
    command     TEXT    NOT NULL,                  -- run with /bin/bash -c
    workdir     TEXT,
    run_as      TEXT    NOT NULL,                  -- Linux user the service runs as
    env         TEXT,                              -- JSON {"KEY": "value"}
    restart     TEXT    NOT NULL DEFAULT 'no',
    properties  TEXT,                              -- JSON ["Key=Value", ...] passed as systemd-run -p
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    updated_at  TEXT    NOT NULL DEFAULT (${NOW})
  );
  -- A full copy of the definition for every version (for history and rollback); removed with the service.
  CREATE TABLE IF NOT EXISTS service_versions (
    service_id  INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
    version     INTEGER NOT NULL,
    name        TEXT    NOT NULL,
    machine_id  INTEGER NOT NULL,
    description TEXT    NOT NULL DEFAULT '',
    command     TEXT    NOT NULL,
    workdir     TEXT,
    run_as      TEXT    NOT NULL,
    env         TEXT,
    restart     TEXT    NOT NULL,
    properties  TEXT,
    rolled_back_from INTEGER,                      -- set when this version is a copy of an older one
    created_at  TEXT    NOT NULL DEFAULT (${NOW}),
    PRIMARY KEY (service_id, version)
  );`);
}

const getSetting = (name) => get('SELECT value FROM settings WHERE name = ?', name)?.value ?? null;
const setSetting = (name, value) => run('REPLACE INTO settings (name, value) VALUES (?, ?)', name, value);
// Enrolled machines { name: { id, address, status } } in display order (all statuses, or only approved ones).
function machines({ approvedOnly = false } = {}) {
  const rows = all(`SELECT id, name, address, status FROM machines WHERE activated_at IS NOT NULL
    ${approvedOnly ? "AND status = 'approved'" : ''} ORDER BY sort_order, name`);
  return Object.fromEntries(rows.map((r) => [r.name, { id: r.id, address: r.address, status: r.status }]));
}

module.exports = { db, file, NOW, ago, all, get, run, tx, isUnique, isForeignKey, migrate, getSetting, setSetting, machines };
