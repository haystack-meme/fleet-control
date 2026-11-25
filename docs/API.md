# Using the fleet API from code

This guide shows how to drive fleet from your own programs: list machines, create services, start and stop them,
wait until they are ready, switch a GPU between services, read logs, back up, and handle every error properly.

All examples are **Node.js** (22 or newer, built-in modules only, CommonJS). A few `curl` one-liners are at the end
for shell scripts. The README has the short [API reference](../README.md#api); this guide is the long version.

- [1. Setup](#1-setup)
- [2. A small client](#2-a-small-client)
- [3. Machines](#3-machines)
- [4. Services: create, read, change](#4-services-create-read-change)
- [5. Starting, stopping and waiting](#5-starting-stopping-and-waiting)
- [6. Recipes](#6-recipes)
- [7. Errors](#7-errors)
- [8. Logs, history and rollback](#8-logs-history-and-rollback)
- [9. Backup, restore and the API key](#9-backup-restore-and-the-api-key)
- [10. Public files](#10-public-files)
- [11. Shell (curl)](#11-shell-curl)
- [12. Reference: objects and behaviour](#12-reference-objects-and-behaviour)

---

## 1. Setup

You need three things: the server's address, the API key and a copy of the server's certificate.

**The API key.** On the page: **⋯ → API key → Copy**. There is always exactly one key; it can do everything the
page can (which is: run any command as any user on every approved machine), so keep it out of repositories, logs
and shared shells.

**The certificate.** The server's certificate is self-signed. Don't switch certificate checking off (`-k`,
`rejectUnauthorized: false`, `NODE_TLS_REJECT_UNAUTHORIZED=0`): copy the certificate once and check against it.
It lives in the server's data folder, readable only by root and the `fleet` user:

```sh
ssh <server> 'sudo cat /opt/fleet-control/data/tls.crt' > fleet.crt
```

It is made for the server's hostname and IP addresses, so connect to one of those (as `https://<ip>` or
`https://<hostname>`). If the server's certificate is ever replaced, copy it again.

**Environment.** The examples read these:

```sh
export FLEET_URL=https://192.0.2.10        # add :port if the server isn't on 443
export FLEET_API_KEY=<the key>
export FLEET_CA=$PWD/fleet.crt
```

---

## 2. A small client

Copy this file next to your scripts. It has no dependencies.

Why not the built-in `fetch`? Two reasons: it can't be given a certificate to trust per request (only through the
`NODE_EXTRA_CA_CERTS` environment variable), and it gives up on any response that takes more than 300 seconds to
start, which breaks long `?wait=1` calls (a big model can take longer than that to become ready). `node:https` has
neither problem.

```js
// file: fleet.js
'use strict';
// A minimal client for the fleet API. Node.js built-ins only.
// Reads FLEET_URL, FLEET_API_KEY and FLEET_CA (a copy of the server's certificate) from the environment.
const fs = require('node:fs');
const https = require('node:https');

const need = (name) => process.env[name] || (() => { throw new Error(`set ${name}`); })();
const BASE = new URL(need('FLEET_URL'));
const KEY = need('FLEET_API_KEY');
const CA = fs.readFileSync(need('FLEET_CA'));

// An error answer from the API: status (HTTP), code (stable, see section 7), message, and for some codes extra
// fields: logs (start_failed, not_ready) and canForce (delete while the machine is offline).
class FleetError extends Error {
  constructor(status, body) {
    super(body?.error || `HTTP ${status}`);
    this.name = 'FleetError';
    this.status = status;
    this.code = body?.code ?? null;
    this.logs = body?.logs ?? null;
    this.canForce = body?.can_force === true;
  }
}

// One request. `json` is sent as a JSON body, `body` (a Buffer) as is. Resolves to the parsed JSON, the text, or
// (for binary answers) a Buffer; rejects with a FleetError for 4xx/5xx answers.
// timeoutMs bounds the whole request; the default allows the longest server-side wait (30 min) plus a margin.
function api(method, path, { json, body, timeoutMs = 31 * 60 * 1000 } = {}) {
  const url = new URL(path, BASE);
  const payload = json !== undefined ? Buffer.from(JSON.stringify(json)) : body;
  const headers = { Authorization: `Bearer ${KEY}`, Accept: 'application/json' };
  if (payload) {
    headers['Content-Type'] = json !== undefined ? 'application/json' : 'application/octet-stream';
    headers['Content-Length'] = payload.length;
  }
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers, ca: CA }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks), type = res.headers['content-type'] || '';
        const data = type.includes('json') ? JSON.parse(buf.toString() || 'null') : type.startsWith('text/') ? buf.toString() : buf;
        if (res.statusCode >= 400) reject(new FleetError(res.statusCode, typeof data === 'object' && !Buffer.isBuffer(data) ? data : null));
        else resolve(data);
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`${method} ${url.pathname}: no answer within ${timeoutMs / 1000} s`)));
    req.on('error', reject);
    req.end(payload);
  });
}

const get = (path, opts) => api('GET', path, opts);
const post = (path, json, opts) => api('POST', path, { json: json ?? {}, ...opts });
const put = (path, json, opts) => api('PUT', path, { json, ...opts });
const del = (path, opts) => api('DELETE', path, opts);
const enc = encodeURIComponent;

module.exports = { api, get, post, put, del, enc, FleetError };
```

Everything below uses it:

```js
const { get, post, put, del, enc, FleetError } = require('./fleet');
```

> Names in paths: service and machine names are restricted to letters, digits, `.` and `-`, so they never need
> escaping, but `enc()` costs nothing and keeps the habit.

---

## 3. Machines

`GET /api/machines` lists every enrolled machine: approved ones (in the order shown on the page) and new ones
waiting for a decision.

```js
// file: machines.js
'use strict';
// Lists the machines with their state and, for approved online machines, their live stats.
const { get } = require('./fleet');

const pct = (part, whole) => (whole ? `${Math.round((100 * part) / whole)} %` : '-');

(async () => {
  for (const m of await get('/api/machines')) {
    const s = m.stats;
    const line = [m.name.padEnd(16), m.status.padEnd(9), (m.online ? 'online' : 'offline').padEnd(8), m.address ?? ''];
    if (s) {
      line.push(`cpu ${s.cpu_pct} %`, `mem ${pct(s.mem_total_kb - s.mem_avail_kb, s.mem_total_kb)}`,
        `disk ${pct(s.disk_used_kb, s.disk_total_kb)}`, `up ${Math.round(s.uptime_sec / 3600)} h`);
      for (const g of s.gpus ?? []) line.push(`${g.name}: ${g.util_pct} % busy, ${g.vram_used_mb}/${g.vram_total_mb} MB`);
    }
    console.log(line.join('  '));
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

A machine has `name`, `address` (where its agent connects from), `status` (`pending` / `approved` /
`rejected`), `online`, and `stats` (only for approved, online machines; the fields are in
[section 12](#machine)). Stats refresh every 5 seconds.

**Approving new machines.** A machine that runs `fleet-agent.js --install` shows up as `pending` and gets no
commands until approved. Approve only machines you recognise: approving one lets fleet run commands on it.

```js
// file: approve.js
'use strict';
// Approves the named machines if they are waiting: node approve.js gpu-2 gpu-3
const { get, post, enc } = require('./fleet');

(async () => {
  const wanted = process.argv.slice(2);
  if (!wanted.length) throw new Error('usage: node approve.js <machine> ...');
  const machines = await get('/api/machines');
  for (const name of wanted) {
    const m = machines.find((x) => x.name === name);
    if (!m) console.log(`${name}: not enrolled (run fleet-agent.js --install on it first)`);
    else if (m.status === 'approved') console.log(`${name}: already approved`);
    else { await post(`/api/machines/${enc(name)}/approve`); console.log(`${name}: approved`); }
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

Other machine calls: `POST /api/machines/{name}/reject`, `DELETE /api/machines/{name}` (removes it and its key;
refused with `409 has_services` while it has services), and `PUT /api/machines/order` with
`{"names": [...]}` (every machine exactly once) to set the order:

```js
// file: order-machines.js
'use strict';
// Sorts the machines on the page alphabetically.
const { get, put } = require('./fleet');

(async () => {
  const names = (await get('/api/machines')).map((m) => m.name).sort();
  await put('/api/machines/order', { names });
  console.log(names.join(' > '));
})().catch((e) => { console.error(e.message); process.exit(1); });
```

---

## 4. Services: create, read, change

A service is a command that runs on one machine as a systemd unit (`fleet-<name>.service`). Create one with
`POST /api/services`:

```js
// file: create-service.js
'use strict';
// Creates a service: node create-service.js <machine>
// (a small web server on 127.0.0.1:18090 that becomes ready a few seconds after it starts).
const { post, FleetError } = require('./fleet');

(async () => {
  const machine = process.argv[2];
  if (!machine) throw new Error('usage: node create-service.js <machine>');
  try {
    const svc = await post('/api/services', {
      name: 'demo-web',                       // 1-40 chars: a-z, 0-9, -; unit fleet-demo-web.service
      machine,                                // an approved machine
      command: 'sleep 2; mkdir -p /tmp/demo-web && echo "hello from $(hostname)" > /tmp/demo-web/index.html && ' +
               'exec python3 -m http.server 18090 --bind 127.0.0.1 --directory /tmp/demo-web',
      run_as: 'www-data',                     // the Linux user it runs as (root allowed)
      description: 'demo web page',           // optional, one line
      workdir: '/tmp',                        // optional, absolute path
      env: { GREETING: 'hello' },             // optional
      restart: 'on-failure',                  // no (default) | on-failure | always
      properties: ['MemoryMax=256M'],         // optional extra systemd settings
      health_url: 'http://127.0.0.1:18090/',  // optional: "ready" = running and this answers 2xx/3xx
    });
    console.log(`created ${svc.name} v${svc.version} on ${svc.machine} (${svc.unit})`);
  } catch (e) {
    if (e instanceof FleetError && e.code === 'name_taken') console.log('demo-web already exists');
    else throw e;
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

Notes on the fields:

- **`command`** runs with `/bin/bash -c` exactly as written: quotes, `$VARS`, pipes, `&&`, several lines. Start
  long-running programs with `exec` so the program itself (not bash) gets systemd's stop signal.
- **`run_as`** is required. `root` is allowed.
- **`properties`** are extra systemd settings (`Key=Value`), e.g. `SupplementaryGroups=video render` for GPU
  access, `Conflicts=fleet-other.service`, `MemoryMax=8G`, `TimeoutStopSec=60`, `RequiresMountsFor=/mnt/data`.
  `User`, `ExecStart`, `Restart`, `WorkingDirectory` and `Environment` are refused: use their own fields.
  Every service gets `TimeoutStopSec=15` unless it sets its own.
- **`health_url`** is checked by the agent **from the service's own machine**, so `127.0.0.1` means that machine.
  Any 2xx/3xx answer within 3 seconds counts (redirects aren't followed; HTTPS certificates aren't checked). Set
  one whenever "the process is running" isn't the same as "it works" (model servers, web apps).

**Reading.** `GET /api/services` lists all services with live status (one request to each machine's agent);
`GET /api/services/{name}` reads one.

```js
// file: status.js
'use strict';
// Prints every service with its live state.
const { get } = require('./fleet');

function state(s) {
  const st = s.status;
  if (st.error) return `unknown (${st.code}: ${st.error})`;          // machine offline or agent error
  if (s.busy) return `${s.busy}…`;                                    // a request is starting/stopping/restarting it
  if (st.ready) return 'ready';
  if (st.running) return `running, not ready${st.health ? ` (${st.health.error ?? `HTTP ${st.health.status}`})` : ''}`;
  return st.active === 'failed' ? `failed (exit ${st.exit_status})` : 'stopped';
}

(async () => {
  for (const s of await get('/api/services')) {
    console.log(`${s.machine.padEnd(14)} ${s.name.padEnd(20)} v${String(s.version).padEnd(4)} ${state(s)}`);
    if (s.last_error) console.log(`${''.padEnd(14)} last error: ${s.last_error.message}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

**Changing.** `PUT /api/services/{name}` with only the fields you want to change. Every save is a new version
(see [history](#8-logs-history-and-rollback)). A running service keeps running its old definition until it is
restarted, so a typical change is "save, then restart and wait":

```js
// file: update-and-restart.js
'use strict';
// Changes a service and restarts it; if the new version doesn't come up, rolls back and restarts the old one.
// node update-and-restart.js demo-web '{"env":{"GREETING":"hi"}}'
const { get, put, post, enc, FleetError } = require('./fleet');

(async () => {
  const [name, changes] = [process.argv[2], JSON.parse(process.argv[3] || '{}')];
  if (!name) throw new Error('usage: node update-and-restart.js <service> <json changes>');
  const before = await get(`/api/services/${enc(name)}`);               // the version to come back to
  const saved = await put(`/api/services/${enc(name)}`, changes);        // a new version
  console.log(`saved ${name} v${saved.version}`);
  try {
    const r = await post(`/api/services/${enc(name)}/restart?wait=1&timeout=300`);
    console.log(`${name} v${saved.version} is ready (pid ${r.status.pid})`);
  } catch (e) {
    if (!(e instanceof FleetError) || !['start_failed', 'not_ready'].includes(e.code)) throw e;
    console.error(`v${saved.version} did not come up (${e.code}): ${e.message}\n${e.logs ?? ''}`);
    await post(`/api/services/${enc(name)}/rollback`, { version: before.version });
    await post(`/api/services/${enc(name)}/restart?wait=1&timeout=300`);
    console.error(`rolled back to v${before.version}'s definition, and it is ready again`);
    process.exit(1);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

**Renaming and moving** (`PUT` with `name` / `machine`) are refused with `409 running` while the service runs:
stop it first. **Deleting** (`DELETE /api/services/{name}`) stops it first and waits for that; if its machine is
offline it is refused with `502 machine_offline` and `can_force: true`, and `?force=1` then deletes it from the
database only (it may keep running on that machine until it reboots).

---

## 5. Starting, stopping and waiting

`POST /api/services/{name}/start`, `/stop` and `/restart` answer with the service (with live `status`) plus
`changed`:

| Call | Without `?wait=1` it answers… | With `?wait=1` it answers… |
|---|---|---|
| `start` | once systemd has started the process | once the service is **ready** |
| `stop` | once the stop has begun (`status.active` may be `deactivating`) | once it has **stopped** |
| `restart` | at once; the restart runs in the background (`busy: "restarting"`) | once the new process is **ready** |

- **Safe to repeat:** starting a running service, or stopping a stopped one, changes nothing and answers `200` with
  `"changed": false`. With `?wait=1`, starting a running service still waits until it is ready.
- **`&timeout=<seconds>`** (1-1800, default 120) bounds the wait. Big models can take minutes: give them room.
- **Ready** means running and answering its `health_url`; without a health URL, ready means systemd has it running
  (fleet can't know more).
- **When it doesn't come up**, the answer is an error with the service's recent log lines in `logs`:
  - `502 start_failed`: it exited or crashed while starting (including a crash loop with `restart: always`).
  - `504 not_ready`: still running, but not ready by the timeout. It is **left running**: it may just be slow.

```js
// file: start-and-wait.js
'use strict';
// Starts a service and waits until it is ready: node start-and-wait.js <service> [timeout seconds]
const { post, enc, FleetError } = require('./fleet');

(async () => {
  const [name, timeout = '120'] = process.argv.slice(2);
  if (!name) throw new Error('usage: node start-and-wait.js <service> [timeout seconds]');
  const t0 = Date.now();
  try {
    const r = await post(`/api/services/${enc(name)}/start?wait=1&timeout=${timeout}`);
    const took = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(r.changed ? `${name} started and ready in ${took} s` : `${name} was already running (ready)`);
  } catch (e) {
    if (!(e instanceof FleetError)) throw e;
    if (e.code === 'start_failed') console.error(`${name} crashed while starting: ${e.message}`);
    else if (e.code === 'not_ready') console.error(`${name} is running but not ready after ${timeout} s: ${e.message}`);
    else console.error(`${name}: ${e.code}: ${e.message}`);
    if (e.logs) console.error(`--- recent log lines ---\n${e.logs.trimEnd()}`);
    process.exit(1);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

Stopping works the same way: `POST /api/services/{name}/stop?wait=1` answers once the process is gone (systemd
sends SIGTERM, then SIGKILL after the service's `TimeoutStopSec`). Without `wait`, poll
`GET /api/services/{name}` until `status.running` is `false` if you need to know.

**One action at a time.** Requests for the same service are handled one after the other (four simultaneous starts
give one start and three `changed: false`). While a request is *waiting* on a service (`?wait=1`, or a restart),
other actions on that service get `409 busy` instead of queueing behind a wait that can take minutes; `busy` on
the service says which (`"starting"`, `"stopping"`, `"restarting"`). Different services never block each other.

---

## 6. Recipes

### Switch a GPU between services

Two services that need the same GPU each get `Conflicts=` with the other. Starting one makes systemd stop the other
first, so a switch is a single call, and with `?wait=1` its answer means the new service works:

```js
// file: switch-gpu.js
'use strict';
// node switch-gpu.js <service to run> <service it replaces>
// Makes sure both conflict with each other, then starts the first; systemd stops the second.
const { get, put, post, enc } = require('./fleet');

async function conflictWith(name, other) {
  const svc = await get(`/api/services/${enc(name)}`);
  const want = `Conflicts=fleet-${other}.service`;
  if (!svc.properties.includes(want)) await put(`/api/services/${enc(name)}`, { properties: [...svc.properties, want] });
}

(async () => {
  const [on, off] = process.argv.slice(2);
  if (!on || !off) throw new Error('usage: node switch-gpu.js <service to run> <service it replaces>');
  await conflictWith(on, off);   // saving a definition doesn't touch a running service
  await conflictWith(off, on);
  const t0 = Date.now();
  const r = await post(`/api/services/${enc(on)}/start?wait=1&timeout=600`);
  const other = await get(`/api/services/${enc(off)}`);
  console.log(`${on}: ${r.status.ready ? 'ready' : 'not ready'} after ${((Date.now() - t0) / 1000).toFixed(1)} s; ` +
    `${off}: ${other.status.running ? 'still running' : 'stopped'}`);
})().catch((e) => { console.error(`${e.code ?? 'error'}: ${e.message}${e.logs ? `\n${e.logs}` : ''}`); process.exit(1); });
```

A `Conflicts=` change takes effect at the next start of each service. In the call above that's immediate for the
service being started; the other one already counts because conflicts work in both directions.

### Make sure a set of services is running

Starts whatever isn't running, in parallel, and reports each one. Safe to run from cron: running services are left
alone (`changed: false`).

```js
// file: ensure-running.js
'use strict';
// node ensure-running.js svc-a svc-b ...  (exit status 1 if any isn't ready)
const { post, enc } = require('./fleet');

(async () => {
  const names = process.argv.slice(2);
  const results = await Promise.allSettled(names.map((n) => post(`/api/services/${enc(n)}/start?wait=1&timeout=300`)));
  let ok = true;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') console.log(`${names[i]}: ${r.value.changed ? 'started, ready' : 'already ready'}`);
    else { ok = false; console.log(`${names[i]}: ${r.reason.code ?? 'error'}: ${r.reason.message}`); }
  });
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
```

### Wait for a machine to come online

After a machine reboots, its agent reconnects on its own (within about 30 seconds of the network being up), but its
services stay stopped. This waits for the machine, then starts what you name:

```js
// file: after-reboot.js
'use strict';
// node after-reboot.js <machine> <service> ...
const { get, post, enc } = require('./fleet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitOnline(machine, timeoutMs = 10 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const m = (await get('/api/machines')).find((x) => x.name === machine);
    if (!m) throw new Error(`no machine ${machine}`);
    if (m.online && m.status === 'approved') return m;
    if (Date.now() > deadline) throw new Error(`${machine} is not online after ${timeoutMs / 1000} s`);
    await sleep(5000);
  }
}

(async () => {
  const [machine, ...services] = process.argv.slice(2);
  if (!machine) throw new Error('usage: node after-reboot.js <machine> <service> ...');
  await waitOnline(machine);
  console.log(`${machine} is online`);
  for (const s of services) {
    const r = await post(`/api/services/${enc(s)}/start?wait=1&timeout=600`);
    console.log(`${s}: ${r.changed ? 'started' : 'was already running'}, ready`);
  }
})().catch((e) => { console.error(`${e.code ?? 'error'}: ${e.message}`); process.exit(1); });
```

### Retry what is worth retrying

Most errors are final (a wrong field won't fix itself). A few are about timing and are worth a retry with a pause:
`machine_offline` (the agent is reconnecting, e.g. after a reboot or a server restart), `agent_timeout`, and `busy`
(another request is changing the service right now).

```js
// file: retry.js
'use strict';
// withRetry(fn): calls fn() and retries it on the errors that are about timing, with a growing pause.
const { FleetError } = require('./fleet');

const RETRYABLE = new Set(['machine_offline', 'agent_timeout', 'busy']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, { attempts = 6, firstDelayMs = 2000, maxDelayMs = 30000 } = {}) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      const retry = e instanceof FleetError ? RETRYABLE.has(e.code) : ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(e.code);
      if (!retry || i >= attempts) throw e;
      await sleep(Math.min(firstDelayMs * 2 ** (i - 1), maxDelayMs));
    }
  }
}

module.exports = { withRetry };

// Used as: node retry.js <service>
if (require.main === module) {
  const { post, enc } = require('./fleet');
  const name = process.argv[2];
  withRetry(() => post(`/api/services/${enc(name)}/start?wait=1`))
    .then((r) => console.log(`${name}: ${r.changed ? 'started' : 'already running'}`))
    .catch((e) => { console.error(`${e.code ?? 'error'}: ${e.message}`); process.exit(1); });
}
```

---

## 7. Errors

Every error answer is JSON: `{"error": "<message for people>", "code": "<stable code>"}`, sometimes with more
fields. **Branch on `code`**, never on the message (messages may be reworded).

| HTTP | `code` | Meaning | What to do |
|---|---|---|---|
| 400 | `invalid` | a field or parameter is wrong; the message says which | fix the request |
| 400 | `bad_json` | the body isn't valid JSON | fix the request |
| 400 | `bad_backup` | the uploaded backup is damaged, changed or not a fleet backup | use an unchanged `.fleetbackup` |
| 401 | `unauthorized` | no valid API key (or session) | check `FLEET_API_KEY`; was it rerolled? |
| 401 | `wrong_password` | wrong password at `POST /login` | |
| 403 | `wrong_password` | wrong current password at `POST /api/password` | |
| 403 | `machine_not_approved` | the machine isn't approved | approve the machine |
| 404 | `not_found` | no such service, machine, version or route | |
| 409 | `name_taken` | another service has that name | |
| 409 | `running` | renaming or moving a running service | stop it first |
| 409 | `busy` | another request is starting / stopping / restarting it | retry shortly |
| 409 | `has_services` | rejecting or removing a machine that still has services | delete or move them |
| 409 | `machine_removed` | rolling back to a version whose machine was removed | |
| 409 | `password_set` | two people set the first password at once; the other one won | sign in |
| 413 | `too_large` | the body is too large (JSON: 100 KB; backups: 200 MB) | |
| 502 | `machine_offline` | the machine's agent isn't connected (`can_force: true` on delete) | retry later, or check the machine |
| 502 | `agent_error` | the agent reported a failure (systemd, journalctl, …); the message has the details | read the message |
| 502 | `start_failed` | the service exited while starting; `logs` has its recent log lines | read `logs` |
| 504 | `agent_timeout` | the agent didn't answer in time | retry |
| 504 | `not_ready` | not ready before the timeout (left running); `logs` included | longer `timeout`, or read `logs` |
| 504 | `not_stopped` | didn't stop before the timeout | longer `timeout`, or a lower `TimeoutStopSec=` |
| 500 | `internal` | a bug in fleet | see `journalctl -u fleet-server` on the server |

Things that look like errors but aren't: starting a running service or stopping a stopped one (`200`,
`changed: false`), and a service whose machine is offline in `GET /api/services` (`200`; that service's `status`
is `{"error": "…", "code": "machine_offline"}`).

---

## 8. Logs, history and rollback

**Logs.** `GET /api/services/{name}/logs?lines=N` (1-5000, default 200) answers the service's journal as plain text
(`journalctl -u fleet-<name> -o short-iso`), oldest first. It works whether the service is running or not.

```js
// file: logs.js
'use strict';
// node logs.js <service> [lines]   or   node logs.js <service> --follow
const { get, enc } = require('./fleet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const [name, arg] = process.argv.slice(2);
  if (!name) throw new Error('usage: node logs.js <service> [lines | --follow]');
  const fetchLines = async (n) => (await get(`/api/services/${enc(name)}/logs?lines=${n}`)).split('\n').filter(Boolean);
  if (arg !== '--follow') { console.log((await fetchLines(Number(arg) || 50)).join('\n')); return; }
  // Follow: print what's new every 2 s (lines are matched by content, so identical repeated lines may be merged).
  let seen = await fetchLines(100);
  console.log(seen.join('\n'));
  for (;;) {
    await sleep(2000);
    const now = await fetchLines(200);
    const last = seen.at(-1), at = last === undefined ? -1 : now.lastIndexOf(last);
    const fresh = at >= 0 ? now.slice(at + 1) : now;
    if (fresh.length) console.log(fresh.join('\n'));
    seen = now;
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
```

**History.** Every create and save is a version. `GET /api/services/{name}/versions` lists them, newest first, each
with the full definition, `created_at`, and `rolled_back_from` (set when that version was made by a rollback).

**Rollback.** `POST /api/services/{name}/rollback` with `{"version": N}` saves version N's definition as a new
version. Like any save, a running service keeps its current definition until restarted.

```js
// file: history.js
'use strict';
// node history.js <service>              lists the versions and what changed in each
// node history.js <service> <version>    rolls back to that version, and restarts it if it is running
const { get, post, enc } = require('./fleet');

const FIELDS = ['name', 'machine', 'description', 'command', 'workdir', 'run_as', 'env', 'restart', 'properties', 'health_url'];

(async () => {
  const [name, version] = process.argv.slice(2);
  if (!name) throw new Error('usage: node history.js <service> [version]');
  if (!version) {
    const vs = await get(`/api/services/${enc(name)}/versions`);
    vs.forEach((v, i) => {
      const prev = vs[i + 1];
      const changed = prev ? FIELDS.filter((f) => JSON.stringify(v[f]) !== JSON.stringify(prev[f])) : ['(created)'];
      console.log(`v${v.version}  ${v.created_at}  ${v.rolled_back_from ? `rollback of v${v.rolled_back_from}  ` : ''}${changed.join(', ') || 'no changes'}`);
    });
    return;
  }
  const saved = await post(`/api/services/${enc(name)}/rollback`, { version: Number(version) });
  console.log(`saved v${version}'s definition as v${saved.version}`);
  const cur = await get(`/api/services/${enc(name)}`);
  if (cur.status.running) {
    await post(`/api/services/${enc(name)}/restart?wait=1&timeout=300`);
    console.log('restarted: it is running that definition now, and ready');
  }
})().catch((e) => { console.error(`${e.code ?? 'error'}: ${e.message}`); process.exit(1); });
```

---

## 9. Backup, restore and the API key

**Backup.** `GET /api/backup` answers the whole database (machines, services, their full history, settings
including the password hash and the API key) as one `.fleetbackup` file: gzip(database) followed by the SHA-256 of
the gzip bytes. It is safe to take while the server runs. Treat it like the API key: it contains it.

```js
// file: backup.js
'use strict';
// node backup.js [folder]: saves fleet-<UTC time>.fleetbackup there (default: the current folder)
const fs = require('node:fs');
const path = require('node:path');
const { get } = require('./fleet');

(async () => {
  const dir = process.argv[2] || '.';
  const data = await get('/api/backup');                         // a Buffer
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = path.join(dir, `fleet-${stamp}.fleetbackup`);
  fs.writeFileSync(file, data, { mode: 0o600 });                   // it contains the API key
  console.log(`${file} (${data.length} bytes)`);
})().catch((e) => { console.error(e.message); process.exit(1); });
```

**Restore.** `POST /api/restore` with the file's bytes as the body replaces all machines, services, history and
settings (including the password and the API key) with the backup's. Sessions are kept. Agents are disconnected and
reconnect within seconds; until they have, their machines are offline and calls for their services get
`502 machine_offline`, so a script that carries on after a restore should wait for them (as below). Running services aren't touched: a service the backup doesn't have keeps running on its
machine, unmanaged. A changed or damaged file is refused (`400 bad_backup`) and nothing changes. Backups from older
fleet versions are upgraded as they are restored.

```js
// file: restore.js
'use strict';
// node restore.js <file.fleetbackup>
// After a restore every agent reconnects (to be identified against the restored machines), so for a few seconds
// the machines are offline; this waits until all approved machines are back before returning.
const fs = require('node:fs');
const { api, get } = require('./fleet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const file = process.argv[2];
  if (!file) throw new Error('usage: node restore.js <file.fleetbackup>');
  const r = await api('POST', '/api/restore', { body: fs.readFileSync(file) });
  console.log(`restored ${r.machines} machines and ${r.services} services`);
  // The API key is now the one in the backup: if it differs from FLEET_API_KEY, the calls below get 401.
  const deadline = Date.now() + 60000;
  for (;;) {
    const offline = (await get('/api/machines')).filter((m) => m.status === 'approved' && !m.online).map((m) => m.name);
    if (!offline.length) { console.log('all machines are back online'); break; }
    if (Date.now() > deadline) { console.log(`still offline after 60 s: ${offline.join(', ')}`); process.exitCode = 1; break; }
    await sleep(1000);
  }
})().catch((e) => { console.error(`${e.code ?? 'error'}: ${e.message}`); process.exit(1); });
```

**The API key.** `GET /api/api-key` answers `{"key": "…"}`. `POST /api/api-key/reroll` makes a new one and answers
it; the old key stops working at once, for every script that uses it (including the one that called reroll).

---

## 10. Public files

Files in the server's public folder (`/opt/fleet-control/files/` by default) are served at `/files/` to anyone, with
no key, over HTTPS and plain HTTP. Folders answer an HTML index. This is handy for handing the same file to every
machine:

```sh
curl -fsS http://192.0.2.10/files/tools/setup.sh -o setup.sh
```

From Node, plain `fetch` is fine here (no key, and plain HTTP needs no certificate):

```js
// file: public-file.js
'use strict';
// node public-file.js <path under /files/>   e.g. tools/setup.sh
(async () => {
  const p = process.argv[2];
  if (!p) throw new Error('usage: node public-file.js <path under /files/>');
  const url = new URL(`/files/${p}`, process.env.FLEET_URL.replace(/^https:/, 'http:').replace(/:\d+$/, ''));
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  process.stdout.write(Buffer.from(await res.arrayBuffer()));
})().catch((e) => { console.error(e.message); process.exit(1); });
```

---

## 11. Shell (curl)

For shell scripts, `curl` with `--cacert` (never `-k`) and `jq` cover most needs. `-f` makes curl fail on HTTP
errors; `--fail-with-body` (curl 7.76+) does too but still prints the JSON error.

```sh
# Settings, as in section 1
F="$FLEET_URL/api"; H="Authorization: Bearer $FLEET_API_KEY"; C="--cacert $FLEET_CA"

# Machines and services at a glance
curl -sS $C -H "$H" "$F/machines" | jq -r '.[] | "\(.name)\t\(.status)\t\(if .online then "online" else "offline" end)"'
curl -sS $C -H "$H" "$F/services" | jq -r '.[] | "\(.machine)\t\(.name)\t\(.status.ready // false)"'

# Start and wait until ready; on failure print the code, the message and the log lines
curl -sS $C -H "$H" -X POST --fail-with-body "$F/services/demo-web/start?wait=1&timeout=300" \
  | jq -r '"\(.name): ready=\(.status.ready) changed=\(.changed)"' \
  || echo "start failed"

# The same, with the HTTP status separate from the body (no jq needed for the status)
code=$(curl -sS $C -H "$H" -X POST -o /tmp/fleet.json -w '%{http_code}' "$F/services/demo-web/start?wait=1")
if [ "$code" != 200 ]; then jq -r '"\(.code): \(.error)\n\(.logs // "")"' /tmp/fleet.json; exit 1; fi

# Stop and wait until it is really gone
curl -sS $C -H "$H" -X POST --fail-with-body "$F/services/demo-web/stop?wait=1" >/dev/null

# Change one field (a new version), then restart and wait
curl -sS $C -H "$H" -X PUT -H 'Content-Type: application/json' -d '{"env":{"GREETING":"hi"}}' "$F/services/demo-web" | jq .version
curl -sS $C -H "$H" -X POST --fail-with-body "$F/services/demo-web/restart?wait=1" >/dev/null

# Last 50 log lines
curl -sS $C -H "$H" "$F/services/demo-web/logs?lines=50"

# Backup to a file (it contains the API key: keep it private) and restore it
curl -sS $C -H "$H" --fail "$F/backup" -o fleet.fleetbackup && chmod 600 fleet.fleetbackup
curl -sS $C -H "$H" --fail-with-body -X POST --data-binary @fleet.fleetbackup "$F/restore"
```

Without `jq`, `node -p` reads JSON just as well:
`curl -sS $C -H "$H" "$F/services/demo-web" | node -p 'JSON.parse(require("fs").readFileSync(0)).status.ready'`.

---

## 12. Reference: objects and behaviour

### Machine

`GET /api/machines` → an array, in display order:

| Field | |
|---|---|
| `name` | its hostname (`<hostname>-2` if another machine has it) |
| `address` | the IP its agent connects from |
| `status` | `pending` (new, waiting for approval), `approved`, `rejected` |
| `online` | its agent is connected now |
| `stats` | only for approved, online machines: `uptime_sec`, `cpu_pct`, `cpus`, `load` (1/5/15 min), `mem_total_kb`, `mem_avail_kb`, `swap_total_kb`, `swap_free_kb`, `disk_total_kb`, `disk_used_kb` (of `/`), `gpus`: `[{name, util_pct, vram_used_mb, vram_total_mb, temp_c, power_w}]` (NVIDIA and AMD; `temp_c` / `power_w` may be `null`) |

### Service

| Field | |
|---|---|
| `name`, `machine` | its name (unit `fleet-<name>.service`) and its machine's name |
| `command`, `run_as`, `description`, `workdir`, `env`, `restart`, `properties`, `health_url` | the definition (section 4) |
| `id`, `machine_id` | internal ids |
| `version` | the current version number |
| `unit` | `fleet-<name>.service` |
| `created_at`, `updated_at` | ISO times (UTC) |
| `status` | live, below (absent when only the definition is returned, e.g. by `POST`/`PUT`) |
| `busy` | `"starting"` / `"stopping"` / `"restarting"` while a request is doing that, else `null` |
| `last_error` | `{message, at}` of the last failed start (with wait) or restart, until the next action; else `null` |
| `changed` | only in answers to start / stop / restart |

### Status

| Field | |
|---|---|
| `active`, `sub` | systemd's ActiveState / SubState (`active`/`running`, `inactive`/`dead`, `failed`/`failed`, `activating`/`auto-restart`, `deactivating`/`stop-sigterm`, …) |
| `running` | `active` is active, activating, reloading or deactivating |
| `ready` | running and (no `health_url`, or it answers) |
| `pid`, `since` | main process id and start time (ISO, UTC), while running |
| `exit_status` | the last exit status (meaningful after it stopped or failed) |
| `health` | only for a running service with a `health_url`: `{ok: true, status: 200}` or `{ok: false, status: 503}` or `{ok: false, error: "ECONNREFUSED"}` |
| `error`, `code` | instead of all the above when the machine can't be reached |

### Behaviour worth knowing

- **Nothing starts at boot.** Service units live in `/run`, which is emptied at every boot. After a machine
  reboots, its services are stopped until something starts them (see the after-reboot recipe).
- **Definitions vs. running processes.** Saving, renaming (when stopped) and rolling back change the definition;
  a running process keeps the definition it was started with until it is restarted.
- **Time limits.** Agent calls time out after 30 s (`agent_timeout`), except stopping and starting, which allow up
  to 10 minutes (a start may first stop a `Conflicts=` service). `?wait=1` waits up to `timeout` (default 120 s,
  at most 1800 s). JSON bodies: at most 100 KB.
- **Order of operations is per service.** Requests for one service run one at a time; different services run
  concurrently, so a script can start services on several machines in parallel (`Promise.all`).
- **Status costs a round trip.** Every `GET /api/services` asks each machine's agent (and checks health URLs of
  running services). Polling every few seconds is fine; tight loops aren't needed: use `?wait=1`.
- **The key is all-powerful.** Anyone with it can run any command as root on every approved machine.
