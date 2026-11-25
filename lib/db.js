'use strict';
// MariaDB holds all of fleet-server's data: machines, settings, sessions, services and their versions.
// No password: the app signs in over the local socket as the MariaDB user with the same name as the Linux user running it
// (unix_socket auth; see sql/setup.sql). Overrides: FLEET_DB (database, default fleet), FLEET_DB_USER, FLEET_DB_SOCKET.
const os = require('node:os');
const mysql = require('mysql2/promise');
const pool = mysql.createPool({
  socketPath: process.env.FLEET_DB_SOCKET || '/run/mysqld/mysqld.sock',
  user: process.env.FLEET_DB_USER || os.userInfo().username,
  database: process.env.FLEET_DB || 'fleet',
  connectionLimit: 5, timezone: 'Z',
});

async function migrate() {
  // Machines in the fleet. A row starts as a pending enrollment code (POST /enroll, activated_at NULL, deleted after
  // 1 minute if unused); the agent's first hello with it activates it, and from then on it is that machine's key.
  await pool.query(`CREATE TABLE IF NOT EXISTS machines (
    id           INT AUTO_INCREMENT PRIMARY KEY,
    key_sha256   CHAR(64)    NULL UNIQUE,      -- sha256 of the machine's key (the key itself is only on the machine)
    name         VARCHAR(64) NULL UNIQUE,      -- display name = the machine's current hostname (NULL while pending)
    address      VARCHAR(64) NULL,             -- where its agent last connected from
    status       VARCHAR(16) NOT NULL DEFAULT 'pending', -- pending | approved | rejected (set by the user on the page)
    sort_order   INT         NOT NULL DEFAULT 0,
    created_at   DATETIME    NOT NULL DEFAULT UTC_TIMESTAMP(),
    activated_at DATETIME    NULL,
    decided_at   DATETIME    NULL
  )`);
  // Single values: password (scrypt {salt, hash} JSON), default_run_as (user for services that don't name one).
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    name  VARCHAR(64) PRIMARY KEY,
    value TEXT        NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sessions (
    id_hash      CHAR(64)    PRIMARY KEY,      -- sha256 of the cookie value
    ip           VARCHAR(64) NOT NULL,
    created_at   DATETIME    NOT NULL DEFAULT UTC_TIMESTAMP(),
    last_seen_at DATETIME    NOT NULL DEFAULT UTC_TIMESTAMP(),
    KEY (last_seen_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS services (
    id          INT AUTO_INCREMENT PRIMARY KEY,
    name        VARCHAR(40)  NOT NULL UNIQUE,  -- unit is fleet-<name>.service
    version     INT          NOT NULL DEFAULT 1, -- +1 on every save
    machine_id  INT          NOT NULL,         -- machines.id
    description VARCHAR(200) NOT NULL DEFAULT '',
    command     TEXT         NOT NULL,         -- run with /bin/bash -c
    workdir     VARCHAR(255) NULL,
    run_as      VARCHAR(32)  NOT NULL,         -- Linux user the service runs as
    env         JSON         NULL,             -- {"KEY": "value"}
    restart     VARCHAR(16)  NOT NULL DEFAULT 'no',
    properties  JSON         NULL,             -- ["Key=Value", ...] passed as systemd-run -p
    created_at  DATETIME NOT NULL DEFAULT UTC_TIMESTAMP(),
    updated_at  DATETIME NOT NULL DEFAULT UTC_TIMESTAMP(),
    FOREIGN KEY (machine_id) REFERENCES machines(id)  -- a machine with services can't be removed
  )`);
  // A full copy of the definition for every version (for history and rollback); removed with the service.
  await pool.query(`CREATE TABLE IF NOT EXISTS service_versions (
    service_id  INT          NOT NULL,
    version     INT          NOT NULL,
    name        VARCHAR(40)  NOT NULL,
    machine_id  INT          NOT NULL,
    description VARCHAR(200) NOT NULL DEFAULT '',
    command     TEXT         NOT NULL,
    workdir     VARCHAR(255) NULL,
    run_as      VARCHAR(32)  NOT NULL,
    env         JSON         NULL,
    restart     VARCHAR(16)  NOT NULL,
    properties  JSON         NULL,
    rolled_back_from INT     NULL,             -- set when this version is a copy of an older one
    created_at  DATETIME     NOT NULL DEFAULT UTC_TIMESTAMP(),
    PRIMARY KEY (service_id, version),
    FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE
  )`);
}

async function getSetting(name) {
  const [[row]] = await pool.query('SELECT value FROM settings WHERE name=?', [name]);
  return row ? row.value : null;
}
const setSetting = (name, value) => pool.query('REPLACE INTO settings (name, value) VALUES (?, ?)', [name, value]);
// Enrolled machines { name: { id, address, status } } in display order (all statuses, or only approved ones).
async function machines({ approvedOnly = false } = {}) {
  const [rows] = await pool.query(`SELECT id, name, address, status FROM machines WHERE activated_at IS NOT NULL
    ${approvedOnly ? "AND status='approved'" : ''} ORDER BY sort_order, name`);
  return Object.fromEntries(rows.map((r) => [r.name, { id: r.id, address: r.address, status: r.status }]));
}

module.exports = { pool, migrate, getSetting, setSetting, machines };
