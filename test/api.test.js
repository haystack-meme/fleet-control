'use strict';
// The REST API, end to end: a real fleet-server (temporary folder, free ports) over HTTPS, with scripted agents
// (test/helpers.js) standing in for machines. Run: npm test
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startServer, client, login, FakeAgent, until, sleep } = require('./helpers');

const PW = 'correct horse';
const svcBody = (over = {}) => ({ name: 'web', machine: 'box', command: 'python3 -m http.server 8000', run_as: 'alice', ...over });

describe('REST API', () => {
  let srv, api, agent;
  const agents = [];
  const newAgent = async (hostname, opts) => { const a = new FakeAgent(srv, hostname, opts); agents.push(a); await a.enroll(); await a.connect(); return a; };
  const status = async (name) => (await api.get(`/api/services/${name}`)).json.status;

  before(async () => {
    srv = await startServer();
    api = client(srv, { cookie: await login(srv, PW) });
    agent = await newAgent('box');
    assert.equal((await api.post('/api/machines/box/approve')).status, 200);
  });
  after(async () => { agents.forEach((a) => a.close()); await srv?.stop(); });

  // ---------------------------------------------------------------------------------------------------------------
  describe('public endpoints', () => {
    it('GET /health', async () => assert.deepEqual((await srv.req('GET', '/health')).json, { ok: true }));
    it('GET /install/fleet-agent.js and the unit template', async () => {
      const js = await srv.req('GET', '/install/fleet-agent.js');
      assert.equal(js.status, 200); assert.match(js.headers['content-type'], /javascript/); assert.match(js.text, /fleet-agent/);
      const unit = await srv.req('GET', '/install/fleet-agent.service');
      assert.equal(unit.status, 200); assert.match(unit.text, /@SERVER@/);
    });
    it('POST /enroll gives a 64-hex code valid 60 s', async () => {
      const r = await srv.req('POST', '/enroll');
      assert.equal(r.status, 200); assert.match(r.json.code, /^[0-9a-f]{64}$/); assert.equal(r.json.expires_in_sec, 60);
    });
    it('GET /login/status', async () => assert.deepEqual((await srv.req('GET', '/login/status')).json, { password_set: true }));
    it('GET / without a session redirects to /login', async () => {
      const r = await srv.req('GET', '/'); assert.equal(r.status, 302); assert.equal(r.headers.location, '/login');
    });
    it('unknown paths are 404 JSON', async () => {
      const r = await srv.req('GET', '/nope'); assert.equal(r.status, 404); assert.equal(r.json.error, 'not found');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('authentication', () => {
    const PROTECTED = [['GET', '/api/machines'], ['POST', '/api/machines/box/approve'], ['POST', '/api/machines/box/reject'],
      ['DELETE', '/api/machines/box'], ['GET', '/api/services'], ['POST', '/api/services'], ['GET', '/api/services/x'],
      ['PUT', '/api/services/x'], ['DELETE', '/api/services/x'], ['POST', '/api/services/x/start'], ['POST', '/api/services/x/stop'],
      ['POST', '/api/services/x/restart'], ['GET', '/api/services/x/logs'], ['GET', '/api/services/x/versions'],
      ['POST', '/api/services/x/rollback'], ['GET', '/api/api-key'], ['POST', '/api/api-key/reroll'], ['POST', '/api/password'],
      ['GET', '/api/backup'], ['POST', '/api/restore'], ['GET', '/api/config'], ['GET', '/api/anything']];
    it('every /api route refuses requests without a session or key (401)', async () => {
      for (const [m, p] of PROTECTED) {
        const r = await srv.req(m, p, m === 'GET' || m === 'DELETE' ? {} : { body: {} });
        assert.equal(r.status, 401, `${m} ${p}`);
      }
    });
    it('refuses a wrong key, a wrong cookie and a malformed Authorization header', async () => {
      for (const auth of [{ key: 'f'.repeat(64) }, { xKey: 'nope' }, { cookie: `fleet_sid=${'a'.repeat(64)}` }])
        assert.equal((await client(srv, auth).get('/api/machines')).status, 401, JSON.stringify(auth));
      assert.equal((await srv.req('GET', '/api/machines', { headers: { Authorization: 'Basic abc' } })).status, 401);
    });
    it('the API key works as Bearer and as X-API-Key', async () => {
      const { key } = (await api.get('/api/api-key')).json;
      assert.match(key, /^[0-9a-f]{64}$/);
      assert.equal((await client(srv, { key }).get('/api/machines')).status, 200);
      assert.equal((await client(srv, { xKey: key }).get('/api/machines')).status, 200);
      assert.equal((await srv.req('GET', '/api/machines', { headers: { Authorization: `bearer ${key}` } })).status, 200, 'scheme is case-insensitive');
    });
    it('rerolling the key kills the old one at once (and works when called with the key itself)', async () => {
      const old = (await api.get('/api/api-key')).json.key;
      const r = await client(srv, { key: old }).post('/api/api-key/reroll');
      assert.equal(r.status, 200); assert.notEqual(r.json.key, old);
      assert.equal((await client(srv, { key: old }).get('/api/machines')).status, 401);
      assert.equal((await client(srv, { key: r.json.key }).get('/api/machines')).status, 200);
      assert.equal((await api.get('/api/api-key')).json.key, r.json.key);
    });
    it('a wrong password is refused; the session cookie is HttpOnly, Secure, SameSite=Strict', async () => {
      assert.equal((await srv.req('POST', '/login', { body: { password: 'wrong' } })).status, 401);
      assert.equal((await srv.req('POST', '/login', { body: {} })).status, 401);
      const r = await srv.req('POST', '/login', { body: { password: PW } });
      assert.match(r.headers['set-cookie'][0], /fleet_sid=[0-9a-f]{64}; Path=\/; HttpOnly; Secure; SameSite=Strict/);
    });
    it('logout ends that session only', async () => {
      const a = client(srv, { cookie: await login(srv, PW) }), b = client(srv, { cookie: await login(srv, PW) });
      assert.equal((await a.post('/logout')).status, 200);
      assert.equal((await a.get('/api/machines')).status, 401);
      assert.equal((await b.get('/api/machines')).status, 200);
    });
    it('password change: needs the current one, keeps this session, signs out the others', async () => {
      const me = client(srv, { cookie: await login(srv, PW) }), other = client(srv, { cookie: await login(srv, PW) });
      assert.equal((await me.post('/api/password', { current: 'wrong', password: 'x' })).status, 403);
      assert.equal((await me.post('/api/password', { current: PW, password: '' })).status, 400);
      assert.equal((await me.post('/api/password', { current: PW, password: 'new pw' })).status, 200);
      assert.equal((await me.get('/api/machines')).status, 200);
      assert.equal((await other.get('/api/machines')).status, 401);
      assert.equal((await srv.req('POST', '/login', { body: { password: PW } })).status, 401);
      assert.equal((await me.post('/api/password', { current: 'new pw', password: PW })).status, 200);
      api = client(srv, { cookie: await login(srv, PW) }); // the original session was one of the "others"
    });
    it('a bad JSON body is a 400, not a crash', async () => {
      const r = await api.req('POST', '/api/services', { body: '{not json', headers: { 'Content-Type': 'application/json' } });
      assert.equal(r.status, 400);
      assert.equal((await srv.req('GET', '/health')).status, 200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('machines', () => {
    it('lists approved machines with stats, online', async () => {
      agent.pushStats({ cpu_pct: 42 });
      const m = await until(async () => (await api.get('/api/machines')).json.find((x) => x.name === 'box' && x.stats?.cpu_pct === 42), { what: 'stats' });
      assert.equal(m.status, 'approved'); assert.equal(m.online, true); assert.equal(m.address, '127.0.0.1');
    });
    it('a new machine is pending, online, without stats, and gets no calls', async () => {
      const p = await newAgent('pend');
      const m = (await api.get('/api/machines')).json.find((x) => x.name === 'pend');
      assert.equal(m.status, 'pending'); assert.equal(m.online, true); assert.equal(m.stats, undefined);
      const r = await api.post('/api/services', svcBody({ name: 'onpend', machine: 'pend' }));
      assert.equal(r.status, 400, 'services only on approved machines');
      assert.equal(p.calls.length, 0);
    });
    it('reject / approve / reject again; 404 for unknown machines', async () => {
      assert.equal((await api.post('/api/machines/pend/reject')).json.status, 'rejected');
      assert.equal((await api.get('/api/machines')).json.find((x) => x.name === 'pend').status, 'rejected');
      assert.equal((await api.post('/api/machines/pend/approve')).json.status, 'approved');
      assert.equal((await api.post('/api/machines/pend/reject')).json.status, 'rejected');
      assert.equal((await api.post('/api/machines/ghost/approve')).status, 404);
      assert.equal((await api.del('/api/machines/ghost')).status, 404);
    });
    it('the same hostname twice becomes name-2; a reconnect with the same key keeps its name', async () => {
      const twin = await newAgent('box');
      assert.ok((await api.get('/api/machines')).json.some((x) => x.name === 'box-2'));
      twin.close();
      const again = new FakeAgent(srv, 'box', { key: twin.key }); agents.push(again);
      await again.connect();
      const names = (await api.get('/api/machines')).json.map((x) => x.name);
      assert.ok(names.includes('box-2') && !names.includes('box-3'));
      again.close();
      assert.equal((await api.del('/api/machines/box-2')).status, 200);
    });
    it('a new connection with the same key replaces the old one (4000)', async () => {
      const a = await newAgent('dup');
      const b = new FakeAgent(srv, 'dup', { key: a.key, reconnect: false }); agents.push(b);
      a.reconnect = false;
      await b.connect();
      await until(() => a.closes.some(([c]) => c === 4000), { what: 'replaced close' });
      b.close();
      await api.del('/api/machines/dup');
    });
    it('hello: unknown key 4003, bad hello 4002', async () => {
      const unknown = new FakeAgent(srv, 'x', { key: 'a'.repeat(64), reconnect: false });
      await assert.rejects(unknown.connect(), (e) => e.code === 4003);
      const bad = new FakeAgent(srv, 'bad host name!', { key: 'a'.repeat(64), reconnect: false });
      await assert.rejects(bad.connect(), (e) => e.code === 4002);
    });
    it('removing a machine cuts its agent off (4004) and its key never works again', async () => {
      const p = agents.find((a) => a.hostname === 'pend');
      assert.equal((await api.del('/api/machines/pend')).status, 200);
      await until(() => p.closes.some(([c]) => c === 4004), { what: '4004' });
      const back = new FakeAgent(srv, 'pend', { key: p.key, reconnect: false });
      await assert.rejects(back.connect(), (e) => e.code === 4003);
      assert.ok(!(await api.get('/api/machines')).json.some((x) => x.name === 'pend'));
    });
    it('a machine with services can be neither rejected nor removed (409)', async () => {
      assert.equal((await api.post('/api/services', svcBody({ name: 'pin' }))).status, 201);
      assert.equal((await api.post('/api/machines/box/reject')).status, 409);
      assert.equal((await api.del('/api/machines/box')).status, 409);
      assert.equal((await api.del('/api/services/pin')).status, 200);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('service definitions', () => {
    it('validation: every bad field is a 400 with a reason', async () => {
      const bad = [
        {}, svcBody({ name: undefined }), svcBody({ name: 'Bad_Name' }), svcBody({ name: '-x' }), svcBody({ name: 'a'.repeat(41) }),
        svcBody({ name: 'agent' }), svcBody({ name: 'server' }), svcBody({ machine: 'nope' }), svcBody({ machine: undefined }),
        svcBody({ command: '' }), svcBody({ command: '   ' }), svcBody({ command: 'a\0b' }), svcBody({ command: 5 }),
        svcBody({ run_as: '' }), svcBody({ run_as: undefined }), svcBody({ run_as: 'Bad User' }), svcBody({ run_as: 'a;b' }),
        svcBody({ workdir: 'relative' }), svcBody({ workdir: '/a\nb' }), svcBody({ description: 'x'.repeat(201) }),
        svcBody({ description: 'two\nlines' }), svcBody({ env: [] }), svcBody({ env: 'A=1' }), svcBody({ env: { '1A': 'x' } }),
        svcBody({ env: { A: 1 } }), svcBody({ env: { A: 'x\ny' } }), svcBody({ properties: 'X=1' }), svcBody({ properties: ['nokey'] }),
        svcBody({ properties: ['lower=1'] }), svcBody({ properties: ['User=root'] }), svcBody({ properties: ['ExecStart=/bin/sh'] }),
        svcBody({ properties: ['Restart=always'] }), svcBody({ properties: ['WorkingDirectory=/'] }), svcBody({ properties: ['Environment=A=1'] }),
        svcBody({ properties: ['X=a\nb'] }), svcBody({ restart: 'sometimes' }),
      ];
      for (const b of bad) {
        const r = await api.post('/api/services', b);
        assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(r.json.error, JSON.stringify(b));
      }
      assert.equal((await api.get('/api/services')).json.length, 0, 'nothing was created');
    });
    it('create: 201 with defaults; reading it back', async () => {
      const r = await api.post('/api/services', svcBody({ description: 'test web', workdir: '/srv', env: { PORT: '8000' }, properties: ['MemoryMax=1G'], restart: 'on-failure' }));
      assert.equal(r.status, 201);
      assert.equal(r.json.version, 1); assert.equal(r.json.unit, 'fleet-web.service'); assert.equal(r.json.machine, 'box');
      const g = (await api.get('/api/services/web')).json;
      assert.deepEqual({ name: g.name, machine: g.machine, description: g.description, command: g.command, workdir: g.workdir, run_as: g.run_as, env: g.env, restart: g.restart, properties: g.properties },
        { name: 'web', machine: 'box', description: 'test web', command: 'python3 -m http.server 8000', workdir: '/srv', run_as: 'alice', env: { PORT: '8000' }, restart: 'on-failure', properties: ['MemoryMax=1G'] });
      assert.equal(g.status.running, false); assert.equal(g.restarting, false); assert.equal(g.last_error, null);
      const min = (await api.post('/api/services', svcBody({ name: 'min' }))).json;
      assert.equal(min.restart, 'no'); assert.deepEqual(min.env, {}); assert.deepEqual(min.properties, []); assert.equal(min.workdir, null); assert.equal(min.description, '');
    });
    it('duplicate name: 409', async () => assert.equal((await api.post('/api/services', svcBody())).status, 409));
    it('unknown service: 404 on every route', async () => {
      for (const [m, p] of [['GET', ''], ['PUT', ''], ['DELETE', ''], ['POST', '/start'], ['POST', '/stop'], ['POST', '/restart'],
        ['GET', '/logs'], ['GET', '/versions'], ['POST', '/rollback']])
        assert.equal((await api.req(m, `/api/services/ghost${p}`, { body: m === 'GET' || m === 'DELETE' ? undefined : { version: 1 } })).status, 404, `${m} ${p}`);
    });
    it('list: all services with live status', async () => {
      const list = (await api.get('/api/services')).json;
      assert.deepEqual(list.map((s) => s.name).sort(), ['min', 'web']);
      assert.ok(list.every((s) => s.status && s.status.active === 'inactive'));
      assert.ok(agent.calls.some((c) => c.op === 'show' && c.body.units.length === 2), 'one show call for both units');
    });
    it('update: partial, new version each save, full history kept', async () => {
      const r = await api.put('/api/services/web', { description: 'v2', env: { PORT: '9000' } });
      assert.equal(r.status, 200); assert.equal(r.json.version, 2); assert.equal(r.json.command, 'python3 -m http.server 8000', 'untouched field kept');
      assert.equal((await api.put('/api/services/web', { command: 'echo three' })).json.version, 3);
      assert.equal((await api.put('/api/services/web', { restart: 'bogus' })).status, 400);
      assert.equal((await api.get('/api/services/web')).json.version, 3, 'a refused save makes no version');
      const v = (await api.get('/api/services/web/versions')).json;
      assert.deepEqual(v.map((x) => x.version), [3, 2, 1]);
      assert.equal(v[2].description, 'test web'); assert.equal(v[1].description, 'v2'); assert.equal(v[0].command, 'echo three');
    });
    it('rollback saves the old version as a new one', async () => {
      const r = await api.post('/api/services/web/rollback', { version: 1 });
      assert.equal(r.status, 200); assert.equal(r.json.version, 4); assert.equal(r.json.description, 'test web'); assert.equal(r.json.command, 'python3 -m http.server 8000');
      assert.equal((await api.get('/api/services/web/versions')).json[0].rolled_back_from, 1);
      assert.equal((await api.post('/api/services/web/rollback', { version: 99 })).status, 404);
      assert.equal((await api.post('/api/services/web/rollback', { version: 'x' })).status, 404);
    });
    it('rename (stopped) keeps the history; name collisions are 409', async () => {
      assert.equal((await api.put('/api/services/min', { name: 'web' })).status, 409);
      const r = await api.put('/api/services/min', { name: 'mini' });
      assert.equal(r.status, 200); assert.equal(r.json.unit, 'fleet-mini.service');
      assert.equal((await api.get('/api/services/min')).status, 404);
      assert.deepEqual((await api.get('/api/services/mini/versions')).json.map((x) => x.version), [2, 1]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('control', () => {
    it('start: sends the full definition to the agent', async () => {
      const r = await api.post('/api/services/web/start');
      assert.equal(r.status, 200); assert.equal(r.json.status.running, true); assert.ok(r.json.status.pid > 0);
      const start = agent.calls.filter((c) => c.op === 'start').at(-1).body;
      assert.equal(start.unit, 'fleet-web.service');
      assert.equal(start.command, 'python3 -m http.server 8000');
      assert.equal(start.description, 'fleet: test web');
      assert.deepEqual(start.env, { PORT: '8000' });
      assert.deepEqual(start.properties, ['User=alice', 'Restart=on-failure', 'RestartSec=2', 'TimeoutStopSec=15', 'MemoryMax=1G', 'WorkingDirectory=/srv']);
      assert.match((await api.get('/api/services/web')).json.status.since, /^\d{4}-\d\d-\d\dT/);
    });
    it('start while running: 409; own RestartSec/TimeoutStopSec win over the defaults', async () => {
      assert.equal((await api.post('/api/services/web/start')).status, 409);
      await api.put('/api/services/mini', { properties: ['TimeoutStopSec=90', 'RestartSec=7'], restart: 'always' });
      await api.post('/api/services/mini/start');
      const p = agent.calls.filter((c) => c.op === 'start').at(-1).body.properties;
      assert.deepEqual(p, ['User=alice', 'Restart=always', 'TimeoutStopSec=90', 'RestartSec=7']);
      await api.post('/api/services/mini/stop');
    });
    it('logs: passes lines through', async () => {
      const r = await api.get('/api/services/web/logs?lines=50');
      assert.equal(r.status, 200); assert.match(r.headers['content-type'], /text\/plain/); assert.equal(r.text, 'log of fleet-web.service (lines=50)\n');
    });
    it('rename or move while running: 409', async () => {
      assert.equal((await api.put('/api/services/web', { name: 'web2' })).status, 409);
      assert.equal((await api.put('/api/services/web', { description: 'fine while running' })).status, 200);
    });
    it('stop answers without waiting (wait: false)', async () => {
      const r = await api.post('/api/services/web/stop');
      assert.equal(r.status, 200);
      assert.deepEqual(agent.calls.filter((c) => c.op === 'stop').at(-1).body, { unit: 'fleet-web.service', wait: false });
      assert.equal((await status('web')).running, false);
    });
    it('restart: answers at once, restarting: true meanwhile (other actions 409), then runs the current definition', async () => {
      await api.post('/api/services/web/start');
      await api.put('/api/services/web', { command: 'echo restarted' });
      let release; agent.hold = { stop: new Promise((r) => { release = r; }) };
      const r = await api.post('/api/services/web/restart');
      assert.equal(r.status, 200); assert.equal(r.json.restarting, true);
      for (const [m, p, b] of [['POST', '/start'], ['POST', '/stop'], ['POST', '/restart'], ['PUT', '', { description: 'x' }], ['DELETE', '']])
        assert.equal((await api.req(m, `/api/services/web${p}`, { body: b })).status, 409, `${m} ${p} during restart`);
      assert.equal((await api.get('/api/services')).json.find((s) => s.name === 'web').restarting, true);
      release(); agent.hold = null;
      await until(async () => !(await api.get('/api/services/web')).json.restarting, { what: 'restart to finish' });
      const g = (await api.get('/api/services/web')).json;
      assert.equal(g.status.running, true); assert.equal(g.last_error, null);
      assert.deepEqual(agent.calls.filter((c) => c.op === 'stop').at(-1).body, { unit: 'fleet-web.service', wait: true });
      assert.equal(agent.calls.filter((c) => c.op === 'start').at(-1).body.command, 'echo restarted');
    });
    it('a failed restart is reported in last_error until the next action', async () => {
      agent.failNext.start = 'systemd-run failed: boom';
      await api.post('/api/services/web/restart');
      const g = await until(async () => { const s = (await api.get('/api/services/web')).json; return !s.restarting && s; }, { what: 'restart' });
      assert.match(g.last_error.message, /restart failed: box: systemd-run failed: boom/);
      assert.equal((await api.post('/api/services/web/start')).status, 200);
      assert.equal((await api.get('/api/services/web')).json.last_error, null);
    });
    it('agent errors come back as 502 with the reason', async () => {
      agent.failNext.logs = 'journalctl failed: nope';
      const r = await api.get('/api/services/web/logs');
      assert.equal(r.status, 502); assert.equal(r.json.error, 'box: journalctl failed: nope');
    });
    it('delete stops it on its machine first', async () => {
      assert.equal((await api.del('/api/services/web')).status, 200);
      assert.deepEqual(agent.calls.filter((c) => c.op === 'stop').at(-1).body, { unit: 'fleet-web.service', wait: false });
      assert.equal(agent.units.get('fleet-web.service').active, 'inactive');
      assert.equal((await api.get('/api/services/web/versions')).status, 404, 'history goes with it');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('machine offline', () => {
    let off;
    before(async () => {
      off = await newAgent('offbox');
      await api.post('/api/machines/offbox/approve');
      await api.post('/api/services', svcBody({ name: 'remote', machine: 'offbox' }));
      off.close();
      await until(async () => !(await api.get('/api/machines')).json.find((m) => m.name === 'offbox').online, { what: 'offline' });
    });
    it('shows offline; status, start, stop, restart and logs are 502', async () => {
      assert.match((await api.get('/api/services')).json.find((s) => s.name === 'remote').status.error, /agent not connected/);
      assert.match((await api.get('/api/services/remote')).json.status.error, /agent not connected/);
      for (const a of ['start', 'stop', 'restart']) assert.equal((await api.post(`/api/services/remote/${a}`)).status, 502, a);
      assert.equal((await api.get('/api/services/remote/logs')).status, 502);
    });
    it('rename and move are allowed (nothing can be running that we know of)', async () => {
      assert.equal((await api.put('/api/services/remote', { name: 'remote2' })).status, 200);
      assert.equal((await api.put('/api/services/remote2', { machine: 'box' })).status, 200);
      assert.equal((await api.put('/api/services/remote2', { machine: 'offbox', name: 'remote' })).status, 200);
    });
    it('delete is refused with can_force; ?force=1 deletes from the database only', async () => {
      const r = await api.del('/api/services/remote');
      assert.equal(r.status, 502); assert.equal(r.json.can_force, true);
      assert.equal((await api.req('DELETE', '/api/services/remote?force=1')).status, 200);
      assert.equal((await api.get('/api/services/remote')).status, 404);
      assert.equal((await api.del('/api/machines/offbox')).status, 200);
    });
    it('rollback to a version on a removed machine is refused (409); history keeps it', async () => {
      const tmp = await newAgent('gone');
      await api.post('/api/machines/gone/approve');
      await api.post('/api/services', svcBody({ name: 'mover', machine: 'gone' }));
      await api.put('/api/services/mover', { machine: 'box' });
      tmp.close();
      assert.equal((await api.del('/api/machines/gone')).status, 200);
      const v = (await api.get('/api/services/mover/versions')).json;
      assert.equal(v.find((x) => x.version === 1).machine, null);
      assert.equal((await api.post('/api/services/mover/rollback', { version: 1 })).status, 409);
      await api.del('/api/services/mover');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('backup and restore', () => {
    let backup, keyAtBackup;
    it('backup: a .fleetbackup download', async () => {
      keyAtBackup = (await api.get('/api/api-key')).json.key;
      const r = await api.get('/api/backup');
      assert.equal(r.status, 200); assert.match(r.headers['content-disposition'], /^attachment; filename="?fleet-\d{8}-\d{6}\.fleetbackup"?$/);
      backup = r.buf;
      assert.equal(backup[0], 0x1f); assert.equal(backup[1], 0x8b, 'gzip');
    });
    it('refuses empty, changed, truncated and foreign files', async () => {
      const up = (b) => api.req('POST', '/api/restore', { body: b, headers: { 'Content-Type': 'application/octet-stream' } });
      assert.equal((await up(Buffer.alloc(0))).status, 400);
      const flipped = Buffer.from(backup); flipped[20] ^= 1;
      assert.match((await up(flipped)).json.error, /checksum/);
      assert.equal((await up(backup.subarray(0, backup.length - 1))).status, 400);
      assert.equal((await up(Buffer.from('hello world, definitely not a backup file'))).status, 400);
      // A valid wrapper around something that isn't a fleet database.
      const zlib = require('node:zlib'), crypto = require('node:crypto');
      const gz = zlib.gzipSync(Buffer.from('not sqlite')); const fake = Buffer.concat([gz, crypto.createHash('sha256').update(gz).digest()]);
      assert.equal((await up(fake)).status, 400);
    });
    it('restore: replaces services, machines and settings; keeps sessions; agents reconnect', async () => {
      await api.post('/api/services', svcBody({ name: 'after-backup' }));
      await api.post('/api/api-key/reroll');
      const welcomes = agent.welcomed;
      const r = await api.req('POST', '/api/restore', { body: backup, headers: { 'Content-Type': 'text/plain' } }); // any Content-Type
      assert.equal(r.status, 200); assert.equal(r.json.ok, true);
      assert.equal((await api.get('/api/services/after-backup')).status, 404, 'state from after the backup is gone');
      assert.equal((await api.get('/api/api-key')).json.key, keyAtBackup, 'settings come from the backup');
      assert.ok(agent.closes.some(([c]) => c === 4005), 'agents were disconnected');
      await until(() => agent.welcomed > welcomes, { what: 'agent to reconnect' });
      assert.equal((await api.get('/api/machines')).json.find((m) => m.name === 'box').online, true);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('page support and public files', () => {
    it('GET /api/config', async () => assert.deepEqual((await api.get('/api/config')).json, { files_path: '/files/' }));
    it('GET / with a session serves the page', async () => {
      const r = await api.get('/'); assert.equal(r.status, 200); assert.match(r.text, /<title>Fleet<\/title>/);
    });
    it('public files: browsable without a password over HTTPS and HTTP, read-only, sandboxed', async () => {
      fs.mkdirSync(path.join(srv.dir, 'files', 'sub'), { recursive: true });
      fs.writeFileSync(path.join(srv.dir, 'files', 'sub', 'a.txt'), 'hello');
      fs.writeFileSync(path.join(srv.dir, 'files', '.secret'), 'no');
      const { request } = require('./helpers');
      for (const base of [srv.base, srv.httpBase]) {
        const idx = await request(base, 'GET', '/files/');
        assert.equal(idx.status, 200); assert.match(idx.text, /href="sub\/"/); assert.doesNotMatch(idx.text, /secret/);
        assert.equal((await request(base, 'GET', '/files/sub/a.txt')).text, 'hello');
        assert.equal((await request(base, 'GET', '/files/.secret')).status, 404);
        assert.equal((await request(base, 'PUT', '/files/sub/a.txt', { body: 'x' })).status, 405);
        assert.match((await request(base, 'GET', '/files/sub/a.txt')).headers['content-security-policy'], /^sandbox/);
      }
      assert.equal((await request(srv.httpBase, 'GET', '/api/machines')).status, 302, 'everything else on HTTP redirects');
    });
  });
});

// A fresh server: the first sign-in sets the password, exactly once.
describe('first start', () => {
  let srv;
  before(async () => { srv = await startServer(); });
  after(async () => srv?.stop());
  it('no password: status says so, an empty one is refused, the first one sets it, then only it works', async () => {
    assert.deepEqual((await srv.req('GET', '/login/status')).json, { password_set: false });
    assert.equal((await srv.req('POST', '/login', { body: { password: '' } })).status, 400);
    const [a, b] = await Promise.all([srv.req('POST', '/login', { body: { password: 'one' } }), srv.req('POST', '/login', { body: { password: 'two' } })]);
    const won = a.status === 200 ? 'one' : 'two';
    // The loser gets 409 if both were checked before either was saved, else 401 (by then it's just a wrong password).
    assert.ok([a.status, b.status].filter((s) => s === 200).length === 1, 'exactly one wins');
    assert.ok([409, 401].includes(a.status === 200 ? b.status : a.status));
    assert.equal((await srv.req('POST', '/login', { body: { password: won } })).status, 200);
    assert.equal((await srv.req('POST', '/login', { body: { password: won === 'one' ? 'two' : 'one' } })).status, 401);
  });
  it('an API key exists from the start', async () => {
    const c = client(srv, { cookie: await login(srv, (await srv.req('POST', '/login', { body: { password: 'one' } })).status === 200 ? 'one' : 'two') });
    assert.match((await c.get('/api/api-key')).json.key, /^[0-9a-f]{64}$/);
  });
});
