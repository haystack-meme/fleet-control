# fleet-control

Run and manage long-running commands on a fleet of Linux machines from one web page.

- **fleet-server** (Node.js + MariaDB) keeps the service definitions, their full version history and the list of
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
- **Enrollment and approval:** a new machine runs one command, gets a one-time code that becomes its permanent key,
  and waits for you to approve it on the page before anything runs on it.

## Requirements

- Linux with systemd on every machine, **Node.js 26.13.1 or newer** at `/usr/local/bin/node`.
- The server: either Docker with Compose, or MariaDB (10.11+) plus a TLS reverse proxy such as nginx.

## Quick start with Docker

Runs MariaDB, fleet-server and an HTTPS proxy (with a self-signed certificate made on first start):

```sh
git clone https://github.com/haystack-meme/fleet-control.git && cd fleet-control
cp .env.example .env
sed -i "s/^FLEET_DB_PASSWORD=.*/FLEET_DB_PASSWORD=$(openssl rand -hex 24)/" .env
docker compose up -d
docker compose exec server node bin/admin.js password '<your password>'
docker compose exec server node bin/admin.js default-user <user>   # Linux user services run as unless they name one
```

Then open `https://<server>/` and sign in. Data lives in the `db` volume, the certificate in `certs`. Ports and the
certificate's names can be set in `.env`. Only the server runs in Docker: the agents run directly on each machine
(see [Adding a machine](#adding-a-machine)).

## Server setup without Docker

```sh
# 1. a user for the server, and the code
sudo useradd --system --create-home --home-dir /var/lib/fleet fleet
sudo install -d -o fleet -g fleet /opt/fleet-control
sudo -u fleet git clone https://github.com/haystack-meme/fleet-control.git /opt/fleet-control
cd /opt/fleet-control && sudo -u fleet npm ci --omit=dev

# 2. database + login (edit the user name in the file if it isn't `fleet`)
sudo mariadb < sql/setup.sql

# 3. the service (tables are created on first start)
sudo cp deploy/fleet-server.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now fleet-server

# 4. web password, and the Linux user services run as unless they name one
sudo -u fleet node bin/admin.js password '<your password>'
sudo -u fleet node bin/admin.js default-user <user>

# 5. HTTPS in front of it: see deploy/nginx.conf.example
```

Then open `https://<server>/` and sign in.

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
- The server stores only a hash of each machine key and of each session cookie. All data lives in MariaDB; there are
  no data files.
- `node bin/admin.js machines | remove-machine <name> | password <pw> | default-user <user>` for the command line.

### API

All endpoints except `/health`, `/login`, `/enroll` and `/install/*` need a signed-in session (cookie from `POST /login`).

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

## Security model

This is built for a trusted home or lab network:

- The web password is the only protection for the page and API. Anyone who signs in can run any command, as any user
  (including root), on every approved machine.
- Anyone who can reach the server can enroll a machine; it does nothing until approved.
- Agents encrypt their connection but don't verify the server's certificate.

Don't expose it to the internet.

## License

[Apache-2.0](LICENSE)
