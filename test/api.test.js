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
      const r = await srv.req('GET', '/nope'); assert.equal(r.status, 404); assert.equal(r.json.code, 'not_found');
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
        assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.json.code, 'unauthorized', `${m} ${p}`);
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
      const wrong = await srv.req('POST', '/login', { body: { password: 'wrong' } });
      assert.equal(wrong.status, 401); assert.equal(wrong.json.code, 'wrong_password');
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
      const bad = await me.post('/api/password', { current: 'wrong', password: 'x' });
      assert.equal(bad.status, 403); assert.equal(bad.json.code, 'wrong_password');
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
      assert.equal(r.status, 400); assert.equal(r.json.code, 'bad_json');
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
      for (const r of [await api.post('/api/machines/box/reject'), await api.del('/api/machines/box')]) { assert.equal(r.status, 409); assert.equal(r.json.code, 'has_services'); }
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
        svcBody({ health_url: 'ftp://x/' }), svcBody({ health_url: 'not a url' }), svcBody({ health_url: '/health' }), svcBody({ health_url: 5 }),
        svcBody({ health_url: 'http://a/\nb' }), svcBody({ description: 'ends with \\' }), svcBody({ workdir: '/srv\\' }), svcBody({ properties: ['Nice=5\\'] }), svcBody({ health_url: `http://a/${'x'.repeat(500)}` }),
      ];
      for (const b of bad) {
        const r = await api.post('/api/services', b);
        assert.equal(r.status, 400, JSON.stringify(b)); assert.ok(r.json.error, JSON.stringify(b)); assert.equal(r.json.code, 'invalid', JSON.stringify(b));
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
      assert.equal(g.status.running, false); assert.equal(g.status.ready, false); assert.equal(g.busy, null); assert.equal(g.last_error, null); assert.equal(g.health_url, null);
      const min = (await api.post('/api/services', svcBody({ name: 'min' }))).json;
      assert.equal(min.restart, 'no'); assert.deepEqual(min.env, {}); assert.deepEqual(min.properties, []); assert.equal(min.workdir, null); assert.equal(min.description, '');
    });
    it('duplicate name: 409 name_taken', async () => {
      const r = await api.post('/api/services', svcBody());
      assert.equal(r.status, 409); assert.equal(r.json.code, 'name_taken');
    });
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
      assert.deepEqual(agent.calls.at(-1), { op: 'remove', body: { unit: 'fleet-min.service' } }, 'the old unit file is removed');
      assert.equal((await api.get('/api/services/min')).status, 404);
      assert.deepEqual((await api.get('/api/services/mini/versions')).json.map((x) => x.version), [2, 1]);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  describe('control', () => {
    it('start: sends the full definition to the agent', async () => {
      const r = await api.post('/api/services/web/start');
      assert.equal(r.status, 200); assert.equal(r.json.changed, true); assert.equal(r.json.status.running, true); assert.ok(r.json.status.pid > 0);
      assert.equal(r.json.status.ready, true, 'no health_url: ready once running');
      const start = agent.calls.filter((c) => c.op === 'start').at(-1).body;
      assert.equal(start.unit, 'fleet-web.service');
      assert.equal(start.command, 'python3 -m http.server 8000');
      assert.equal(start.description, 'fleet: test web');
      assert.deepEqual(start.env, { PORT: '8000' });
      assert.deepEqual(start.properties, ['User=alice', 'Restart=on-failure', 'RestartSec=2', 'TimeoutStopSec=15', 'MemoryMax=1G', 'WorkingDirectory=/srv']);
      assert.match((await api.get('/api/services/web')).json.status.since, /^\d{4}-\d\d-\d\dT/);
    });
    it('start while running: 200 changed: false, nothing sent; own RestartSec/TimeoutStopSec win over the defaults', async () => {
      const starts = agent.calls.filter((c) => c.op === 'start').length;
      const again = await api.post('/api/services/web/start');
      assert.equal(again.status, 200); assert.equal(again.json.changed, false); assert.equal(again.json.status.running, true);
      assert.equal(agent.calls.filter((c) => c.op === 'start').length, starts);
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
    it('stop answers without waiting (wait: false); stopping a stopped service is changed: false', async () => {
      const r = await api.post('/api/services/web/stop');
      assert.equal(r.status, 200); assert.equal(r.json.changed, true);
      assert.deepEqual(agent.calls.filter((c) => c.op === 'stop').at(-1).body, { unit: 'fleet-web.service', wait: false });
      assert.equal((await status('web')).running, false);
      const stops = agent.calls.filter((c) => c.op === 'stop').length;
      const again = await api.post('/api/services/web/stop');
      assert.equal(again.json.changed, false); assert.equal(agent.calls.filter((c) => c.op === 'stop').length, stops);
    });
    it('restart: answers at once, busy: restarting meanwhile (other actions 409 busy), then runs the current definition', async () => {
      await api.post('/api/services/web/start');
      await api.put('/api/services/web', { command: 'echo restarted' });
      let release; agent.hold = { stop: new Promise((r) => { release = r; }) };
      const r = await api.post('/api/services/web/restart');
      assert.equal(r.status, 200); assert.equal(r.json.busy, 'restarting'); assert.equal(r.json.changed, true);
      for (const [m, p, b] of [['POST', '/start'], ['POST', '/stop'], ['POST', '/restart'], ['PUT', '', { description: 'x' }], ['DELETE', '']]) {
        const x = await api.req(m, `/api/services/web${p}`, { body: b });
        assert.equal(x.status, 409, `${m} ${p} during restart`); assert.equal(x.json.code, 'busy');
      }
      assert.equal((await api.get('/api/services')).json.find((s) => s.name === 'web').busy, 'restarting');
      release(); agent.hold = null;
      await until(async () => !(await api.get('/api/services/web')).json.busy, { what: 'restart to finish' });
      const g = (await api.get('/api/services/web')).json;
      assert.equal(g.status.running, true); assert.equal(g.last_error, null);
      assert.deepEqual(agent.calls.filter((c) => c.op === 'stop').at(-1).body, { unit: 'fleet-web.service', wait: true });
      assert.equal(agent.calls.filter((c) => c.op === 'start').at(-1).body.command, 'echo restarted');
    });
    it('a failed restart is reported in last_error until the next action', async () => {
      agent.failNext.start = 'systemd-run failed: boom';
      await api.post('/api/services/web/restart');
      const g = await until(async () => { const s = (await api.get('/api/services/web')).json; return !s.busy && s; }, { what: 'restart' });
      assert.match(g.last_error.message, /restart failed: box: systemd-run failed: boom/);
      const st = await api.post('/api/services/web/start');
      assert.equal(st.status, 200); assert.equal(st.json.changed, true);
      assert.equal((await api.get('/api/services/web')).json.last_error, null);
    });
    it('agent errors come back as 502 with the reason', async () => {
      agent.failNext.logs = 'journalctl failed: nope';
      const r = await api.get('/api/services/web/logs');
      assert.equal(r.status, 502); assert.equal(r.json.error, 'box: journalctl failed: nope'); assert.equal(r.json.code, 'agent_error');
    });
    it('delete stops it on its machine first, waiting for that, then removes its unit file', async () => {
      let done; agent.hold = { stop: new Promise((r) => { done = r; }) };
      setTimeout(() => done(), 500);
      const t0 = Date.now();
      assert.equal((await api.del('/api/services/web')).status, 200);
      agent.hold = null;
      assert.ok(Date.now() - t0 >= 400, 'waited for the stop');
      assert.deepEqual(agent.calls.filter((c) => c.op === 'stop').at(-1).body, { unit: 'fleet-web.service', wait: true });
      assert.deepEqual(agent.calls.at(-1), { op: 'remove', body: { unit: 'fleet-web.service' } }, 'then its unit file is removed');
      assert.equal(agent.units.has('fleet-web.service'), false);
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
      for (const a of ['start', 'stop', 'restart']) {
        const r = await api.post(`/api/services/remote/${a}`);
        assert.equal(r.status, 502, a); assert.equal(r.json.code, 'machine_offline', a);
      }
      assert.equal((await api.get('/api/services/remote/logs')).status, 502);
    });
    it('rename and move are allowed (nothing can be running that we know of)', async () => {
      assert.equal((await api.put('/api/services/remote', { name: 'remote2' })).status, 200);
      assert.equal((await api.put('/api/services/remote2', { machine: 'box' })).status, 200);
      assert.equal((await api.put('/api/services/remote2', { machine: 'offbox', name: 'remote' })).status, 200);
    });
    it('delete is refused with can_force; ?force=1 deletes from the database only', async () => {
      const r = await api.del('/api/services/remote');
      assert.equal(r.status, 502); assert.equal(r.json.can_force, true); assert.equal(r.json.code, 'machine_offline');
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
      const f = await up(flipped);
      assert.match(f.json.error, /checksum/); assert.equal(f.json.code, 'bad_backup');
      assert.equal((await up(backup.subarray(0, backup.length - 1))).status, 400);
      assert.equal((await up(Buffer.from('hello world, definitely not a backup file'))).status, 400);
      // A valid wrapper around something that isn't a fleet database.
      const zlib = require('node:zlib'), crypto = require('node:crypto');
      const gz = zlib.gzipSync(Buffer.from('not sqlite')); const fake = Buffer.concat([gz, crypto.createHash('sha256').update(gz).digest()]);
      assert.equal((await up(fake)).status, 400);
      // A valid wrapper around something that unpacks to more than 1 GB (a gzip bomb): refused without unpacking it all.
      const bomb = zlib.gzipSync(Buffer.alloc(2 ** 30 + 1), { level: 9 });
      const r = await up(Buffer.concat([bomb, crypto.createHash('sha256').update(bomb).digest()]));
      assert.equal(r.status, 400); assert.match(r.json.error, /more than 1 GB/);
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
  describe('health checks, waiting, repeat-safe actions', () => {
    const URL_OK = 'http://127.0.0.1:7000/health';
    const t = () => Date.now();
    const lastStop = () => agent.calls.filter((c) => c.op === 'stop').at(-1).body;
    before(async () => {
      await api.post('/api/services', svcBody({ name: 'model', command: 'serve-model', health_url: URL_OK }));
    });

    it('running but not answering its health URL: ready false, with the reason', async () => {
      const r = await api.post('/api/services/model/start');
      assert.equal(r.json.status.running, true); assert.equal(r.json.status.ready, false);
      assert.deepEqual(r.json.status.health, { ok: false, error: 'connect ECONNREFUSED' });
      assert.deepEqual(agent.calls.filter((c) => c.op === 'probe').at(-1).body, { urls: [URL_OK], timeout_ms: 3000 });
      agent.health.set(URL_OK, { ok: true, status: 200 });
      const g = (await api.get('/api/services/model')).json.status;
      assert.equal(g.ready, true); assert.deepEqual(g.health, { ok: true, status: 200 });
      assert.equal((await api.get('/api/services')).json.find((x) => x.name === 'model').status.ready, true, 'the list probes too');
    });
    it('a stopped service is not probed and not ready', async () => {
      await api.post('/api/services/model/stop?wait=1');
      const probes = agent.calls.filter((c) => c.op === 'probe').length;
      const g = (await api.get('/api/services/model')).json.status;
      assert.equal(g.ready, false); assert.equal(g.health, undefined);
      assert.equal(agent.calls.filter((c) => c.op === 'probe').length, probes);
    });
    it('start?wait=1 answers only once the health URL answers', async () => {
      agent.health.delete(URL_OK);
      setTimeout(() => agent.health.set(URL_OK, { ok: true, status: 200 }), 1500);
      const t0 = t();
      const r = await api.post('/api/services/model/start?wait=1');
      assert.equal(r.status, 200, r.text);
      assert.ok(t() - t0 >= 1400, `waited ${t() - t0} ms`);
      assert.equal(r.json.changed, true); assert.equal(r.json.status.ready, true); assert.equal(r.json.busy, null);
    });
    it('start?wait=1 on a ready service answers at once with changed: false', async () => {
      const t0 = t();
      const r = await api.post('/api/services/model/start?wait=1');
      assert.equal(r.json.changed, false); assert.equal(r.json.status.ready, true); assert.ok(t() - t0 < 1000);
    });
    it('while a request waits, the service is busy: other actions get 409 busy, the page sees busy: starting', async () => {
      await api.post('/api/services/model/stop?wait=1');
      agent.health.delete(URL_OK);
      const waiting = api.post('/api/services/model/start?wait=1&timeout=20');
      await until(async () => (await api.get('/api/services/model')).json.busy === 'starting', { what: 'busy' });
      for (const [m, p] of [['POST', '/stop'], ['POST', '/start'], ['POST', '/restart'], ['DELETE', '']]) {
        const r = await api.req(m, `/api/services/model${p}`, { body: m === 'POST' ? {} : undefined });
        assert.equal(r.status, 409, `${m} ${p}`); assert.equal(r.json.code, 'busy');
      }
      agent.health.set(URL_OK, { ok: true, status: 200 });
      assert.equal((await waiting).status, 200);
      assert.equal((await api.get('/api/services/model')).json.busy, null);
    });
    it('start?wait=1 that never gets ready: 504 not_ready with the reason and recent logs; kept in last_error', async () => {
      await api.post('/api/services/model/stop?wait=1');
      agent.health.set(URL_OK, { ok: false, status: 503 });
      const t0 = t();
      const r = await api.post('/api/services/model/start?wait=1&timeout=2');
      assert.equal(r.status, 504); assert.equal(r.json.code, 'not_ready');
      assert.ok(t() - t0 >= 1900 && t() - t0 < 5000, `took ${t() - t0} ms`);
      assert.match(r.json.error, /did not become ready within 2 s: http:\/\/127\.0\.0\.1:7000\/health answered 503/);
      assert.equal(r.json.logs, 'log of fleet-model.service (lines=30)\n');
      assert.match((await api.get('/api/services/model')).json.last_error.message, /did not become ready/);
      assert.equal((await status('model')).running, true, 'it is left running (it may still come up)');
    });
    it('start?wait=1 of a service that crashes while starting: 502 start_failed with the exit status and logs', async () => {
      await api.post('/api/services', svcBody({ name: 'crashy', command: 'false', health_url: 'http://127.0.0.1:7001/' }));
      agent.crashOnStart.add('fleet-crashy.service');
      const r = await api.post('/api/services/crashy/start?wait=1&timeout=10');
      assert.equal(r.status, 502); assert.equal(r.json.code, 'start_failed');
      assert.equal(r.json.error, 'crashy failed (exit status 3)'); assert.match(r.json.logs, /fleet-crashy/);
      await api.del('/api/services/crashy');
    });
    it('stop?wait=1 waits for the agent to finish stopping; again: changed: false', async () => {
      await api.post('/api/services/model/stop?wait=1'); // from the not_ready test
      agent.health.set(URL_OK, { ok: true, status: 200 });
      await api.post('/api/services/model/start?wait=1');
      let done; agent.hold = { stop: new Promise((r) => { done = r; }) };
      setTimeout(() => done(), 800);
      const t0 = t();
      const r = await api.post('/api/services/model/stop?wait=1');
      agent.hold = null;
      assert.ok(t() - t0 >= 700, 'waited for the agent');
      assert.equal(r.json.changed, true); assert.equal(r.json.status.running, false); assert.deepEqual(lastStop(), { unit: 'fleet-model.service', wait: true });
      assert.equal((await api.post('/api/services/model/stop?wait=1')).json.changed, false);
    });
    it('restart?wait=1 answers once the restarted service is ready, with the new definition', async () => {
      await api.post('/api/services/model/start?wait=1');
      await api.put('/api/services/model', { command: 'serve-model --v2' });
      agent.health.delete(URL_OK);
      setTimeout(() => agent.health.set(URL_OK, { ok: true, status: 200 }), 1200);
      const r = await api.post('/api/services/model/restart?wait=1');
      assert.equal(r.status, 200, r.text); assert.equal(r.json.status.ready, true); assert.equal(r.json.busy, null);
      assert.equal(agent.calls.filter((c) => c.op === 'start').at(-1).body.command, 'serve-model --v2');
    });
    it('simultaneous starts: one start, the others changed: false (never a systemd error)', async () => {
      await api.post('/api/services/model/stop?wait=1');
      const starts = agent.calls.filter((c) => c.op === 'start').length;
      const rs = await Promise.all([1, 2, 3, 4].map(() => api.post('/api/services/model/start')));
      assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200]);
      assert.equal(rs.filter((r) => r.json.changed).length, 1);
      assert.equal(agent.calls.filter((c) => c.op === 'start').length, starts + 1);
    });
    it('bad wait / timeout parameters: 400 invalid', async () => {
      for (const q of ['wait=yes', 'wait=1&timeout=0', 'wait=1&timeout=1801', 'wait=1&timeout=1.5', 'wait=1&timeout=abc']) {
        const r = await api.post(`/api/services/model/start?${q}`);
        assert.equal(r.status, 400, q); assert.equal(r.json.code, 'invalid', q);
      }
    });
    it('health_url can be changed and cleared; it is versioned', async () => {
      assert.equal((await api.put('/api/services/model', { health_url: 'https://127.0.0.1:7443/ready' })).json.health_url, 'https://127.0.0.1:7443/ready');
      assert.equal((await api.put('/api/services/model', { health_url: '' })).json.health_url, null);
      const v = (await api.get('/api/services/model/versions')).json;
      assert.deepEqual(v.slice(0, 3).map((x) => x.health_url), [null, 'https://127.0.0.1:7443/ready', URL_OK]);
      assert.equal((await api.get('/api/services/model')).json.status.ready, true, 'no health_url: ready when running');
    });
    it('an agent from before health checks: a clear error instead of a probe it cannot do', async () => {
      const old = await newAgent('oldbox', { ops: null });
      await api.post('/api/machines/oldbox/approve');
      await api.post('/api/services', svcBody({ name: 'legacy', machine: 'oldbox', health_url: URL_OK }));
      const r = await api.post('/api/services/legacy/start');
      assert.equal(r.json.status.ready, false);
      assert.match(r.json.status.health.error, /fleet-agent on oldbox is too old for health checks/);
      assert.ok(!old.calls.some((c) => c.op === 'probe'));
      await api.del('/api/services/legacy'); old.close(); await api.del('/api/machines/oldbox');
    });
    after(async () => { agent.health.clear(); await api.del('/api/services/model'); });
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

// Databases and backups from before health checks are upgraded in place.
describe('upgrades', () => {
  const { DatabaseSync } = require('node:sqlite');
  const zlib = require('node:zlib'), crypto = require('node:crypto'), os = require('node:os');
  // The schema of the first release (no health_url), with one machine and one service.
  function oldDatabase(file) {
    const d = new DatabaseSync(file);
    d.exec(`CREATE TABLE machines (id INTEGER PRIMARY KEY AUTOINCREMENT, key_sha256 TEXT UNIQUE, name TEXT UNIQUE, address TEXT,
        status TEXT NOT NULL DEFAULT 'pending', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT 'x', activated_at TEXT, decided_at TEXT);
      CREATE TABLE settings (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, ip TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT 'x', last_seen_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE services (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, version INTEGER NOT NULL DEFAULT 1,
        machine_id INTEGER NOT NULL REFERENCES machines (id), description TEXT NOT NULL DEFAULT '', command TEXT NOT NULL, workdir TEXT,
        run_as TEXT NOT NULL, env TEXT, restart TEXT NOT NULL DEFAULT 'no', properties TEXT, created_at TEXT NOT NULL DEFAULT 'x', updated_at TEXT NOT NULL DEFAULT 'x');
      CREATE TABLE service_versions (service_id INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE, version INTEGER NOT NULL,
        name TEXT NOT NULL, machine_id INTEGER NOT NULL, description TEXT NOT NULL DEFAULT '', command TEXT NOT NULL, workdir TEXT,
        run_as TEXT NOT NULL, env TEXT, restart TEXT NOT NULL, properties TEXT, rolled_back_from INTEGER, created_at TEXT NOT NULL DEFAULT 'x',
        PRIMARY KEY (service_id, version));
      INSERT INTO machines (key_sha256, name, status, activated_at) VALUES ('k', 'oldbox', 'approved', '2026-01-01T00:00:00Z');
      INSERT INTO services (name, machine_id, command, run_as, env, properties) VALUES ('legacy', 1, 'run-it', 'alice', '{}', '[]');
      INSERT INTO service_versions (service_id, version, name, machine_id, command, run_as, env, restart, properties) VALUES (1, 1, 'legacy', 1, 'run-it', 'alice', '{}', 'no', '[]');`);
    d.close();
  }
  it('the server upgrades an old database on start, keeping its data', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-old-'));
    fs.mkdirSync(path.join(dir, 'data'));
    oldDatabase(path.join(dir, 'data', 'fleet.db'));
    const srv = await startServer({ FLEET_DATA_DIR: path.join(dir, 'data') });
    try {
      const c = client(srv, { cookie: await login(srv, PW) });
      const g = (await c.get('/api/services/legacy')).json;
      assert.equal(g.command, 'run-it'); assert.equal(g.health_url, null);
      assert.equal((await c.put('/api/services/legacy', { health_url: 'http://127.0.0.1:1/h' })).json.health_url, 'http://127.0.0.1:1/h');
      assert.deepEqual((await c.get('/api/services/legacy/versions')).json.map((v) => v.health_url), ['http://127.0.0.1:1/h', null]);
    } finally { await srv.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('a backup from before health checks restores; any other SQLite file is refused and changes nothing', async () => {
    const srv = await startServer();
    try {
      const c = client(srv, { cookie: await login(srv, PW) });
      const wrap = (file) => { const gz = zlib.gzipSync(fs.readFileSync(file)); return Buffer.concat([gz, crypto.createHash('sha256').update(gz).digest()]); };
      const up = (buf) => c.req('POST', '/api/restore', { body: buf, headers: { 'Content-Type': 'application/octet-stream' } });

      const other = path.join(srv.dir, 'other.db');
      const d = new DatabaseSync(other); d.exec('CREATE TABLE notes (t TEXT); INSERT INTO notes VALUES (1);'); d.close();
      const r1 = await up(wrap(other));
      assert.equal(r1.status, 400); assert.equal(r1.json.code, 'bad_backup'); assert.match(r1.json.error, /no machines table/);
      assert.equal((await c.get('/api/machines')).json.length, 0, 'nothing was changed');

      const old = path.join(srv.dir, 'old.db');
      oldDatabase(old);
      const r2 = await up(wrap(old));
      assert.equal(r2.status, 200, r2.text); assert.deepEqual([r2.json.machines, r2.json.services], [1, 1]);
      const g = (await c.get('/api/services/legacy')).json;
      assert.equal(g.command, 'run-it'); assert.equal(g.health_url, null); assert.equal(g.machine, 'oldbox');
    } finally { await srv.stop(); }
  });
});
