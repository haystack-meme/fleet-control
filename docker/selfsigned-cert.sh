#!/bin/sh
# Runs before nginx starts (nginx image entrypoint). Creates a long-lived self-signed certificate once; agents use TLS
# for encryption only, so it doesn't need to be trusted. Set FLEET_CERT_NAMES (e.g. "IP:192.0.2.10,DNS:fleet") to put
# the server's addresses in it.
set -e
dir=/etc/nginx/certs
[ -s "$dir/fleet.crt" ] && exit 0
mkdir -p "$dir"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 2900000 -subj "/CN=fleet" \
  -addext "subjectAltName=${FLEET_CERT_NAMES:-DNS:fleet}" -keyout "$dir/fleet.key" -out "$dir/fleet.crt" 2>/dev/null
chmod 600 "$dir/fleet.key"
echo "fleet: created a self-signed certificate (${FLEET_CERT_NAMES:-DNS:fleet})"
