# fleet-control

Run and manage long-running commands on a fleet of Linux machines from one web page.

- **fleet-server** (Node.js, with its data in one SQLite file via Node's built-in `node:sqlite`) keeps the service definitions, their full version history and the list of
  machines, and serves the web page.
- **fleet-agent** is one self-contained JavaScript file (Node built-ins only) on every machine. It connects **out** to
  the server over an encrypted WebSocket, so machines need no open ports, and it starts and stops services as
  transient systemd units (`systemd-run`).

## What it does

- **Machines:** every machine shows CPU, memory, swap and disk gauges, plus GPU load and VRAM for NVIDIA (`nvidia-smi`)
  and AMD (`amdgpu` sysfs) cards, refreshed every 5 seconds.
- **Services:** a command, the machine it runs on, the user, working directory, environment, restart policy and any
  extra systemd properties (for example `SupplementaryGroups=video render` or `Conflicts=`). Start, stop, restart,
  logs (`journalctl`), edit, copy and delete from the page.
- **Version history:** every save is a new version with a full copy of the definition; any version can be rolled
  back to (which saves it as a new version).
- **Backup and restore:** download the whole database from the page and restore it from an uploaded file
  (running services are left as they are).
- **Enrollment and approval:** a new machine runs one command, gets a one-time code that becomes its permanent key,
  and waits for you to approve it on the page before anything runs on it.

## Requirements

- Linux with systemd on every machine, **Node.js 26.13.1 or newer** at `/usr/local/bin/node`.
- The server also needs `openssl` (to make its certificate on first start) and npm. No database server, web server or
  Docker: the whole server is this one folder.

## Install the server

```sh
# 1. a user for the server, and the code
sudo useradd --system --create-home --home-dir /var/lib/fleet fleet
sudo install -d -o fleet -g fleet /opt/fleet-control
sudo -u fleet git clone https://github.com/haystack-meme/fleet-control.git /opt/fleet-control
cd /opt/fleet-control && sudo -u fleet npm ci --omit=dev

# 2. the service: HTTPS on port 443, port 80 redirects to it
sudo cp deploy/fleet-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fleet-server
```

Then open `https://<server>/`: with no password set yet, the page asks you to choose one (the first person to open
it sets it, so do this right away).

Everything the server keeps is in `data/` in its folder: the database `fleet.db` and the HTTPS certificate
`tls.crt` + `tls.key`. The certificate is self-signed and made on first start for the machine's hostname and IP
addresses (browsers warn once); to use your own, replace those two files and restart.

**Settings** (all optional) go in `.env` in the folder (git-ignored), one `NAME=value` per line:

| Name | Default | |
|---|---|---|
| `FLEET_HTTPS_PORT` | `443` | |
| `FLEET_HTTP_PORT` | `80` | only redirects to HTTPS; `0` turns it off |
| `FLEET_HOST` | `0.0.0.0` | address to listen on |
| `FLEET_DATA_DIR` | `data` | where `fleet.db` and the certificate live |
| `FLEET_PUBLIC_DIR` | | a folder anyone can read without a password (file index, read-only) ... |
| `FLEET_PUBLIC_PATH` | `/files/` | ... at this path |

**Update:** `cd /opt/fleet-control && sudo -u fleet git pull && sudo -u fleet npm ci --omit=dev && sudo systemctl restart fleet-server`.
Logs: `journalctl -u fleet-server`.

## Adding a machine

On the new machine (as root, with Node.js installed):

```sh
curl -sk https://<server ip>/install/fleet-agent.js -o /tmp/fleet-agent.js
sudo node /tmp/fleet-agent.js --install --server <server ip>
```

It enrolls (one-time code, valid for 1 minute, becomes the machine's key in `/etc/fleet-agent/key`), installs itself as
`/usr/local/lib/fleet-agent/fleet-agent.js` with the `fleet-agent.service` unit, and starts. The machine appears under
**New machines** on the page: approve it there.

Run the same command again to update the agent; it keeps its key while the server still accepts it.

## How it works

- The agent runs as root and only manages units named `fleet-<name>.service`. Starting a service runs
  `systemd-run --unit=fleet-<name>.service -p User=… -- /bin/bash -c <command>` on its machine.
- Services are transient: after a machine reboots they are stopped until started again from the page.
- Stop, restart and delete answer at once: the page shows *stopping…* / *restarting…* and updates every 1.5 s until
  the service settles. A restart (stop, then start from the current definition) runs on the server in the background;
  if it fails, the error is shown on the service. A service that doesn't stop within 15 s is killed; set
  `TimeoutStopSec=` in its properties if it needs longer to shut down.
- The server stores only a hash of each machine key and of each session cookie. All data lives in one SQLite file
  (`data/fleet.db`); back it up with **Download backup** on the page (safe while the server
  runs) and restore it with **Restore…**. The file is gzip(database) followed by the SHA-256 of the gzip bytes; the plain
  database is `head -c -32 <file> | gunzip > fleet.db`.
- Everything is done on the page, including changing the password (**Password** in the header). The only
  command-line tool is for a forgotten password:
  `cd /opt/fleet-control && sudo -u fleet node bin/admin.js clear-password` removes
  it and signs everyone out; the next person to open the page sets a new one.

### API

All endpoints except `/health`, `/login`, `/enroll` and `/install/*` need a signed-in session (cookie from `POST /login`)
or the API key, sent as `Authorization: Bearer <key>` or `X-API-Key: <key>`. There is always exactly one key: a
random one is made the first time the server starts; see it, copy it or reroll it with **API key** on the page.

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
| GET | `/api/api-key` | `{"key": "…"}`: the current API key |
| POST | `/api/api-key/reroll` | make a new key (`{"key": "…"}`); the old one stops working at once |
| POST | `/api/password` | `{"current": "…", "password": "…"}`: change the web password; signs out every other session |
| GET | `/api/backup` | backup file `fleet-<UTC time>.fleetbackup`: gzip of the whole database + the SHA-256 of that gzip (last 32 bytes) |
| POST | `/api/restore` | body = a backup file exactly as downloaded (refused if the SHA-256 doesn't match): replaces machines, settings (incl. the password), services and their history; sessions are kept |
| GET | `/api/services/{name}/versions` | history |
| POST | `/api/services/{name}/rollback` | `{"version": N}` |

## Security model

This is built for a trusted home or lab network:

- The web password and the API key are the only protection for the page and API. Anyone who signs in, or has the
  key, can run any command, as any user (including root), on every approved machine.
- Anyone who can reach the server can enroll a machine; it does nothing until approved.
- Agents encrypt their connection but don't verify the server's certificate.

Don't expose it to the internet.

## License

[Apache-2.0](LICENSE)
