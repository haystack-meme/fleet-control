#!/usr/bin/env node
'use strict';
// fleet-agent: the client for fleet-server (Node built-ins only). It and its unit template, fleet-agent.service, are
// served by fleet-server at https://<server>/install/.
//
//   sudo node fleet-agent.js --install --server 192.0.2.10    enroll (get a code from https://<ip>/enroll and activate it
//                                                             within its 1 minute: it becomes this machine's key, saved in
//                                                             /etc/fleet-agent/key; an existing key is kept if the server still
//                                                             accepts it, otherwise it enrolls again), copy this file
//                                                             to /usr/local/lib/fleet-agent/, download
//                                                             https://<ip>/install/fleet-agent.service into
//                                                             /etc/systemd/system/ (filling in the server address), enable + start it
//   node fleet-agent.js --run --server 192.0.2.10             the agent itself (what the unit runs); connects to wss://<ip>/agent
//
// In --run mode it listens on nothing: it keeps one WebSocket open to the server, says hello with its key + hostname
// (the server identifies the machine by the key), pushes system + GPU stats every 5 s and runs the commands the server
// sends. It runs as root and only manages units named fleet-<name>.service.
//
// The server's certificate is self-signed, so it isn't checked against any authority. Instead the agent is pinned to
// its server: the first --install saves the SHA-256 fingerprint of the certificate the server presents
// (/etc/fleet-agent/server), and from then on the agent only talks to a server presenting that same certificate,
// checked before anything is sent. If the server's certificate is replaced on purpose, delete that file and run
// --install again on each machine.
const fs = require('node:fs');
const os = require('node:os');
const tls = require('node:tls');
const http = require('node:http');
const crypto = require('node:crypto');
const EventEmitter = require('node:events');
const { execFile, execFileSync } = require('node:child_process');

// ---- Node version: must be at least the version this was built with ----
const MIN_NODE = '26.13.1';
{
  const cur = process.versions.node.split('.').map(Number), min = MIN_NODE.split('.').map(Number);
  const i = [0, 1, 2].find((k) => cur[k] !== min[k]); // first part that differs (major, minor, patch)
  if (i !== undefined && cur[i] < min[i]) { console.error(`fleet-agent needs Node ${MIN_NODE} or newer (this is ${process.versions.node})`); process.exit(1); }
}

// ---- flags: exactly one of --install / --run, plus --server <IPv4 address of fleet-server> ----
const USAGE = 'usage: sudo node fleet-agent.js --install --server <IPv4 address>\n       node fleet-agent.js --run --server <IPv4 address>';
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--install' || a === '--run') out[a.slice(2)] = true;
    else if (a === '--server') out.server = argv[++i];
    else if (a.startsWith('--server=')) out.server = a.slice(9);
    else return null;
  }
  if (!!out.install === !!out.run || !require('node:net').isIPv4(out.server || '')) return null;
  return out;
}
const args = parseArgs(process.argv.slice(2));
if (!args) { console.error(USAGE); process.exit(2); }

const KEY_FILE = '/etc/fleet-agent/key';
const readKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return null; } };

// ---- the pinned connection to the server ----
const PIN_FILE = '/etc/fleet-agent/server'; // "<server ip> <SHA-256 fingerprint of its certificate>"
const FP = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
// The saved fingerprint for this server address (null if none: a first install, or pinned to another address).
function readPin() {
  try {
    const [ip, fp] = fs.readFileSync(PIN_FILE, 'utf8').trim().split(/\s+/);
    return ip === args.server && FP.test(fp || '') ? fp : null;
  } catch { return null; }
}
let pin = null; // the fingerprint the server must present; during a first install, the first one seen
const pinError = (got) => Object.assign(new Error(`the server at ${args.server} presented a different certificate than the one this agent ` +
  `was installed with (expected ${pin}, got ${got}). If the server's certificate was replaced on purpose, delete ${PIN_FILE} ` +
  `and run --install again.`), { pinMismatch: true });

// A TLS connection to the server whose certificate has been checked against the pin (nothing is sent before that).
function connectTls() {
  return new Promise((resolve, reject) => {
    const sock = tls.connect({ host: args.server, port: 443, rejectUnauthorized: false }); // the pin is the check
    sock.setTimeout(15000, () => sock.destroy(new Error('timed out')));
    sock.once('error', reject);
    sock.once('secureConnect', () => {
      const fp = sock.getPeerCertificate().fingerprint256;
      if (pin && fp !== pin) { sock.destroy(); return reject(pinError(fp)); }
      pin ||= fp;
      sock.setTimeout(0);
      sock.off('error', reject);
      resolve(sock);
    });
  });
}
// An HTTPS request over a checked connection: { status, body }.
async function request(method, path) {
  const sock = await connectTls();
  return new Promise((resolve, reject) => {
    const req = http.request({ host: args.server, path, method, createConnection: () => sock, headers: { 'Content-Length': 0 } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A small WebSocket client (RFC 6455: text messages, ping/pong, close) over a checked connection to wss://<server>/agent.
// Events: 'message' (text), 'close' (code, reason). The connection counts as dead after 75 s without anything from the
// server (it pings every 30 s).
class Ws extends EventEmitter {
  constructor(sock, rest) {
    super();
    this.sock = sock; this.buf = Buffer.alloc(0); this.parts = []; this.open = true; this.seen = Date.now();
    sock.on('data', (d) => this.feed(d));
    sock.on('close', () => this.end(1006, 'connection lost'));
    sock.on('error', () => {});
    this.watch = setInterval(() => { if (Date.now() - this.seen > 75000) { this.sock.destroy(); this.end(1006, 'no answer from the server'); } }, 5000);
    if (rest.length) setImmediate(() => this.feed(rest)); // after the caller has added its listeners
  }
  feed(d) {
    this.seen = Date.now();
    this.buf = Buffer.concat([this.buf, d]);
    while (this.open && this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      if (b1 & 0x80) return this.close(1002); // frames from a server are never masked
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > 64n << 20n) return this.close(1009); // over 64 MB
        len = Number(big); off = 10;
      }
      if (this.buf.length < off + len) return;
      const data = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      const op = b0 & 0x0f, fin = b0 & 0x80;
      if (op === 0x8) { // close: answer it, then we're done
        const code = data.length >= 2 ? data.readUInt16BE(0) : 1005;
        this.frame(0x8, data.subarray(0, 2));
        return this.end(code, data.subarray(2).toString());
      }
      if (op === 0x9) { this.frame(0xa, data); continue; } // ping -> pong
      if (op === 0xa) continue; // pong
      if (op > 0x2) return this.close(1002);
      this.parts.push(data);
      if (fin) { const msg = Buffer.concat(this.parts).toString(); this.parts = []; this.emit('message', msg); }
    }
  }
  frame(op, data) {
    if (!this.open) return;
    const len = data.length, mask = crypto.randomBytes(4);
    const head = len < 126 ? Buffer.from([0x80 | op, 0x80 | len])
      : len < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 0xff])
      : Buffer.concat([Buffer.from([0x80 | op, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b; })()]);
    const body = Buffer.from(data);
    for (let i = 0; i < body.length; i++) body[i] ^= mask[i & 3];
    this.sock.write(Buffer.concat([head, mask, body]));
  }
  send(text) { this.frame(0x1, Buffer.from(text)); }
  close(code = 1000) {
    const p = Buffer.alloc(2); p.writeUInt16BE(code);
    this.frame(0x8, p);
    this.end(code, '');
  }
  end(code, reason) {
    if (!this.open) return;
    this.open = false;
    clearInterval(this.watch);
    this.sock.end();
    setTimeout(() => this.sock.destroy(), 2000).unref();
    this.emit('close', code, reason);
  }
}
async function wsConnect() {
  const sock = await connectTls();
  const key = crypto.randomBytes(16).toString('base64');
  sock.write(`GET /agent HTTP/1.1\r\nHost: ${args.server}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
    `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => done(new Error('no answer from the server')), 15000);
    const done = (err, ws) => {
      clearTimeout(timer); sock.off('data', onData); sock.off('error', done); sock.off('close', onClose);
      if (err) { sock.destroy(); reject(err); } else resolve(ws);
    };
    const onClose = () => done(new Error('connection closed by the server'));
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return buf.length > 16384 ? done(new Error('bad answer from the server')) : undefined;
      const [status, ...lines] = buf.subarray(0, end).toString().split('\r\n');
      const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));
      const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      if (!/^HTTP\/1\.1 101 /.test(status) || headers['sec-websocket-accept'] !== accept) return done(new Error(`the server refused the connection: ${status}`));
      done(null, new Ws(sock, buf.subarray(end + 4)));
    };
    sock.on('data', onData); sock.once('error', done); sock.once('close', onClose);
  });
}

// Activate a new code: one hello with it (must happen within its 1 minute); resolves on welcome, rejects on refusal.
async function activate(key) {
  const ws = await wsConnect();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('no answer from the server')); }, 15000);
    ws.on('message', (m) => { try { if (JSON.parse(m).type === 'welcome') { clearTimeout(timer); resolve(); ws.close(); } } catch {} }); // resolve first: close() fires 'close'
    ws.on('close', (code, reason) => { clearTimeout(timer); reject(new Error(`refused: ${reason || code}`)); });
    ws.send(JSON.stringify({ type: 'hello', machine: os.hostname(), key, stats: stats() }));
  });
}

// ---- --install: enroll (or keep the existing key), copy this file into place, download the unit, enable + (re)start ----
if (args.install) (async () => {
  const JS = '/usr/local/lib/fleet-agent/fleet-agent.js', UNIT = '/etc/systemd/system/fleet-agent.service';
  const unitUrl = `https://${args.server}/install/fleet-agent.service`;
  if (process.getuid() !== 0) { console.error('--install must run as root (sudo)'); process.exit(1); }
  pin = readPin(); // re-installing for the same server: it must still present the saved certificate
  const res = await request('GET', '/install/fleet-agent.service').catch((e) => ({ status: 0, error: e }));
  if (res.error?.pinMismatch) { console.error(res.error.message); process.exit(1); }
  if (res.status !== 200) { console.error(`could not download ${unitUrl}: ${res.error ? res.error.code || res.error.message : `HTTP ${res.status}`}`); process.exit(1); }
  if (!readPin()) console.log(`server certificate SHA-256 ${pin}: this agent will only talk to a server presenting this certificate`);
  const unit = res.body;
  if (!unit.includes('[Service]') || !unit.includes('@SERVER@')) { console.error(`${unitUrl} is not the fleet-agent unit template`); process.exit(1); }
  // An existing key is kept only if the server still accepts it (a removed machine's key is dead: enroll again).
  let keep = false;
  if (readKey()) {
    try { await activate(readKey()); keep = true; console.log(`keeping the existing key in ${KEY_FILE} (delete it to enroll as a new machine)`); }
    catch (err) { console.log(`the existing key no longer works (${err.message}): enrolling again`); }
  }
  if (!keep) {
    const e = await request('POST', '/enroll').then((r) => JSON.parse(r.body)).catch((err) => ({ error: err.message }));
    if (!e.code) { console.error(`could not enroll: ${e.error || 'no code'}`); process.exit(1); }
    try { await activate(e.code); } catch (err) { console.error(`could not activate the code: ${err.message}`); process.exit(1); }
    fs.mkdirSync('/etc/fleet-agent', { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, e.code + '\n', { mode: 0o600 });
    console.log(`enrolled: key saved in ${KEY_FILE}`);
  }
  fs.mkdirSync('/etc/fleet-agent', { recursive: true, mode: 0o700 });
  fs.writeFileSync(PIN_FILE, `${args.server} ${pin}\n`, { mode: 0o600 });
  fs.mkdirSync('/usr/local/lib/fleet-agent', { recursive: true });
  if (fs.realpathSync(__filename) !== (fs.existsSync(JS) && fs.realpathSync(JS))) fs.copyFileSync(__filename, JS);
  fs.chmodSync(JS, 0o644);
  fs.writeFileSync(UNIT, unit.replaceAll('@SERVER@', args.server), { mode: 0o644 });
  for (const cmd of [['daemon-reload'], ['enable', 'fleet-agent.service'], ['restart', 'fleet-agent.service']]) execFileSync('systemctl', cmd, { stdio: 'inherit' });
  console.log(`fleet-agent installed and running: ${JS}, ${UNIT} (from ${unitUrl})`);
  process.exit(0);
})();

// ---- --run (everything below; connect() at the end starts it) ----
const SERVER = `wss://${args.server}/agent`;
const KEY = args.run && readKey();
if (args.run && !KEY) { console.error(`no key in ${KEY_FILE}: run --install first`); process.exit(1); }
if (args.run && !(pin = readPin())) { console.error(`no saved certificate for the server ${args.server} in ${PIN_FILE}: run --install --server ${args.server} again`); process.exit(1); }
const UNIT = /^fleet-[a-z0-9][a-z0-9-]{0,39}\.service$/;
const oneLine = (s) => typeof s === 'string' && !/[\0\r\n]/.test(s);
const fail = (msg) => { throw new Error(msg); };
const STOP_TIMEOUT_MS = 10 * 60 * 1000; // the server waits a little longer than this for a stop

function exec(cmd, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })));
}
async function must(cmd, args, okCodes = [0], opts) {
  const r = await exec(cmd, args, opts);
  if (!okCodes.includes(r.code)) fail(`${cmd} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return r;
}
// fleet-agent.service (this agent) and fleet-server.service (the server) are never managed units.
const unitOf = (u) => (UNIT.test(u || '') && !['fleet-agent.service', 'fleet-server.service'].includes(u) ? u : fail('unit must be fleet-<name>.service'));

// ---- stats: CPU % over the last 5 s; the rest is read when sent ----
const readCpu = () => {
  const f = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
  return { total: f.reduce((a, b) => a + b, 0), idle: f[3] + f[4] };
};
let prevCpu = readCpu();
function stats() {
  const c = readCpu(), dt = c.total - prevCpu.total;
  const cpuPct = dt > 0 ? Math.round(100 * (dt - (c.idle - prevCpu.idle)) / dt) : 0;
  prevCpu = c;
  const mem = {};
  for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/);
    if (m) mem[m[1]] = Number(m[2]);
  }
  const d = fs.statfsSync('/');
  return {
    uptime_sec: Math.round(os.uptime()), cpu_pct: cpuPct, cpus: os.cpus().length, load: os.loadavg().map((x) => +x.toFixed(2)),
    mem_total_kb: mem.MemTotal, mem_avail_kb: mem.MemAvailable, swap_total_kb: mem.SwapTotal, swap_free_kb: mem.SwapFree,
    disk_total_kb: Math.round(d.blocks * d.bsize / 1024), disk_used_kb: Math.round((d.blocks - d.bfree) * d.bsize / 1024),
  };
}

// ---- GPUs: NVIDIA via nvidia-smi (if installed), AMD via the amdgpu sysfs files. Others (e.g. Intel iGPUs) report nothing. ----
const readNum = (f) => { try { return Number(fs.readFileSync(f, 'utf8').trim()); } catch { return null; } };
// AMD cards: [{ dir, name }] found once at start; the name comes from lspci when available (sysfs has none).
const amdCards = (() => { try { return fs.readdirSync('/sys/class/drm'); } catch { return []; } })().filter((c) => /^card\d+$/.test(c)).map((c) => `/sys/class/drm/${c}/device`)
  .filter((d) => readNum(`${d}/gpu_busy_percent`) !== null && fs.existsSync(`${d}/mem_info_vram_total`))
  .map((dir) => {
    const slot = fs.realpathSync(dir).split('/').pop();
    let name = 'AMD GPU';
    try {
      const dev = execFileSync('lspci', ['-vmm', '-s', slot], { encoding: 'utf8' }).match(/^Device:\s*(.*)$/m)[1];
      name = 'AMD ' + (dev.match(/\[(.*)\]/)?.[1] || dev);
      if (name.includes('/')) name = name.split('/')[0].replace(/\s+\S+$/, '') + ' series'; // "RX 7900 XT/7900 XTX/..." -> "RX 7900 series"
    } catch {}
    const hwmon = (() => { try { return `${dir}/hwmon/${fs.readdirSync(`${dir}/hwmon`)[0]}`; } catch { return null; } })();
    return { dir, name, hwmon };
  });
async function gpus() {
  const out = [];
  const smi = await exec('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
  if (smi.code === 0) for (const line of smi.stdout.trim().split('\n').filter(Boolean)) {
    const [name, util, used, total, temp, power] = line.split(',').map((x) => x.trim());
    out.push({ name, util_pct: +util, vram_used_mb: +used, vram_total_mb: +total, temp_c: +temp || null, power_w: Math.round(+power) || null });
  }
  for (const c of amdCards) {
    const temp = c.hwmon && readNum(`${c.hwmon}/temp1_input`), power = c.hwmon && (readNum(`${c.hwmon}/power1_average`) ?? readNum(`${c.hwmon}/power1_input`));
    out.push({ name: c.name, util_pct: readNum(`${c.dir}/gpu_busy_percent`),
      vram_used_mb: Math.round(readNum(`${c.dir}/mem_info_vram_used`) / 1048576), vram_total_mb: Math.round(readNum(`${c.dir}/mem_info_vram_total`) / 1048576),
      temp_c: temp ? Math.round(temp / 1000) : null, power_w: power ? Math.round(power / 1e6) : null });
  }
  return out;
}

const withGpus = async () => ({ ...stats(), gpus: await gpus() });

// ---- commands from the server ----
const ops = {
  // systemctl show for several units: one blank-line-separated block of Key=Value per unit, in order.
  async show({ units }) {
    if (!Array.isArray(units) || !units.length) fail('units required');
    const props = 'ActiveState,SubState,LoadState,MainPID,ExecMainStartTimestamp,ExecMainStatus';
    const r = await must('systemctl', ['show', '--timestamp=unix', '-p', props, '--', ...units.map(unitOf)]);
    return r.stdout.trim().split(/\n\s*\n/).map((b) =>
      Object.fromEntries(b.split('\n').map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])));
  },
  // {unit, description, properties: ["User=www-data", ...], env: {K: "v"}, command}
  async start({ unit, description = '', properties = [], env = {}, command }) {
    unitOf(unit);
    if (!oneLine(description)) fail('bad description');
    if (!Array.isArray(properties) || !properties.every((p) => oneLine(p) && /^[A-Z][A-Za-z]{1,63}=/.test(p))) fail('bad properties');
    if (!env || typeof env !== 'object' || !Object.entries(env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && oneLine(v))) fail('bad env');
    if (typeof command !== 'string' || !command.trim() || command.includes('\0')) fail('command required');
    await exec('systemctl', ['reset-failed', '--', unit]); // clear a failed leftover; errors are fine
    const args = ['--quiet', `--unit=${unit}`, `--description=${description}`];
    for (const p of properties) args.push('-p', p);
    for (const [k, v] of Object.entries(env)) args.push(`--setenv=${k}=${v}`);
    await must('systemd-run', [...args, '--', '/bin/bash', '-c', command]);
    console.log(`[agent] started ${unit}`);
  },
  // wait (default): returns once the unit has stopped (it takes up to its TimeoutStopSec), at most STOP_TIMEOUT_MS.
  // wait: false: returns at once; the stop goes on here (the unit shows as deactivating until it is done).
  async stop({ unit, wait = true }) {
    unitOf(unit);
    const done = (async () => {
      await must('systemctl', ['stop', '--', unit], [0, 5], { timeoutMs: STOP_TIMEOUT_MS }); // 5 = not loaded, already stopped
      await exec('systemctl', ['reset-failed', '--', unit]);
      console.log(`[agent] stopped ${unit}`);
    })();
    if (wait) return done;
    done.catch((e) => console.log(`[agent] stopping ${unit} failed: ${e.message}`));
  },
  async logs({ unit, lines }) {
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 5000);
    return (await must('journalctl', ['-u', unitOf(unit), '-n', String(n), '--no-pager', '-o', 'short-iso'])).stdout;
  },
};

// ---- connection to the server: reconnects forever (2 s, doubling up to 30 s) ----
let delay = 2000;
const retry = (why) => {
  console.log(`[agent] ${why}; retrying in ${delay / 1000} s`);
  setTimeout(connect, delay);
  delay = Math.min(delay * 2, 30000);
};
async function connect() {
  let ws;
  try { ws = await wsConnect(); } catch (e) { return retry(`could not connect (${e.message})`); }
  // Hello at once (the server allows 10 s); GPU stats follow with the first push.
  ws.send(JSON.stringify({ type: 'hello', machine: os.hostname(), key: KEY, stats: stats() }));
  let busy = false; // skip a push while the previous one is still collecting (e.g. a slow nvidia-smi)
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { const s = await withGpus(); if (ws.open) ws.send(JSON.stringify({ type: 'stats', stats: s })); }
    finally { busy = false; }
  }, 5000);
  ws.on('message', async (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'welcome') { delay = 2000; return console.log(`[agent] connected to ${SERVER} as ${os.hostname()}`); }
    if (msg.type !== 'call') return;
    const reply = { type: 'result', id: msg.id };
    try {
      if (!Object.hasOwn(ops, msg.op)) fail(`unknown op ${msg.op}`);
      reply.data = (await ops[msg.op](msg.body || {})) ?? null;
    } catch (e) { reply.error = e.message; }
    if (ws.open) ws.send(JSON.stringify(reply));
  });
  ws.on('close', (code, reason) => {
    clearInterval(timer);
    retry(`disconnected (${code}${reason ? ' ' + reason : ''})`);
  });
}
if (args.run) connect();
