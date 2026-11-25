'use strict';
// Service definitions (MariaDB), run on their machine by its fleet-agent (connected to us) as transient units:
//   systemd-run --unit=fleet-<name>.service -p User=<run_as> ... -- /bin/bash -c <command>
const db = require('./db');
const { pool } = db;
const { call } = require('./agent');

const RESTART = ['no', 'on-failure', 'always'];
const unitOf = (name) => `fleet-${name}.service`;
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });

// ---- validation ---------------------------------------------------------
const oneLine = (s) => !/[\0\r\n]/.test(s);
function validate(input, machines, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  const need = (k) => { if (!partial && !has(k)) throw httpErr(400, `${k} is required`); return has(k); };

  if (need('name')) {
    if (typeof input.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.name))
      throw httpErr(400, 'name: 1-40 chars, lowercase letters, digits and -, starting with a letter or digit');
    if (['agent', 'server'].includes(input.name)) throw httpErr(400, `name "${input.name}" is reserved (fleet-agent / fleet-server are the fleet's own units)`);
    out.name = input.name;
  }
  if (need('machine')) { // API uses the machine's name; the database stores its id
    if (!Object.hasOwn(machines, input.machine)) throw httpErr(400, `machine must be one of: ${Object.keys(machines).join(', ')}`);
    out.machine_id = machines[input.machine].id;
  }
  if (need('command')) {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0'))
      throw httpErr(400, 'command is required');
    out.command = input.command;
  }
  if (has('description')) {
    const d = String(input.description ?? '');
    if (d.length > 200 || !oneLine(d)) throw httpErr(400, 'description: one line, at most 200 chars');
    out.description = d;
  }
  if (has('workdir')) {
    const w = input.workdir ? String(input.workdir) : null;
    if (w && (!w.startsWith('/') || w.length > 255 || !oneLine(w))) throw httpErr(400, 'workdir must be an absolute path');
    out.workdir = w;
  }
  if (has('run_as') && input.run_as) { // empty = the default user (settings.default_run_as)
    const u = String(input.run_as);
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) throw httpErr(400, 'run_as must be a user name');
    out.run_as = u;
  }
  if (has('env')) {
    const e = input.env || {};
    if (typeof e !== 'object' || Array.isArray(e)) throw httpErr(400, 'env must be an object of KEY: value');
    for (const [k, v] of Object.entries(e)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw httpErr(400, `env: bad name ${k}`);
      if (typeof v !== 'string' || !oneLine(v)) throw httpErr(400, `env ${k}: value must be a one-line string`);
    }
    out.env = e;
  }
  if (has('properties')) {
    const p = input.properties || [];
    if (!Array.isArray(p)) throw httpErr(400, 'properties must be a list of Key=Value strings');
    for (const x of p) {
      if (typeof x !== 'string' || !/^[A-Z][A-Za-z]{1,63}=/.test(x) || !oneLine(x))
        throw httpErr(400, `properties: bad entry ${JSON.stringify(x)} (want Key=Value)`);
      if (/^(User|ExecStart|Restart|WorkingDirectory|Environment)=/.test(x))
        throw httpErr(400, `properties: set ${x.split('=')[0]} with its own field`);
    }
    out.properties = p;
  }
  if (has('restart')) {
    if (!RESTART.includes(input.restart)) throw httpErr(400, `restart must be one of: ${RESTART.join(', ')}`);
    out.restart = input.restart;
  }
  return out;
}

// ---- definitions --------------------------------------------------------
// User for services that don't name one: settings.default_run_as, else the user running fleet-server.
const defaultRunAs = async () => (await db.getSetting('default_run_as')) || require('node:os').userInfo().username;
// Every create/save bumps services.version and copies the new definition into service_versions.
const FIELDS = ['name', 'machine_id', 'description', 'command', 'workdir', 'run_as', 'env', 'restart', 'properties'];
const snapshot = (conn, id, rolledBackFrom = null) => conn.query(
  `INSERT INTO service_versions (service_id, version, ${FIELDS}, rolled_back_from) SELECT id, version, ${FIELDS}, ? FROM services WHERE id=?`,
  [rolledBackFrom, id]);
async function tx(fn) {
  const conn = await pool.getConnection();
  try { await conn.beginTransaction(); const r = await fn(conn); await conn.commit(); return r; }
  catch (e) { await conn.rollback(); throw e; }
  finally { conn.release(); }
}
const json = (v, empty) => (v == null ? empty : typeof v === 'string' ? JSON.parse(v) : v); // mysql2 may already parse JSON columns
const fields = (r) => ({
  name: r.name, machine: r.machine, description: r.description, command: r.command, workdir: r.workdir,
  run_as: r.run_as, env: json(r.env, {}), restart: r.restart, properties: json(r.properties, []),
});
// Rows are read joined with machines, so r.machine is the machine's current name.
const SELECT = 'SELECT s.*, m.name AS machine FROM services s JOIN machines m ON m.id = s.machine_id';
const rowOut = (r) => ({ id: r.id, version: r.version, ...fields(r), machine_id: r.machine_id, unit: unitOf(r.name), created_at: r.created_at, updated_at: r.updated_at });
const dup = (e) => { throw e.code === 'ER_DUP_ENTRY' ? httpErr(409, 'a service with that name already exists') : e; };

async function get(name) {
  const [rows] = await pool.query(`${SELECT} WHERE s.name=?`, [name]);
  if (!rows[0]) throw httpErr(404, 'no such service');
  return rowOut(rows[0]);
}
async function create(input) {
  const v = validate(input, await db.machines({ approvedOnly: true }));
  await tx(async (conn) => {
    const [r] = await conn.query(
      'INSERT INTO services (name, machine_id, description, command, workdir, run_as, env, restart, properties) VALUES (?,?,?,?,?,?,?,?,?)',
      [v.name, v.machine_id, v.description ?? '', v.command, v.workdir ?? null, v.run_as ?? await defaultRunAs(),
       JSON.stringify(v.env ?? {}), v.restart ?? 'no', JSON.stringify(v.properties ?? [])]).catch(dup);
    await snapshot(conn, r.insertId);
  });
  console.log(`[service] created ${v.name} v1`);
  return get(v.name);
}
async function update(name, input, { rolledBackFrom = null } = {}) {
  const cur = await get(name);
  const v = validate(input, await db.machines({ approvedOnly: true }), { partial: true });
  // Renaming or moving a running service would leave its unit running unmanaged, so it must be stopped first.
  // If its machine can't be reached, we can't tell (and can't stop it), so the change is allowed.
  if ((v.name && v.name !== cur.name) || (v.machine_id && v.machine_id !== cur.machine_id)) {
    const st = await status(cur).catch((e) => { if ([502, 403, 504].includes(e.status)) return { unreachable: true }; throw e; });
    if (st.running) throw httpErr(409, 'stop the service before changing its name or machine');
    if (st.unreachable) console.log(`[service] ${cur.name}: ${cur.machine} unreachable, changing name/machine without checking it`);
  }
  const cols = Object.keys(v);
  const vals = cols.map((k) => (k === 'env' || k === 'properties' ? JSON.stringify(v[k]) : v[k]));
  await tx(async (conn) => {
    await conn.query(`UPDATE services SET ${cols.map((c) => `${c}=?, `).join('')}version=version+1, updated_at=UTC_TIMESTAMP() WHERE id=?`,
      [...vals, cur.id]).catch(dup);
    await snapshot(conn, cur.id, rolledBackFrom);
  });
  const saved = await get(v.name || name);
  console.log(`[service] saved ${saved.name} v${saved.version}${rolledBackFrom ? ` (rolled back from v${rolledBackFrom})` : ''}`);
  return saved;
}
// All versions, newest first.
async function versions(name) {
  const svc = await get(name);
  // LEFT JOIN: a version whose machine has since been removed is kept, with machine = null.
  const [rows] = await pool.query('SELECT v.*, m.name AS machine FROM service_versions v LEFT JOIN machines m ON m.id = v.machine_id WHERE v.service_id=? ORDER BY v.version DESC', [svc.id]);
  return rows.map((r) => ({ version: r.version, rolled_back_from: r.rolled_back_from, created_at: r.created_at, ...fields(r) }));
}
// Roll back = save an old version's definition as a new version. A running service keeps running the old one until restarted.
async function rollback(name, version) {
  const svc = await get(name);
  const [rows] = await pool.query('SELECT v.*, m.name AS machine FROM service_versions v LEFT JOIN machines m ON m.id = v.machine_id WHERE v.service_id=? AND v.version=?', [svc.id, version]);
  if (!rows[0]) throw httpErr(404, `no version ${version}`);
  if (!rows[0].machine) throw httpErr(409, `v${version} ran on a machine that has since been removed`);
  return update(name, fields(rows[0]), { rolledBackFrom: version });
}
// Stops it on its machine first, so nothing is left running unmanaged. If the machine can't be reached (agent not
// connected or machine not approved), it is refused unless force is set: then it is only removed from the database.
async function remove(name, { force = false } = {}) {
  const svc = await get(name);
  try { await stopUnit(svc); }
  catch (e) {
    if (!force || ![502, 403, 504].includes(e.status)) throw Object.assign(e, { canForce: [502, 403, 504].includes(e.status) });
    console.log(`[service] ${svc.name}: deleting without stopping it (${e.message})`);
  }
  await pool.query('DELETE FROM services WHERE id=?', [svc.id]); // its versions go with it (ON DELETE CASCADE)
  console.log(`[service] deleted ${svc.name}`);
}

// ---- remote control (via the machine's fleet-agent) ----------------------
// The agent asks systemctl for --timestamp=unix ("@1764051808"); anything else (older agent) is passed through.
const unixToIso = (t) => (/^@\d+$/.test(t || '') ? new Date(Number(t.slice(1)) * 1000).toISOString() : t || null);
// Status of several units on one machine: the agent returns systemctl show's properties per unit, in order.
async function showMany(machine, svcs) {
  const blocks = await call(machine, 'show', { units: svcs.map((s) => s.unit) });
  return svcs.map((s, i) => {
    const p = blocks[i] || {};
    if (p.LoadState !== 'loaded') return { active: 'inactive', sub: 'dead', running: false };
    return {
      active: p.ActiveState, sub: p.SubState,
      running: ['active', 'activating', 'reloading', 'deactivating'].includes(p.ActiveState),
      pid: Number(p.MainPID) || null, since: unixToIso(p.ExecMainStartTimestamp), exit_status: Number(p.ExecMainStatus),
    };
  });
}
const status = async (svc) => (await showMany(svc.machine, [svc]))[0];

// All services with live status: one agent call per machine; a machine without a connected agent gives { error }.
async function listWithStatus() {
  const [rows] = await pool.query(`${SELECT} ORDER BY m.sort_order, s.name`);
  const all = rows.map(rowOut), byMachine = {};
  for (const s of all) (byMachine[s.machine] ||= []).push(s);
  await Promise.all(Object.entries(byMachine).map(async ([machine, svcs]) => {
    try { (await showMany(machine, svcs)).forEach((st, i) => { svcs[i].status = st; }); }
    catch (e) { svcs.forEach((s) => { s.status = { error: e.message }; }); }
  }));
  return all;
}

async function start(name) {
  const svc = await get(name);
  if ((await status(svc)).running) throw httpErr(409, 'already running');
  const properties = [`User=${svc.run_as}`, `Restart=${svc.restart}`];
  if (svc.restart !== 'no' && !svc.properties.some((p) => p.startsWith('RestartSec='))) properties.push('RestartSec=2');
  properties.push(...svc.properties);
  if (svc.workdir) properties.push(`WorkingDirectory=${svc.workdir}`);
  await call(svc.machine, 'start',
    { unit: svc.unit, description: `fleet: ${svc.description || svc.name}`, properties, env: svc.env, command: svc.command });
  console.log(`[service] started ${svc.unit} on ${svc.machine}`);
  return { ...svc, status: await status(svc) };
}
const stopUnit = (svc) => call(svc.machine, 'stop', { unit: svc.unit });
async function stop(name) {
  const svc = await get(name);
  await stopUnit(svc);
  console.log(`[service] stopped ${svc.unit} on ${svc.machine}`);
  return { ...svc, status: await status(svc) };
}
async function restart(name) {
  await stop(name);
  return start(name); // re-reads the definition, so edits take effect
}
async function logs(name, lines) {
  const svc = await get(name);
  return call(svc.machine, 'logs', { unit: svc.unit, lines });
}

module.exports = { listWithStatus, get, create, update, remove, versions, rollback, status, start, stop, restart, logs };
