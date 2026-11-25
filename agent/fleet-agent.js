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
// In --run mode it listens on nothing: it keeps one WebSocket open to the server (TLS for encryption only, the server's
// certificate is not checked), says hello with its key + hostname (the server identifies the machine by the key), pushes system + GPU stats every 5 s and runs the
// commands the server sends. It runs as root and only manages units named fleet-<name>.service.
const fs = require('node:fs');
const os = require('node:os');
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

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // TLS for privacy only: the server's self-signed certificate is accepted without checking

const KEY_FILE = '/etc/fleet-agent/key';
const readKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return null; } };

// Activate a new code: one hello with it (must happen within its 1 minute); resolves on welcome, rejects on refusal.
function activate(key) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${args.server}/agent`);
    const timer = setTimeout(() => { ws.close(); reject(new Error('no answer from the server')); }, 15000);
    ws.onopen = async () => ws.send(JSON.stringify({ type: 'hello', machine: os.hostname(), key, stats: await withGpus() }));
    ws.onmessage = (ev) => { if (JSON.parse(ev.data).type === 'welcome') { clearTimeout(timer); ws.close(); resolve(); } };
    ws.onclose = (ev) => { clearTimeout(timer); reject(new Error(`refused: ${ev.reason || ev.code}`)); };
  });
}

// ---- --install: enroll (or keep the existing key), copy this file into place, download the unit, enable + (re)start ----
if (args.install) (async () => {
  const JS = '/usr/local/lib/fleet-agent/fleet-agent.js', UNIT = '/etc/systemd/system/fleet-agent.service';
  const unitUrl = `https://${args.server}/install/fleet-agent.service`;
  if (process.getuid() !== 0) { console.error('--install must run as root (sudo)'); process.exit(1); }
  const res = await fetch(unitUrl).catch((e) => ({ ok: false, statusText: e.cause?.code || e.message }));
  if (!res.ok) { console.error(`could not download ${unitUrl}: ${res.status || ''} ${res.statusText}`); process.exit(1); }
  const unit = await res.text();
  if (!unit.includes('[Service]') || !unit.includes('@SERVER@')) { console.error(`${unitUrl} is not the fleet-agent unit template`); process.exit(1); }
  // An existing key is kept only if the server still accepts it (a removed machine's key is dead: enroll again).
  let keep = false;
  if (readKey()) {
    try { await activate(readKey()); keep = true; console.log(`keeping the existing key in ${KEY_FILE} (delete it to enroll as a new machine)`); }
    catch (err) { console.log(`the existing key no longer works (${err.message}): enrolling again`); }
  }
  if (!keep) {
    const e = await fetch(`https://${args.server}/enroll`, { method: 'POST' }).then((r) => r.json()).catch((err) => ({ error: err.message }));
    if (!e.code) { console.error(`could not enroll: ${e.error || 'no code'}`); process.exit(1); }
    try { await activate(e.code); } catch (err) { console.error(`could not activate the code: ${err.message}`); process.exit(1); }
    fs.mkdirSync('/etc/fleet-agent', { recursive: true, mode: 0o700 });
    fs.writeFileSync(KEY_FILE, e.code + '\n', { mode: 0o600 });
    console.log(`enrolled: key saved in ${KEY_FILE}`);
  }
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
const UNIT = /^fleet-[a-z0-9][a-z0-9-]{0,39}\.service$/;
const oneLine = (s) => typeof s === 'string' && !/[\0\r\n]/.test(s);
const fail = (msg) => { throw new Error(msg); };

function exec(cmd, args) {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 30000, maxBuffer: 16 << 20 }, (err, stdout, stderr) =>
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout, stderr })));
}
async function must(cmd, args, okCodes = [0]) {
  const r = await exec(cmd, args);
  if (!okCodes.includes(r.code)) fail(`${cmd} failed: ${(r.stderr || r.stdout).trim()}`);
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
const amdCards = fs.readdirSync('/sys/class/drm').filter((c) => /^card\d+$/.test(c)).map((c) => `/sys/class/drm/${c}/device`)
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
  const smi = await exec('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw', '--format=csv,noheader,nounits']);
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
  async stop({ unit }) {
    await must('systemctl', ['stop', '--', unitOf(unit)], [0, 5]); // 5 = not loaded, already stopped
    await exec('systemctl', ['reset-failed', '--', unit]);
    console.log(`[agent] stopped ${unit}`);
  },
  async logs({ unit, lines }) {
    const n = Math.min(Math.max(parseInt(lines, 10) || 200, 1), 5000);
    return (await must('journalctl', ['-u', unitOf(unit), '-n', String(n), '--no-pager', '-o', 'short-iso'])).stdout;
  },
};

// ---- connection to the server: reconnects forever (2 s, doubling up to 30 s) ----
let delay = 2000;
function connect() {
  const ws = new WebSocket(SERVER);
  let timer;
  ws.onopen = async () => {
    ws.send(JSON.stringify({ type: 'hello', machine: os.hostname(), key: KEY, stats: await withGpus() }));
    timer = setInterval(async () => { const s = await withGpus(); if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stats', stats: s })); }, 5000);
  };
  ws.onmessage = async (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'welcome') { delay = 2000; return console.log(`[agent] connected to ${SERVER} as ${os.hostname()}`); }
    if (msg.type !== 'call') return;
    const reply = { type: 'result', id: msg.id };
    try {
      if (!Object.hasOwn(ops, msg.op)) fail(`unknown op ${msg.op}`);
      reply.data = (await ops[msg.op](msg.body || {})) ?? null;
    } catch (e) { reply.error = e.message; }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(reply));
  };
  ws.onclose = (ev) => {
    clearInterval(timer);
    console.log(`[agent] disconnected (${ev.code}${ev.reason ? ' ' + ev.reason : ''}); retrying in ${delay / 1000} s`);
    setTimeout(connect, delay);
    delay = Math.min(delay * 2, 30000);
  };
  ws.onerror = () => {}; // onclose follows and handles the retry
}
if (args.run) connect();
