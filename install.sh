#!/usr/bin/env bash
# Installs (or updates) fleet-server from this folder as the systemd service fleet-server.service.
#
#   sudo git clone https://github.com/haystack-meme/fleet-control.git /opt/fleet-control
#   cd /opt/fleet-control && sudo ./install.sh
#
# It creates the system user "fleet" (if missing), installs the npm packages, gives that user the data folder
# (data/, or FLEET_DATA_DIR from .env), writes /etc/systemd/system/fleet-server.service for this folder, enables and
# (re)starts it, and waits until the server answers. Run it again after `git pull` to update.
set -euo pipefail

USER_NAME=fleet
UNIT=/etc/systemd/system/fleet-server.service
MIN_NODE=26
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

die() { echo "install.sh: $*" >&2; exit 1; }
step() { echo "==> $*"; }

[[ $EUID -eq 0 ]] || die "run it as root: sudo ./install.sh"
[[ -f "$APP_DIR/server.js" && -f "$APP_DIR/deploy/fleet-server.service" ]] || die "run it from the fleet-control folder"
[[ -d /run/systemd/system ]] || die "systemd is required"

NODE="$(command -v node || true)"
[[ -n "$NODE" ]] || die "Node.js $MIN_NODE or newer is required (none found)"
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
(( major >= MIN_NODE )) || die "Node.js $MIN_NODE or newer is required (found $("$NODE" --version) at $NODE)"
command -v npm >/dev/null || die "npm is required"
command -v openssl >/dev/null || die "openssl is required (the server makes its certificate with it)"
command -v curl >/dev/null || die "curl is required"

if ! id "$USER_NAME" &>/dev/null; then
  step "creating system user $USER_NAME"
  useradd --system --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "$USER_NAME"
fi
runuser -u "$USER_NAME" -- test -r "$APP_DIR/server.js" ||
  die "user $USER_NAME can't read $APP_DIR (is it inside a private home folder?): clone it to /opt/fleet-control instead"

step "installing npm packages"
(cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund --loglevel=error)

# Settings (.env) as the server will see them; this also checks them.
read -r DATA_DIR HTTPS_PORT HOST HTTP_PORT FILES_DIR FILES_PATH < <(cd "$APP_DIR" && runuser -u "$USER_NAME" -- "$NODE" -e \
  'const c = require("./lib/config"); console.log(c.dataDir, c.httpsPort, c.host, c.httpPort, c.filesDir || "-", c.filesPath)' 2>/dev/null) ||
  die "bad settings in $APP_DIR/.env: $(cd "$APP_DIR" && "$NODE" -e 'try { require("./lib/config") } catch (e) { console.log(e.message) }')"

step "data folder $DATA_DIR (owned by $USER_NAME)"
install -d -m 700 -o "$USER_NAME" -g "$USER_NAME" "$DATA_DIR"
chown -R "$USER_NAME:$USER_NAME" "$DATA_DIR"

if [[ "$FILES_DIR" != - && ! -d "$FILES_DIR" ]]; then
  # The public file folder: owned by whoever ran sudo, so they can drop files in without sudo; the server only reads it.
  owner="${SUDO_USER:-root}"
  step "public file folder $FILES_DIR (owned by $owner)"
  install -d -m 755 -o "$owner" -g "$(id -gn "$owner")" "$FILES_DIR"
fi
[[ "$FILES_DIR" == - ]] || runuser -u "$USER_NAME" -- test -r "$FILES_DIR" -a -x "$FILES_DIR" ||
  echo "warning: user $USER_NAME can't read $FILES_DIR, so the public files won't be served" >&2

# The unit's sandbox binds these paths in by name (space-separated lists), so they must be plain paths.
READ_ONLY_PATHS="$APP_DIR"
[[ "$FILES_DIR" == - ]] || READ_ONLY_PATHS+=" $FILES_DIR"
paths=("$APP_DIR" "$DATA_DIR" "$NODE")
[[ "$FILES_DIR" == - ]] || paths+=("$FILES_DIR")
for p in "${paths[@]}"; do
  [[ "$p" =~ ^/[^[:space:]#%]*$ ]] || die "the path \"$p\" has a space, # or %, which the service's sandbox settings can't hold: use another folder"
done

step "writing $UNIT"
sed -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@NODE@#$NODE#g" -e "s#@USER@#$USER_NAME#g" \
  -e "s#@DATA_DIR@#$DATA_DIR#g" -e "s#@READ_ONLY_PATHS@#$READ_ONLY_PATHS#g" \
  "$APP_DIR/deploy/fleet-server.service" > "$UNIT"
chmod 644 "$UNIT"
systemctl daemon-reload
systemctl enable --quiet fleet-server.service
systemctl restart fleet-server.service

step "waiting for the server"
[[ "$HOST" == 0.0.0.0 ]] && HOST=127.0.0.1
url="https://$HOST:$HTTPS_PORT"
for _ in $(seq 30); do
  curl -sfk --max-time 2 "$url/health" >/dev/null && break
  sleep 1
done
if ! curl -sfk --max-time 2 "$url/health" >/dev/null; then
  journalctl -u fleet-server.service -n 20 --no-pager >&2
  die "fleet-server did not answer at $url (log above)"
fi

fp="$(openssl x509 -in "$DATA_DIR/tls.crt" -noout -fingerprint -sha256 2>/dev/null | cut -d= -f2 || true)"
port_suffix=""; [[ "$HTTPS_PORT" == 443 ]] || port_suffix=":$HTTPS_PORT"
cat <<EOF

fleet-server is running and enabled at boot.
  Page:        https://<this machine's IP>$port_suffix/   (set the password there now: the first visitor sets it)
  Certificate: SHA-256 ${fp:-?}
               (agents print the fingerprint they pin on --install; it should match this)
$( [[ "$FILES_DIR" == - ]] || echo "  Public files: put them in $FILES_DIR; anyone can browse them at https://<this machine's IP>$port_suffix$FILES_PATH$( [[ "$HTTP_PORT" == 0 ]] || echo " (and http://<IP>$( [[ "$HTTP_PORT" == 80 ]] || echo ":$HTTP_PORT")$FILES_PATH)")" )
  Logs:        journalctl -u fleet-server
  Update:      cd $APP_DIR && sudo git pull && sudo ./install.sh
EOF
