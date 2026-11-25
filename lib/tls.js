'use strict';
// The HTTPS certificate: data/tls.crt + data/tls.key. If they don't exist, a self-signed one is made on first start
// (with the openssl command) for this machine's hostname and IPv4 addresses. No authority vouches for it: browsers warn
// once, and each agent pins the certificate it saw on its first --install (replacing it means re-installing the agents).
// To use your own certificate, put it in those two files.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const config = require('./config');

const certFile = path.join(config.dataDir, 'tls.crt');
const keyFile = path.join(config.dataDir, 'tls.key');

function names() {
  const ips = Object.values(os.networkInterfaces()).flat().filter((a) => a.family === 'IPv4').map((a) => a.address);
  return [`DNS:${os.hostname()}`, 'DNS:localhost', ...new Set(ips)].map((n) => (n.startsWith('DNS:') ? n : `IP:${n}`));
}

function load() {
  if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    fs.mkdirSync(config.dataDir, { recursive: true });
    const san = names().join(',');
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
        '-days', '36500', '-subj', '/CN=fleet', '-addext', `subjectAltName=${san}`, '-keyout', keyFile, '-out', certFile],
      { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      throw new Error(`could not make a TLS certificate with openssl (${e.code === 'ENOENT' ? 'openssl is not installed' : e.stderr || e.message}); ` +
        `install openssl, or put a certificate in ${certFile} and its key in ${keyFile}`);
    }
    fs.chmodSync(keyFile, 0o600);
    console.log(`made a self-signed TLS certificate for ${san}`);
  }
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
}

module.exports = { load, certFile, keyFile };
