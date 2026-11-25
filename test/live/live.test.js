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

  it('the command and environment reach bash byte for byte (quotes, $, %, backslashes, newlines, tabs, unicode)', async () => {
    const command = 'printf "%s" "$BASH_EXECUTION_STRING" > /tmp/cmd-$USER; printf "%s" "$ODD" > /tmp/env-$USER\n# a second line: \'single\' "double" \\back\\slash\t$HOME ${PATH%%:*} 100% `true` — ünïcödé\nexec sleep infinity';
    const odd = `a "b" 'c' \\d $HOME %p \`e\` — ü`;
    await create({ name: 'exact', command, env: { ODD: odd } });
    await ok('POST', '/api/services/exact/start?wait=1');
    await until(() => dx(M1, 'test -s /tmp/env-tester && echo y', { ok: false }) === 'y', { what: 'files' });
    assert.equal(execFileSync('docker', ['exec', `fleet-live-${M1}`, 'cat', '/tmp/cmd-tester'], { encoding: 'utf8' }), command);
    assert.equal(execFileSync('docker', ['exec', `fleet-live-${M1}`, 'cat', '/tmp/env-tester'], { encoding: 'utf8' }), odd);
    assert.equal(dx(M1, 'systemctl show -p FragmentPath --value fleet-exact.service'), '/run/systemd/system/fleet-exact.service');
    await ok('DELETE', '/api/services/exact');
    await until(() => dx(M1, 'test -e /run/systemd/system/fleet-exact.service && echo yes || echo no') === 'no', { what: 'unit file removed' });
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
    await until(async () => { const s = await svc('web'); return !s.busy && s.status.running && s.status.pid !== before; }, { timeoutMs: 30000, what: 'restart' });
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

  it('health URL + start?wait=1: answers only once the real server answers (it starts listening after 3 s)', async () => {
    dx(M1, 'mkdir -p /srv/slow && echo ok > /srv/slow/health && chown -R tester /srv/slow');
    await create({ name: 'slow', workdir: '/srv/slow', command: 'sleep 3; exec python3 -m http.server 8100 --bind 127.0.0.1',
      health_url: 'http://127.0.0.1:8100/health' });
    const t0 = Date.now();
    const r = await api('POST', '/api/services/slow/start?wait=1&timeout=30');
    const took = Date.now() - t0;
    assert.equal(r.status, 200, r.text);
    assert.ok(took >= 3000 && took < 15000, `took ${took} ms`);
    assert.equal(r.json.changed, true); assert.equal(r.json.status.ready, true); assert.deepEqual(r.json.status.health, { ok: true, status: 200 });
    assert.equal(dx(M1, 'curl -s 127.0.0.1:8100/health'), 'ok', 'it really answers');
    // Again: nothing to do.
    const again = await api('POST', '/api/services/slow/start?wait=1');
    assert.equal(again.json.changed, false);
  });

  it('health URL that stops answering: running but not ready, with the reason', async () => {
    dx(M1, 'rm /srv/slow/health');
    const s = await until(async () => { const st = (await svc('slow')).status; return st.ready === false && st; }, { what: 'not ready' });
    assert.equal(s.running, true); assert.deepEqual(s.health, { ok: false, status: 404 });
    dx(M1, 'echo ok > /srv/slow/health');
    await until(async () => (await svc('slow')).status.ready, { what: 'ready again' });
  });

  it('a real crash while starting: 502 start_failed with the exit status and the real log lines', async () => {
    await create({ name: 'broken', command: 'echo "missing config file" >&2; exit 4', health_url: 'http://127.0.0.1:8101/' });
    const r = await api('POST', '/api/services/broken/start?wait=1&timeout=30');
    assert.equal(r.status, 502, r.text); assert.equal(r.json.code, 'start_failed');
    assert.match(r.json.error, /exit status 4/); assert.match(r.json.logs, /missing config file/);
  });

  it('restart=always crash loop while waiting: start_failed (not a 30 s wait)', async () => {
    await create({ name: 'looper', command: 'exit 1', restart: 'always', health_url: 'http://127.0.0.1:8102/' });
    const t0 = Date.now();
    const r = await api('POST', '/api/services/looper/start?wait=1&timeout=30');
    assert.equal(r.status, 502, r.text); assert.equal(r.json.code, 'start_failed'); assert.match(r.json.error, /restarting it/);
    assert.ok(Date.now() - t0 < 10000);
    await ok('POST', '/api/services/looper/stop?wait=1');
  });

  it('not ready by the timeout: 504 not_ready; it is left running', async () => {
    await create({ name: 'never', command: 'exec sleep infinity', health_url: 'http://127.0.0.1:8103/' });
    const r = await api('POST', '/api/services/never/start?wait=1&timeout=3');
    assert.equal(r.status, 504); assert.equal(r.json.code, 'not_ready'); assert.match(r.json.error, /ECONNREFUSED/);
    assert.equal((await svc('never')).status.running, true);
    await ok('POST', '/api/services/never/stop?wait=1');
  });

  it('stop?wait=1 answers once the process is really gone (after its 3 s TimeoutStopSec)', async () => {
    await ok('POST', '/api/services/stubborn/start?wait=1');
    const { pid } = (await svc('stubborn')).status;
    const t0 = Date.now();
    const r = await ok('POST', '/api/services/stubborn/stop?wait=1');
    const took = Date.now() - t0;
    assert.ok(took >= 2500, `took ${took} ms`); assert.equal(r.changed, true); assert.equal(r.status.running, false);
    assert.equal(dx(M1, `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`), 'gone');
  });

  it('restart?wait=1 of a slow service: answers when the new process is ready', async () => {
    const before = (await svc('slow')).status.pid;
    const t0 = Date.now();
    const r = await ok('POST', '/api/services/slow/restart?wait=1&timeout=30');
    assert.ok(Date.now() - t0 >= 3000); assert.equal(r.status.ready, true); assert.notEqual(r.status.pid, before); assert.equal(r.busy, null);
  });

  it('switching a GPU-style pair with Conflicts= and wait: one call, the other one is stopped, the new one ready', async () => {
    await ok('PUT', '/api/services/gpu-a', { health_url: 'http://127.0.0.1:8104/', command: 'cd /tmp && exec python3 -m http.server 8104 --bind 127.0.0.1', properties: ['Conflicts=fleet-gpu-b.service'] });
    await ok('POST', '/api/services/gpu-b/start?wait=1');
    await ok('PUT', '/api/services/gpu-b', { properties: ['Conflicts=fleet-gpu-a.service'] });
    // Back and forth, several times: each start stops the other (both directions refer to each other).
    for (const [on, off] of [['gpu-a', 'gpu-b'], ['gpu-b', 'gpu-a'], ['gpu-a', 'gpu-b'], ['gpu-b', 'gpu-a'], ['gpu-a', 'gpu-b']]) {
      const r = await ok('POST', `/api/services/${on}/start?wait=1&timeout=30`);
      assert.equal(r.changed, true, on); assert.equal(r.status.ready, true, on);
      assert.equal((await svc(off)).status.running, false, `${off} stopped by starting ${on}`);
    }
  });

  it('simultaneous starts against real systemd: one start, the rest changed: false, no errors', async () => {
    await create({ name: 'race', command: 'exec sleep infinity' });
    const rs = await Promise.all([1, 2, 3, 4, 5].map(() => api('POST', '/api/services/race/start')));
    assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200], rs.map((r) => r.text).join('\n'));
    assert.equal(rs.filter((r) => r.json.changed).length, 1);
    await ok('DELETE', '/api/services/race');
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

  it('the server is sandboxed: low exposure, no /home, read-only code, writable data; public files still served', async () => {
    const score = Number(dx('server', "systemd-analyze security fleet-server.service --no-pager | tail -1 | grep -oE '[0-9]+\\.[0-9]+'"));
    assert.ok(score > 0 && score <= 3, `exposure ${score}`);
    const pid = dx('server', 'systemctl show -p MainPID --value fleet-server.service');
    assert.ok(Number(pid) > 0);
    // Its own view of the filesystem, through /proc/<pid>/root.
    assert.equal(dx('server', 'ls -A /home | wc -l') !== '0', true, 'the container has a /home/tester');
    assert.equal(dx('server', `ls -A /proc/${pid}/root/home | wc -l`), '0', '/home is empty for the server');
    assert.equal(dx('server', `touch /proc/${pid}/root/opt/fleet-control/x 2>/dev/null && echo writable || echo read-only`), 'read-only');
    assert.equal(dx('server', `touch /proc/${pid}/root/etc/x 2>/dev/null && echo writable || echo read-only`), 'read-only');
    assert.equal(dx('server', `touch /proc/${pid}/root/opt/fleet-control/data/x && rm /proc/${pid}/root/opt/fleet-control/data/x && echo writable`), 'writable');
    dx('server', 'echo sandboxed-but-public > /opt/fleet-control/files/hello.txt');
    assert.equal((await request(BASE, 'GET', '/files/hello.txt')).text.trim(), 'sandboxed-but-public');
    assert.equal(dx('server', 'journalctl -u fleet-server --no-pager | grep -ciE "permission denied|EPERM|EACCES" || true'), '0', 'no denied access in its log');
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
