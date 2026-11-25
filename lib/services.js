'use strict';
// Service definitions (database), run on their machine by its fleet-agent (connected to us): at each start the agent
// writes /run/systemd/system/fleet-<name>.service (ExecStart=/bin/bash -c <command>, User=<run_as>, ...) and starts it.
//
// Status comes live from the agent: systemd's state, plus, for a running service with a health_url, whether that URL
// answers (checked by the agent, from the service's own machine). `ready` = running and (no health_url, or it answers).
//
// Concurrency, per service:
// - Actions run one at a time, in order (a per-service lock), so two starts at once give one start and one
//   "changed: false", never a systemd error.
// - A request that waits for the outcome (start/stop/restart with wait, and every restart) marks the service busy
//   ('starting' | 'stopping' | 'restarting') for that time, outside the lock; other actions on it then get 409 busy
//   instead of queueing behind a wait that can take minutes.
const db = require('./db');
const agent = require('./agent');
const { ApiError } = require('./errors');

const RESTART = ['no', 'on-failure', 'always'];
// systemd's own default (90 s) is a long time to wait for a service that won't stop: after this it is killed.
// A service can set its own TimeoutStopSec= in its properties.
const DEFAULT_STOP_TIMEOUT = 'TimeoutStopSec=15';
const WAIT_DEFAULT_SEC = 120, WAIT_MAX_SEC = 1800;
const POLL_MS = 1000;            // how often a waiting request checks the status
const HEALTH_TIMEOUT_MS = 3000;  // per health check
const LOG_LINES_ON_ERROR = 30;   // log lines included with start_failed / not_ready
const AGENT_STOP_LIMIT_MS = 10 * 60 * 1000; // the agent gives up waiting for a stop after this

const unitOf = (name) => `fleet-${name}.service`;
const invalid = (msg) => new ApiError(400, 'invalid', msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- per-service lock and busy state ------------------------------------
const locks = new Map();     // name -> the tail of its queue (a promise)
const busy = new Map();      // name -> 'starting' | 'stopping' | 'restarting'
const lastError = new Map(); // name -> { message, at }: the last failed start / restart, until the next action

// Runs fn with the service's lock held (actions on one service run one at a time, in order).
async function locked(name, fn) {
  const prev = locks.get(name) || Promise.resolve();
  let release;
  const mine = new Promise((r) => { release = r; });
  const tail = prev.then(() => mine);
  locks.set(name, tail);
  await prev;
  try { return await fn(); }
  finally { release(); if (locks.get(name) === tail) locks.delete(name); }
}
function notBusy(name) {
  if (busy.has(name)) throw new ApiError(409, 'busy', `${name} is ${busy.get(name)}: wait for it to finish`);
}
// Marks the service busy while `job` (a promise) runs; the mark is set before the lock is released. The returned
// promise is marked as handled at once (its error reaches whoever awaits it, or last_error), so a failure while the
// caller is still releasing the lock is never reported as an unhandled rejection.
function busyWhile(name, what, job) {
  busy.set(name, what);
  const p = job.finally(() => busy.delete(name));
  p.catch(() => {});
  return p;
}
const failed = (name, e) => { lastError.set(name, { message: e.message, at: new Date().toISOString() }); };

// ---- validation ---------------------------------------------------------
const oneLine = (s) => !/[\0\r\n]/.test(s);
// Written as-is into a unit file line: one line, and no trailing backslash (that would continue the line).
const unitLine = (s) => oneLine(s) && !s.endsWith('\\');
function validate(input, machines, { partial = false } = {}) {
  const out = {};
  const has = (k) => input[k] !== undefined;
  const need = (k) => { if (!partial && !has(k)) throw invalid(`${k} is required`); return has(k); };

  if (need('name')) {
    if (typeof input.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(input.name))
      throw invalid('name: 1-40 chars, lowercase letters, digits and -, starting with a letter or digit');
    if (['agent', 'server'].includes(input.name)) throw invalid(`name "${input.name}" is reserved (fleet-agent / fleet-server are the fleet's own units)`);
    out.name = input.name;
  }
  if (need('machine')) { // API uses the machine's name; the database stores its id
    if (!Object.hasOwn(machines, input.machine)) throw invalid(`machine must be one of: ${Object.keys(machines).join(', ')}`);
    out.machine_id = machines[input.machine].id;
  }
  if (need('command')) {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.includes('\0'))
      throw invalid('command is required');
    out.command = input.command;
  }
  if (has('description')) {
    const d = String(input.description ?? '');
    if (d.length > 200 || !unitLine(d)) throw invalid('description: one line, at most 200 chars, not ending with a backslash');
    out.description = d;
  }
  if (has('workdir')) {
    const w = input.workdir ? String(input.workdir) : null;
    if (w && (!w.startsWith('/') || w.length > 255 || !unitLine(w))) throw invalid('workdir must be an absolute path');
    out.workdir = w;
  }
  if (need('run_as')) {
    const u = String(input.run_as ?? '');
    if (!u) throw invalid('run_as is required (the Linux user the service runs as)');
    if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(u)) throw invalid('run_as must be a user name');
    out.run_as = u;
  }
  if (has('env')) {
    const e = input.env || {};
    if (typeof e !== 'object' || Array.isArray(e)) throw invalid('env must be an object of KEY: value');
    for (const [k, v] of Object.entries(e)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw invalid(`env: bad name ${k}`);
      if (typeof v !== 'string' || !oneLine(v)) throw invalid(`env ${k}: value must be a one-line string`);
    }
    out.env = e;
  }
  if (has('properties')) {
    const p = input.properties || [];
    if (!Array.isArray(p)) throw invalid('properties must be a list of Key=Value strings');
    for (const x of p) {
      if (typeof x !== 'string' || !/^[A-Z][A-Za-z]{1,63}=/.test(x) || !unitLine(x))
        throw invalid(`properties: bad entry ${JSON.stringify(x)} (want Key=Value on one line, not ending with a backslash)`);
      if (/^(User|ExecStart|Restart|WorkingDirectory|Environment)=/.test(x))
        throw invalid(`properties: set ${x.split('=')[0]} with its own field`);
    }
    out.properties = p;
  }
  if (has('restart')) {
    if (!RESTART.includes(input.restart)) throw invalid(`restart must be one of: ${RESTART.join(', ')}`);
    out.restart = input.restart;
  }
  if (has('health_url')) {
    const h = input.health_url === null || input.health_url === '' ? null : input.health_url;
    if (h !== null) {
      let u = null;
      if (typeof h === 'string' && h.length <= 500 && oneLine(h)) try { u = new URL(h); } catch { /* invalid below */ }
      if (!u || !['http:', 'https:'].includes(u.protocol))
        throw invalid('health_url must be an http:// or https:// URL (checked from the service\'s machine, e.g. http://127.0.0.1:8080/health)');
    }
    out.health_url = h;
  }
  return out;
}
// ?wait=1&timeout=<seconds> on start / stop / restart.
function waitOptions(query = {}) {
  const w = query.wait;
  if (w !== undefined && !['0', '1', 'true', 'false'].includes(w)) throw invalid('wait must be 1 or 0');
  const wait = w === '1' || w === 'true';
  let sec = WAIT_DEFAULT_SEC;
  if (query.timeout !== undefined) {
    sec = Number(query.timeout);
    if (!Number.isInteger(sec) || sec < 1 || sec > WAIT_MAX_SEC) throw invalid(`timeout must be a whole number of seconds, 1 to ${WAIT_MAX_SEC}`);
  }
  return { wait, timeoutSec: sec };
}

// ---- definitions --------------------------------------------------------
// Every create/save bumps services.version and copies the new definition into service_versions.
const FIELDS = ['name', 'machine_id', 'description', 'command', 'workdir', 'run_as', 'env', 'restart', 'properties', 'health_url'];
const snapshot = (id, rolledBackFrom = null) => db.run(
  `INSERT INTO service_versions (service_id, version, ${FIELDS}, rolled_back_from) SELECT id, version, ${FIELDS}, ? FROM services WHERE id = ?`,
  rolledBackFrom, id);
const json = (v, empty) => (v == null ? empty : JSON.parse(v)); // env / properties are stored as JSON text
const fields = (r) => ({
  name: r.name, machine: r.machine, description: r.description, command: r.command, workdir: r.workdir,
  run_as: r.run_as, env: json(r.env, {}), restart: r.restart, properties: json(r.properties, []), health_url: r.health_url ?? null,
});
// Rows are read joined with machines, so r.machine is the machine's current name.
const SELECT = 'SELECT s.*, m.name AS machine FROM services s JOIN machines m ON m.id = s.machine_id';
const rowOut = (r) => ({ id: r.id, version: r.version, ...fields(r), machine_id: r.machine_id, unit: unitOf(r.name), created_at: r.created_at, updated_at: r.updated_at });
const dup = (e) => (db.isUnique(e) ? new ApiError(409, 'name_taken', 'a service with that name already exists') : e);

async function get(name) {
  const row = db.get(`${SELECT} WHERE s.name = ?`, name);
  if (!row) throw new ApiError(404, 'not_found', 'no such service');
  return rowOut(row);
}
async function create(input) {
  const v = validate(input, db.machines({ approvedOnly: true }));
  try {
    db.tx(() => {
      const r = db.run('INSERT INTO services (name, machine_id, description, command, workdir, run_as, env, restart, properties, health_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
        v.name, v.machine_id, v.description ?? '', v.command, v.workdir ?? null, v.run_as,
        JSON.stringify(v.env ?? {}), v.restart ?? 'no', JSON.stringify(v.properties ?? []), v.health_url ?? null);
      snapshot(r.lastInsertRowid);
    });
  } catch (e) { throw dup(e); }
  console.log(`[service] created ${v.name} v1`);
  return get(v.name);
}
function update(name, input, { rolledBackFrom = null } = {}) {
  return locked(name, async () => {
    const cur = await get(name);
    notBusy(cur.name);
    const v = validate(input, db.machines({ approvedOnly: true }), { partial: true });
    // Renaming or moving a running service would leave its unit running unmanaged, so it must be stopped first.
    // If its machine can't be reached, we can't tell (and can't stop it), so the change is allowed.
    if ((v.name && v.name !== cur.name) || (v.machine_id && v.machine_id !== cur.machine_id)) {
      const st = await status(cur).catch((e) => { if (unreachable(e)) return { unreachable: true }; throw e; });
      if (st.running) throw new ApiError(409, 'running', 'stop the service before changing its name or machine');
      if (st.unreachable) console.log(`[service] ${cur.name}: ${cur.machine} unreachable, changing name/machine without checking it`);
    }
    const cols = Object.keys(v);
    const vals = cols.map((k) => (k === 'env' || k === 'properties' ? JSON.stringify(v[k]) : v[k]));
    try {
      db.tx(() => {
        db.run(`UPDATE services SET ${cols.map((c) => `${c} = ?, `).join('')}version = version + 1, updated_at = ${db.NOW} WHERE id = ?`, ...vals, cur.id);
        snapshot(cur.id, rolledBackFrom);
      });
    } catch (e) { throw dup(e); }
    if (v.name && v.name !== cur.name) lastError.delete(cur.name);
    // Renamed or moved: the old unit file (on the old machine) is no longer used.
    if ((v.name && v.name !== cur.name) || (v.machine_id && v.machine_id !== cur.machine_id)) await removeUnit(cur);
    const saved = await get(v.name || name);
    console.log(`[service] saved ${saved.name} v${saved.version}${rolledBackFrom ? ` (rolled back from v${rolledBackFrom})` : ''}`);
    return saved;
  });
}
// All versions, newest first.
async function versions(name) {
  const svc = await get(name);
  // LEFT JOIN: a version whose machine has since been removed is kept, with machine = null.
  const rows = db.all('SELECT v.*, m.name AS machine FROM service_versions v LEFT JOIN machines m ON m.id = v.machine_id WHERE v.service_id = ? ORDER BY v.version DESC', svc.id);
  return rows.map((r) => ({ version: r.version, rolled_back_from: r.rolled_back_from, created_at: r.created_at, ...fields(r) }));
}
// Roll back = save an old version's definition as a new version. A running service keeps running the old one until restarted.
async function rollback(name, version) {
  const svc = await get(name);
  const row = db.get('SELECT v.*, m.name AS machine FROM service_versions v LEFT JOIN machines m ON m.id = v.machine_id WHERE v.service_id = ? AND v.version = ?', svc.id, version);
  if (!row) throw new ApiError(404, 'not_found', `no version ${version}`);
  if (!row.machine) throw new ApiError(409, 'machine_removed', `v${version} ran on a machine that has since been removed`);
  return update(name, fields(row), { rolledBackFrom: version });
}
// The machine can't be reached: its agent isn't connected, isn't approved, or doesn't answer.
const unreachable = (e) => ['machine_offline', 'machine_not_approved', 'agent_timeout'].includes(e.code);
// Stops it on its machine first and waits for that (up to its TimeoutStopSec), so it is only removed from the database
// once it really has stopped. If the machine can't be reached it is refused (with can_force) unless force is set:
// then it is only removed from the database.
function remove(name, { force = false } = {}) {
  return locked(name, async () => {
    const svc = await get(name);
    notBusy(svc.name);
    try { await stopUnit(svc, { wait: true }); }
    catch (e) {
      if (!unreachable(e)) throw e;
      if (!force) throw new ApiError(e.status, e.code, e.message, { can_force: true });
      console.log(`[service] ${svc.name}: deleting without stopping it (${e.message})`);
    }
    db.run('DELETE FROM services WHERE id = ?', svc.id); // its versions go with it (ON DELETE CASCADE)
    await removeUnit(svc);
    lastError.delete(svc.name);
    console.log(`[service] deleted ${svc.name}`);
  });
}

// ---- live status (via the machine's fleet-agent) -------------------------
// The agent asks systemctl for --timestamp=unix ("@1764051808"); anything else (older agent) is passed through.
const unixToIso = (t) => (/^@\d+$/.test(t || '') ? new Date(Number(t.slice(1)) * 1000).toISOString() : t || null);
// Status of several services on one machine: one `show` call for all of them, then one `probe` call for the health
// URLs of those that are running.
async function showMany(machine, svcs) {
  const blocks = await agent.call(machine, 'show', { units: svcs.map((s) => s.unit) });
  const out = svcs.map((s, i) => {
    const p = blocks[i] || {};
    if (p.LoadState !== 'loaded') return { active: 'inactive', sub: 'dead', running: false };
    return {
      active: p.ActiveState, sub: p.SubState,
      running: ['active', 'activating', 'reloading', 'deactivating'].includes(p.ActiveState),
      pid: Number(p.MainPID) || null, since: unixToIso(p.ExecMainStartTimestamp), exit_status: Number(p.ExecMainStatus),
    };
  });
  const toProbe = svcs.map((s, i) => i).filter((i) => svcs[i].health_url && out[i].active === 'active');
  if (toProbe.length) {
    let results;
    if (!agent.supports(machine, 'probe'))
      results = toProbe.map(() => ({ ok: false, error: `the fleet-agent on ${machine} is too old for health checks: run fleet-agent.js --install on it again` }));
    else {
      try { results = await agent.call(machine, 'probe', { urls: toProbe.map((i) => svcs[i].health_url), timeout_ms: HEALTH_TIMEOUT_MS }); }
      catch (e) { results = toProbe.map(() => ({ ok: false, error: e.message })); }
    }
    toProbe.forEach((i, k) => { out[i].health = results[k] || { ok: false, error: 'no answer from the agent' }; });
  }
  svcs.forEach((s, i) => { out[i].ready = out[i].active === 'active' && (!s.health_url || out[i].health?.ok === true); });
  return out;
}
const status = async (svc) => (await showMany(svc.machine, [svc]))[0];

// All services with live status: one agent call per machine (two with health checks); a machine without a
// connected agent gives { error }.
async function listWithStatus() {
  const all = db.all(`${SELECT} ORDER BY m.sort_order, s.name`).map(rowOut), byMachine = {};
  for (const s of all) (byMachine[s.machine] ||= []).push(s);
  await Promise.all(Object.entries(byMachine).map(async ([machine, svcs]) => {
    try { (await showMany(machine, svcs)).forEach((st, i) => { svcs[i].status = st; }); }
    catch (e) { svcs.forEach((s) => { s.status = { error: e.message, code: e.code }; }); }
  }));
  return all.map(withState);
}

// The fleet's own state of a service: busy (a request is starting / stopping / restarting it) and the last failure.
const withState = (s) => ({ ...s, busy: busy.get(s.name) || null, last_error: lastError.get(s.name) || null });
async function withStatus(svc, changed) {
  let st;
  try { st = await status(svc); } catch (e) { st = { error: e.message, code: e.code }; }
  return { ...withState({ ...svc, status: st }), changed };
}
// One service with live status (GET /api/services/{name}).
async function single(name) {
  const { changed, ...s } = await withStatus(await get(name));
  return s;
}

// ---- control ------------------------------------------------------------
// Deletes a service's unit file on its machine (after delete / rename / move). It lives in /run, so if the machine
// can't be reached now it is gone at its next reboot anyway; agents from before unit files have nothing to remove.
async function removeUnit(svc) {
  if (!agent.supports(svc.machine, 'remove')) return;
  try { await agent.call(svc.machine, 'remove', { unit: svc.unit }); }
  catch (e) { console.log(`[service] ${svc.unit} on ${svc.machine}: could not remove its unit file (${e.message}); it is gone after a reboot`); }
}
async function startUnit(svc) {
  const properties = [`User=${svc.run_as}`, `Restart=${svc.restart}`];
  if (svc.restart !== 'no' && !svc.properties.some((p) => p.startsWith('RestartSec='))) properties.push('RestartSec=2');
  if (!svc.properties.some((p) => p.startsWith('TimeoutStopSec='))) properties.push(DEFAULT_STOP_TIMEOUT);
  properties.push(...svc.properties);
  if (svc.workdir) properties.push(`WorkingDirectory=${svc.workdir}`);
  // Starting stops what it Conflicts= with first, which can take that service's TimeoutStopSec.
  await agent.call(svc.machine, 'start',
    { unit: svc.unit, description: `fleet: ${svc.description || svc.name}`, properties, env: svc.env, command: svc.command },
    { timeoutMs: AGENT_STOP_LIMIT_MS + 60000 });
  console.log(`[service] started ${svc.unit} on ${svc.machine}`);
}
// wait: false returns as soon as the stop has begun (the unit shows as deactivating until it is done).
// wait: true returns once it has stopped (systemd kills it after its TimeoutStopSec), within timeoutMs.
async function stopUnit(svc, { wait, timeoutMs = AGENT_STOP_LIMIT_MS }) {
  try {
    await agent.call(svc.machine, 'stop', { unit: svc.unit, wait }, { timeoutMs: wait ? Math.min(timeoutMs, AGENT_STOP_LIMIT_MS + 60000) : 30000 });
  } catch (e) {
    if (wait && e.code === 'agent_timeout') throw new ApiError(504, 'not_stopped', `${svc.name} did not stop within ${Math.round(timeoutMs / 1000)} s`);
    throw e;
  }
}
async function recentLogs(svc) {
  try { return await agent.call(svc.machine, 'logs', { unit: svc.unit, lines: LOG_LINES_ON_ERROR }); } catch { return null; }
}
// Waits until a just-started service is ready; fails if it stops or crashes first, or isn't ready by the deadline.
async function awaitReady(svc, deadline, timeoutSec) {
  for (;;) {
    const st = await status(svc);
    if (st.ready) return st;
    if (!st.running || st.sub === 'auto-restart') {
      const what = st.sub === 'auto-restart' ? 'exited and systemd is restarting it'
        : `${st.active === 'failed' ? 'failed' : 'exited'}${Number.isFinite(st.exit_status) ? ` (exit status ${st.exit_status})` : ''}`;
      throw new ApiError(502, 'start_failed', `${svc.name} ${what}`, { logs: await recentLogs(svc) });
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const why = st.health ? `: ${svc.health_url} ${st.health.error || `answered ${st.health.status}`}` : '';
      throw new ApiError(504, 'not_ready', `${svc.name} did not become ready within ${timeoutSec} s${why}`, { logs: await recentLogs(svc) });
    }
    await sleep(Math.min(POLL_MS, left));
  }
}

// Start. Already running = nothing to do (changed: false). With wait, returns once it is ready.
async function start(name, { wait = false, timeoutSec = WAIT_DEFAULT_SEC } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let svc, changed, job = null;
  await locked(name, async () => {
    svc = await get(name);
    notBusy(svc.name);
    changed = !(await status(svc)).running;
    if (changed) {
      lastError.delete(svc.name);
      await startUnit(svc);
    }
    if (wait) job = busyWhile(svc.name, 'starting', awaitReady(svc, deadline, timeoutSec));
  });
  if (job) await job.catch((e) => { failed(svc.name, e); throw e; });
  return withStatus(svc, changed);
}
// Stop. Already stopped = nothing to do (changed: false). With wait, returns once it has stopped.
async function stop(name, { wait = false, timeoutSec = WAIT_DEFAULT_SEC } = {}) {
  let svc, changed, job = null;
  await locked(name, async () => {
    svc = await get(name);
    notBusy(svc.name);
    changed = (await status(svc)).running;
    if (!changed) return;
    lastError.delete(svc.name);
    if (wait) job = busyWhile(svc.name, 'stopping', stopUnit(svc, { wait: true, timeoutMs: timeoutSec * 1000 }));
    else await stopUnit(svc, { wait: false });
    console.log(`[service] stopping ${svc.unit} on ${svc.machine}`);
  });
  if (job) await job;
  return withStatus(svc, changed);
}
// Restart = stop (waiting for it), then start from the current definition (so edits take effect). Without wait it
// runs in the background: busy: 'restarting' until done, a failure in last_error. With wait it also waits until the
// service is ready, and answers with the outcome.
async function restart(name, { wait = false, timeoutSec = WAIT_DEFAULT_SEC } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let svc, job;
  await locked(name, async () => {
    svc = await get(name);
    notBusy(svc.name);
    await status(svc); // the machine must be reachable now, or this fails right away
    lastError.delete(svc.name);
    console.log(`[service] restarting ${svc.unit} on ${svc.machine}`);
    job = busyWhile(svc.name, 'restarting', (async () => {
      await stopUnit(svc, { wait: true, timeoutMs: wait ? deadline - Date.now() : AGENT_STOP_LIMIT_MS });
      const fresh = await get(svc.name);
      await startUnit(fresh);
      if (wait) await awaitReady(fresh, deadline, timeoutSec);
    })().catch((e) => {
      failed(svc.name, Object.assign(e, { message: `restart failed: ${e.message}` }));
      console.log(`[service] restarting ${svc.unit} failed: ${e.message}`);
      throw e;
    }));
  });
  if (wait) await job; // without wait, a failure is reported in last_error
  return withStatus(await get(svc.name), true);
}
async function logs(name, lines) {
  const svc = await get(name);
  return agent.call(svc.machine, 'logs', { unit: svc.unit, lines });
}

module.exports = { listWithStatus, single, get, create, update, remove, versions, rollback, start, stop, restart, logs, waitOptions };
