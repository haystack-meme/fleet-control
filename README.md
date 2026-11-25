# fleet-control

### Every machine, every service, one web page.

You have a few Linux boxes: a GPU server running a model, a desktop with a second card, a couple of small servers in
a closet. Each one runs a handful of long-lived things, like an inference server, an image generator, an API or a
bot. Keeping track of them means SSHing around, writing unit files, editing them by hand, forgetting which box runs
what, and wondering why the GPU is full.

**fleet-control puts all of it on one page.** Every machine is a live card with CPU, memory, disk and GPU gauges.
Under each machine are its services, with Start, Stop, Restart and Logs buttons. Write a command, pick a machine,
click Start, and it runs there as a proper systemd service. You don't log in to anything.

```
┌─ ● gpu-box ──────────────────────────────── 192.0.2.20 · up 12 d ─┐
│ CPU ▓▓░░░░ 23%  Mem ▓▓▓▓░░ 61%  RTX 3090 ▓▓▓▓▓░ 88% · 71°C · 150W │
│                                 VRAM     ▓▓▓▓▓▓ 22 / 24 GB        │
│ ● llama-server  v3  running · since 09:12   Stop  Restart  Logs   │
│ ○ comfyui       v1  inactive                Start  Edit  History  │
└───────────────────────────────────────────────────────────────────┘
```

## Why you'll like it

- **One page for the whole fleet.** Live CPU, memory, swap and disk for every machine, plus load, VRAM, temperature
  and power for **NVIDIA and AMD GPUs**, refreshed every 5 seconds. You can see at a glance which card is busy and
  what is running on it.
- **Services without unit files.** A service is a command, a machine, a user, a working directory, environment
  variables and a restart policy, plus any extra systemd setting you want (`SupplementaryGroups=video render`,
  `Conflicts=`, `MemoryMax=`, …). It runs as a real systemd unit, so you get systemd's process tracking, restarts
  and journal logs.
- **Every edit is versioned.** Each save keeps a full copy. See what changed between versions and roll back to any
  of them with one click.
- **Machines need no open ports.** Each machine's agent connects *out* to the server over an encrypted WebSocket,
  so you never have to open a firewall or forward a port.
- **Adding a machine takes one command.** Run it on the new machine and approve the machine on the page. Nothing runs
  on a machine until you approve it.
- **Tiny and dependency-light.** The server is one Node.js folder with two npm packages (`express`, `ws`) and its
  data in a single SQLite file built into Node. There's no database server, no Docker and no reverse proxy. The
  agent is **one JavaScript file** that uses only Node's built-in modules.
- **A public file drop, built in.** Put files in the server's `files/` folder and anyone on your network can browse
  and download them at `/files/`, over HTTPS or plain HTTP, with no password. It's handy for scripts, installers,
  models or anything else every machine needs to `curl`. The browsable index has folders, sizes, dates, sorting and
  download links.
- **Backup and restore from the browser.** Download the whole database as one file and upload it to restore.
- **Scriptable.** Everything on the page is also a JSON API with an API key.

Good for home labs, AI and GPU boxes, small studios and lab clusters, wherever "a few machines and a dozen services"
has outgrown SSH and notes but doesn't need Kubernetes.

## ⚠️ Warnings and disclaimers

Read this before installing.

- **This is remote root.** Anyone who signs in to the page or holds the API key can run **any command, as any user
  including root, on every approved machine.** Treat the web password and the API key like the root password of
  your whole fleet.
- **Trusted networks only. Do not expose it to the internet.** The password and the API key are the only protection.
  There is no rate limiting, no multi-user accounts, no two-factor sign-in and no audit trail beyond the server's log.
- **Anyone who can reach the server can enroll a machine.** A new machine stays *pending* and does nothing until you
  approve it. Only approve machines you recognise.
- **The certificate is self-signed.** Your browser will warn once. Each agent trusts the certificate it sees on its
  first install and refuses any other after that. The very first download of the agent (`curl -k`) is not checked,
  so do it on a network you trust.
- **Services don't start at boot.** They are transient systemd units: after a machine reboots, its services stay
  stopped until you start them from the page.
- **The public file folder is public.** Anyone who can reach the server can list and download everything in
  `files/`, including over unencrypted HTTP. Only put things there you'd hand to anyone on the network. (Hidden
  files and folders, whose names start with `.`, are never served. HTML files open sandboxed, so they can't act as
  the signed-in page. Set `FLEET_FILES_DIR=off` to turn the feature off.)
- **No warranty.** This is a small personal project, provided "as is" under the Apache-2.0 license. Back up your
  data (**Download backup**) and test it before relying on it.

## Getting started

### Requirements

- Linux with systemd on every machine, **Node.js 26 or newer** at `/usr/local/bin/node`.
- The server also needs `openssl` (to make its certificate on first start) and npm.

### 1. Install the server

```sh
sudo git clone https://github.com/haystack-meme/fleet-control.git /opt/fleet-control
cd /opt/fleet-control && sudo ./install.sh
```

`install.sh` checks the requirements, creates the system user `fleet`, installs the npm packages, gives `fleet` the
data folder (the code stays owned by root), installs and enables the `fleet-server` systemd service (HTTPS on port
443, port 80 redirects to it), starts it and waits until it answers. It prints the server certificate's fingerprint.

### 2. Set the password

Open `https://<server>/` right away. With no password set, the page asks you to choose one, and **the first person
to open it sets it.**

### 3. Add machines

On each machine (as root, with Node.js installed):

```sh
curl -sk https://<server ip>/install/fleet-agent.js -o /tmp/fleet-agent.js
sudo node /tmp/fleet-agent.js --install --server <server ip>
```

If the server's HTTPS port isn't 443, add it: `--server <server ip>:<port>` (and in the `curl` URL).

The machine appears under **New machines** on the page. Click **Approve**.

### 4. Add services

Click **New service**, then fill in a name, the machine, the command and the user to run it as, and click
**Start**. That's it.

### Day to day

- **Change the password:** **Password** in the page header (signs out every other session).
- **Forgot the password:** `cd /opt/fleet-control && sudo -u fleet node bin/admin.js clear-password` removes it and
  signs everyone out. The next person to open the page sets a new one.
- **Back up:** **Download backup** on the page (safe while the server runs). Restore with **Restore…**.
- **Update the server:** `cd /opt/fleet-control && sudo git pull && sudo ./install.sh`
- **Update an agent:** run the same `--install` command again. It keeps its key while the server still accepts it.
- **Share a file:** copy it into `/opt/fleet-control/files/` (subfolders work too). It's available at once at
  `http://<server>/files/` and `https://<server>/files/`, and from the **Public files** button on the page.
- **Logs:** `journalctl -u fleet-server` on the server, `journalctl -u fleet-agent` on a machine, **Logs** on the
  page for a service.

### Settings

All optional, in `.env` in the server folder (git-ignored), one `NAME=value` per line. Run `sudo ./install.sh` again
after changing them:

| Name | Default | |
|---|---|---|
| `FLEET_HTTPS_PORT` | `443` | if you change it, give agents `--server <ip>:<port>` |
| `FLEET_HTTP_PORT` | `80` | only redirects to HTTPS; `0` turns it off |
| `FLEET_HOST` | `0.0.0.0` | address to listen on |
| `FLEET_DATA_DIR` | `data` | where `fleet.db` and the certificate live |
| `FLEET_FILES_DIR` | `files` | the public file folder, browsable by anyone without a password; `off` turns it off ... |
| `FLEET_FILES_PATH` | `/files/` | ... at this path (over HTTPS, and over HTTP unless `FLEET_HTTP_PORT=0`) |

Everything the server keeps is in `data/`: the database `fleet.db` and the HTTPS certificate `tls.crt` + `tls.key`.
The public files are in `files/`. `install.sh` creates that folder owned by the user who ran `sudo`, so you can
drop files in without sudo.
The certificate is made on first start for the machine's hostname and IP addresses. To use your own, replace those
two files and restart (then re-install the agents; see below).

### How it works

- **fleet-server** keeps the machines, service definitions and their full history in one SQLite file, serves the
  page and API over HTTPS, and holds one WebSocket per connected agent.
- **fleet-agent** runs as root on every machine. It sends stats every 5 seconds and runs what the server asks.
  It only ever manages units named `fleet-<name>.service`. Starting a service runs
  `systemd-run --unit=fleet-<name>.service -p User=… -- /bin/bash -c <command>`.
- **Enrollment:** `--install` gets a one-time code (valid 1 minute) that becomes the machine's permanent key
  (`/etc/fleet-agent/key`). The server stores only its hash.
- **Certificate pinning:** the first `--install` saves the SHA-256 fingerprint of the server's certificate in
  `/etc/fleet-agent/server`, and from then on the agent only talks to a server presenting that certificate. If you
  replace the certificate on purpose, delete that file on each machine and run `--install` again.
- **Stop, restart and delete** answer at once. The page shows *stopping…* / *restarting…* until the service
  settles. A service that doesn't stop within 15 s is killed; set `TimeoutStopSec=` in its properties if it needs
  longer.
- **Backup file format:** gzip(database) followed by the SHA-256 of the gzip bytes. The plain database is
  `head -c -32 <file> | gunzip > fleet.db`.

### API

All endpoints except `/health`, `/login`, `/enroll` and `/install/*` need a signed-in session (cookie from `POST /login`)
or the API key, sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`. There is always exactly one key: a
random one is made the first time the server starts. See it, copy it or reroll it with **API key** on the page.

```sh
curl -k -H "Authorization: Bearer $FLEET_API_KEY" https://<server>/api/services
```

| Method | Path | |
|---|---|---|
| GET | `/api/machines` | machines with status (pending / approved / rejected), online, stats |
| POST | `/api/machines/{name}/approve`, `/reject` | decide on a machine |
| DELETE | `/api/machines/{name}` | remove a machine and its key |
| GET, POST | `/api/services` | list (with live status) / create |
| GET, PUT, DELETE | `/api/services/{name}` | read / save (new version) / delete (`?force=1` if its machine is unreachable) |
| POST | `/api/services/{name}/start`, `/stop`, `/restart` | control |
| GET | `/api/services/{name}/logs?lines=200` | journal |
| GET | `/api/services/{name}/versions` | history |
| POST | `/api/services/{name}/rollback` | `{"version": N}` |
| GET | `/api/api-key` | `{"key": "…"}`: the current API key |
| POST | `/api/api-key/reroll` | make a new key (`{"key": "…"}`); the old one stops working at once |
| POST | `/api/password` | `{"current": "…", "password": "…"}`: change the web password; signs out every other session |
| GET | `/api/backup` | backup file `fleet-<UTC time>.fleetbackup` |
| POST | `/api/restore` | body = a backup file exactly as downloaded (refused if changed): replaces machines, settings (incl. the password), services and their history; sessions are kept |

## Tests

- `npm test`: the whole REST API, end to end. It starts a throwaway server over real HTTPS, and scripted agents
  that speak the real protocol stand in for machines. It covers sign-in, the API key, machines, every service
  action and validation rule, versions and rollback, offline machines, backup and restore, and the public files.
  It needs no root and takes about a second.
- `sudo npm run test:live` (needs Docker): the real thing. It builds a fleet-server container with `install.sh`
  and three systemd containers enrolled with the real `fleet-agent --install`, then checks inside them what each
  API call actually did: users, folders, environment, restart policies, Conflicts=, stop timeouts, a machine
  rebooting, the server restarting, backup and restore, and certificate pinning. Afterwards it removes every
  container (`KEEP=1` leaves them running).

## Future work

Planned fixes and ideas, roughly in order. Details for the first two are in [TODO.md](TODO.md).

**Fixes**

- **CI:** a GitHub Actions workflow that runs `npm test` on every push.
- **Harden the server's systemd unit:** sandboxing (`ProtectSystem=strict` and friends).
- **Cap the size of restored backups** when they are decompressed.
- **Deleting a service waits for it to stop**, so a stop that fails on the machine can't leave it running untracked.

**Possible features**

- Start chosen services automatically when their machine boots.
- Alerts when a service fails or a machine goes offline.
- Live-following logs on the page.
- Charts of CPU, memory and GPU usage over time.
- Hostnames (not just IPv4 addresses) for `--server`.

## License

[Apache-2.0](LICENSE)
