'use strict';
// Live end-to-end test (run by test/live/run.sh): a real fleet-server and real agents in systemd containers.
// Every action goes through the REST API; its effect is checked inside the containers with `docker exec`.
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { request, until, sleep } = require('../helpers');

const BASE = process.env.FLEET_LIVE_SERVER;
const [M1, M2, M3] = (process.env.FLEET_LIVE_MACHINES || '').split(' ');
if (!BASE || !M3) throw new Error('run this through test/live/run.sh');

// Run a shell command in a container; returns stdout (trimmed). ok: false returns null instead of throwing.
function dx(machine, cmd, { ok = true } = {}) {
  try { return execFileSync('docker', ['exec', `fleet-live-${machine}`, 'bash', '-c', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch (e) { if (ok) throw new Error(`${machine}: ${cmd}: ${e.stderr || e.message}`); return null; }
}
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

let auth;
const api = (method, p, body) => request(BASE, method, p, { body, headers: auth });
const ok = async (method, p, body, want = 200) => {
  const r = await api(method, p, body);
  assert.equal(r.status, want, `${method} ${p}: ${r.status} ${r.text}`);
  return r.json ?? r.text;
};
const svc = (name) => ok('GET', `/api/services/${name}`);
const running = (name) => until(async () => { const s = (await svc(name)).status; return s.running && s.active === 'active' && s.pid && s; }, { timeoutMs: 15000, what: `${name} running` });
const stopped = (name) => until(async () => { const s = (await svc(name)).status; return !s.running && s; }, { timeoutMs: 30000, what: `${name} stopped` });
const online = (m, want = true) => until(async () => (await ok('GET', '/api/machines')).find((x) => x.name === m)?.online === want, { timeoutMs: 60000, what: `${m} online=${want}` });
const create = (body) => ok('POST', '/api/services', { run_as: 'tester', machine: M1, ...body }, 201);

describe('live: real server, real agents, real systemd', () => {
  before(async () => {
    // A fresh server: the first sign-in sets the password; then use the API key from here on.
    const r = await request(BASE, 'POST', '/login', { body: { password: 'live-test' } });
    assert.equal(r.status, 200, r.text);
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const key = (await request(BASE, 'GET', '/api/api-key', { headers: { Cookie: cookie } })).json.key;
    auth = { Authorization: `Bearer ${key}` };
  });

  it('all three machines enrolled pending; approving them brings stats', async () => {
    const ms = await ok('GET', '/api/machines');
    assert.deepEqual(ms.map((m) => [m.name, m.status, m.online]).sort(), [[M1, 'pending', true], [M2, 'pending', true], [M3, 'pending', true]]);
    for (const m of [M1, M2, M3]) await ok('POST', `/api/machines/${m}/approve`);
    const withStats = await until(async () => { const l = await ok('GET', '/api/machines'); return l.every((m) => m.stats?.mem_total_kb > 0) && l; }, { what: 'stats' });
    for (const m of withStats) { assert.ok(m.stats.cpus > 0); assert.ok(m.stats.disk_total_kb > 0); assert.deepEqual(m.stats.gpus ?? [], []); }
  });

  it('a service runs as its user, in its folder, with its environment, and actually serves', async () => {
    dx(M1, 'mkdir -p /srv/www && echo "hello from fleet" > /srv/www/index.html && chown -R tester /srv/www');
    await create({ name: 'web', workdir: '/srv/www', env: { GREETING: 'hi there', TRICKY: `quotes "' $HOME \`x\`` },
      command: 'exec python3 -m http.server 8000 --bind 127.0.0.1', description: 'static site' });
    await ok('POST', '/api/services/web/start');
    const st = await running('web');
    await until(() => dx(M1, 'curl -s 127.0.0.1:8000/', { ok: false }) === 'hello from fleet', { timeoutMs: 10000, what: 'http answer' });
    assert.equal(dx(M1, `ps -o user= -p ${st.pid}`), 'tester');
    assert.equal(dx(M1, `readlink /proc/${st.pid}/cwd`), '/srv/www');
    const env = dx(M1, `tr '\\0' '\\n' < /proc/${st.pid}/environ`).split('\n');
    assert.ok(env.includes('GREETING=hi there'));
    assert.ok(env.includes(`TRICKY=quotes "' $HOME \`x\``), 'env values are passed literally');
    assert.equal(dx(M1, 'systemctl show -p Description --value fleet-web.service'), 'fleet: static site');
    assert.equal(dx(M1, 'systemctl show -p TimeoutStopUSec --value fleet-web.service'), '15s');
  });

  it('shell commands work as written (pipes, quotes, redirects); logs show the output', async () => {
    await create({ name: 'shell', command: `for i in 1 2 3; do echo "line $i"; done; echo "a b" | tr a-z A-Z > /tmp/out-$USER; echo 'done: "quoted"'; exec sleep infinity` });
    await ok('POST', '/api/services/shell/start');
    await running('shell');
    await until(() => dx(M1, 'cat /tmp/out-tester', { ok: false }) === 'A B', { what: 'pipe output' });
    const logs = await until(async () => { const t = await ok('GET', '/api/services/shell/logs?lines=50'); return t.includes('done: "quoted"') && t; }, { what: 'logs' });
    assert.match(logs, /line 3/);
    const few = await ok('GET', '/api/services/shell/logs?lines=2');
    assert.ok(few.trim().split('\n').length <= 2);
  });

  it('restart=always: a killed process comes back by itself', async () => {
    await create({ name: 'phoenix', command: 'exec sleep infinity', restart: 'always' });
    await ok('POST', '/api/services/phoenix/start');
    const { pid } = await running('phoenix');
    dx(M1, `kill -9 ${pid}`);
    const again = await until(async () => { const s = (await svc('phoenix')).status; return s.running && s.pid && s.pid !== pid && s; }, { timeoutMs: 15000, what: 'new pid' });
    assert.ok(again.pid > 0);
  });

  it('restart=no: a crashed process stays down and shows its exit status', async () => {
    await create({ name: 'crash', command: 'sleep 1; exit 3' });
    await ok('POST', '/api/services/crash/start');
    const s = await stopped('crash');
    assert.equal(s.active, 'failed'); assert.equal(s.exit_status, 3);
    await ok('POST', '/api/services/crash/start', undefined, 200); // a failed unit can be started again
  });

  it('edits apply on restart; the running one keeps its old definition until then', async () => {
    await ok('PUT', '/api/services/web', { env: { GREETING: 'changed' } });
    const before = (await svc('web')).status.pid;
    assert.ok(dx(M1, `tr '\\0' '\\n' < /proc/${before}/environ`).includes('GREETING=hi there'));
    await ok('POST', '/api/services/web/restart');
    await until(async () => { const s = await svc('web'); return !s.restarting && s.status.running && s.status.pid !== before; }, { timeoutMs: 30000, what: 'restart' });
    const pid = (await svc('web')).status.pid;
    assert.ok(dx(M1, `tr '\\0' '\\n' < /proc/${pid}/environ`).includes('GREETING=changed'));
  });

  it('stop really stops it; a process ignoring SIGTERM is killed after TimeoutStopSec', async () => {
    const { pid } = (await svc('web')).status;
    await ok('POST', '/api/services/web/stop');
    await stopped('web');
    assert.equal(dx(M1, `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`), 'gone');
    assert.equal(dx(M1, 'curl -s -o /dev/null -w "%{http_code}" 127.0.0.1:8000/ || true'), '000');

    await create({ name: 'stubborn', command: `trap '' TERM; while :; do sleep 0.2; done`, properties: ['TimeoutStopSec=3'] });
    await ok('POST', '/api/services/stubborn/start');
    await running('stubborn');
    const t0 = Date.now();
    await ok('POST', '/api/services/stubborn/stop');
    assert.ok(Date.now() - t0 < 2000, 'stop answers at once');
    const s = await stopped('stubborn');
    const took = Date.now() - t0;
    assert.ok(took >= 2500 && took < 15000, `killed after the timeout (${took} ms)`);
    assert.notEqual(s.active, 'active');
  });

  it('Conflicts= stops the other service', async () => {
    await create({ name: 'gpu-a', command: 'exec sleep infinity' });
    await create({ name: 'gpu-b', command: 'exec sleep infinity', properties: ['Conflicts=fleet-gpu-a.service'] });
    await ok('POST', '/api/services/gpu-a/start');
    await running('gpu-a');
    await ok('POST', '/api/services/gpu-b/start');
    await running('gpu-b');
    await stopped('gpu-a');
  });

  it('run_as root works; extra properties reach systemd', async () => {
    await create({ name: 'rooty', run_as: 'root', command: 'id -u > /tmp/rooty; exec sleep infinity', properties: ['MemoryMax=64M', 'Nice=5'] });
    await ok('POST', '/api/services/rooty/start');
    await running('rooty');
    await until(() => dx(M1, 'cat /tmp/rooty', { ok: false }) === '0', { what: 'root id' });
    assert.equal(dx(M1, 'systemctl show -p MemoryMax --value fleet-rooty.service'), String(64 * 1024 * 1024));
    assert.equal(dx(M1, 'systemctl show -p Nice --value fleet-rooty.service'), '5');
  });

  it('rename and move (stopped): it then runs on the new machine only', async () => {
    await ok('PUT', '/api/services/web', { name: 'site', machine: M2 }, 200);
    dx(M2, 'mkdir -p /srv/www && echo "now on m2" > /srv/www/index.html');
    await ok('POST', '/api/services/site/start');
    await running('site');
    await until(() => dx(M2, 'curl -s 127.0.0.1:8000/', { ok: false }) === 'now on m2', { timeoutMs: 10000, what: 'm2 http' });
    assert.equal(dx(M1, 'systemctl is-active fleet-site.service', { ok: false }), null, 'not on m1');
    assert.equal((await ok('GET', '/api/services/site/versions')).length, 3);
  });

  it('delete stops it and removes the unit', async () => {
    await ok('DELETE', '/api/services/rooty');
    await until(() => dx(M1, 'systemctl is-active fleet-rooty.service', { ok: false }) === null, { timeoutMs: 20000, what: 'unit gone' });
    assert.equal((await api('GET', '/api/services/rooty')).status, 404);
  });

  it('many services on one machine: one status call, all correct', async () => {
    for (let i = 0; i < 12; i++) await create({ name: `bulk-${i}`, command: 'exec sleep infinity' });
    for (let i = 0; i < 12; i += 2) await ok('POST', `/api/services/bulk-${i}/start`);
    const list = await until(async () => { const l = (await ok('GET', '/api/services')).filter((s) => s.name.startsWith('bulk-')); return l.filter((s) => s.status.running).length === 6 && l; }, { what: 'bulk' });
    for (const s of list) assert.equal(s.status.running, Number(s.name.split('-')[1]) % 2 === 0, s.name);
    for (let i = 0; i < 12; i++) await ok('DELETE', `/api/services/bulk-${i}`);
  });

  it('a machine going down: offline, 502s, force delete; after it boots its agent is back and services are stopped', async () => {
    await create({ name: 'on-m3', machine: M3, command: 'exec sleep infinity' });
    await create({ name: 'on-m3-b', machine: M3, command: 'exec sleep infinity' });
    await ok('POST', '/api/services/on-m3/start');
    await running('on-m3');
    docker('stop', `fleet-live-${M3}`);
    await online(M3, false);
    assert.match((await svc('on-m3')).status.error, /agent not connected/);
    assert.equal((await api('POST', '/api/services/on-m3/start')).status, 502);
    const del = await api('DELETE', '/api/services/on-m3-b');
    assert.equal(del.status, 502); assert.equal(del.json.can_force, true);
    await ok('DELETE', '/api/services/on-m3-b?force=1');
    docker('start', `fleet-live-${M3}`);
    await online(M3, true);
    const s = (await svc('on-m3')).status;
    assert.equal(s.running, false, 'transient services do not come back after a reboot');
    await ok('POST', '/api/services/on-m3/start');
    await running('on-m3');
  });

  it('the server restarting: every agent reconnects by itself', async () => {
    dx('server', 'systemctl restart fleet-server');
    await until(async () => (await request(BASE, 'GET', '/health').catch(() => null))?.status === 200, { timeoutMs: 30000, what: 'server back' });
    for (const m of [M1, M2, M3]) await online(m, true);
    assert.equal((await svc('site')).status.running, true, 'services kept running meanwhile');
  });

  it('backup and restore, live', async () => {
    const backup = (await api('GET', '/api/backup')).buf;
    await create({ name: 'ephemeral', command: 'exec sleep infinity' });
    const r = await request(BASE, 'POST', '/api/restore', { body: backup, headers: { ...auth, 'Content-Type': 'application/octet-stream' } });
    assert.equal(r.status, 200, r.text);
    assert.equal((await api('GET', '/api/services/ephemeral')).status, 404);
    for (const m of [M1, M2, M3]) await online(m, true);
    assert.equal((await svc('site')).status.running, true);
  });

  it('the agents are pinned: a server with a new certificate is refused until they are re-installed', async () => {
    dx('server', 'cd /opt/fleet-control && rm data/tls.crt data/tls.key && systemctl restart fleet-server');
    await until(async () => (await request(BASE, 'GET', '/health').catch(() => null))?.status === 200, { timeoutMs: 30000, what: 'server back' });
    await sleep(8000);
    assert.equal((await ok('GET', '/api/machines')).find((m) => m.name === M1).online, false, 'pinned agent refuses the new cert');
    assert.match(dx(M1, 'journalctl -u fleet-agent -n 20 --no-pager'), /different certificate/);
    const ip = new URL(BASE).hostname;
    // A plain re-install is refused too (same pin) ...
    assert.equal(dx(M1, `node /usr/local/lib/fleet-agent/fleet-agent.js --install --server ${ip} >/dev/null 2>&1 && echo ok || echo refused`), 'refused');
    // ... until the pin is deleted on purpose.
    dx(M1, `rm /etc/fleet-agent/server && node /usr/local/lib/fleet-agent/fleet-agent.js --install --server ${ip}`);
    await online(M1, true);
    assert.equal((await ok('GET', '/api/machines')).find((m) => m.name === M1).status, 'approved', 'same key, same machine');
  });
});
