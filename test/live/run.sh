#!/usr/bin/env bash
# Live test on a Docker host: a fleet-server container installed with install.sh, three machine containers enrolled
# with the real fleet-agent --install, then test/live/live.test.js drives the API and checks inside the containers.
#   sudo test/live/run.sh          (KEEP=1 leaves the containers running afterwards)
#   sudo SETUP_ONLY=1 test/live/run.sh   only sets up the server and machines (approved: no) and leaves them running,
#                                        e.g. to try the API by hand; remove them with a normal run or docker rm -f
set -euo pipefail
[[ "${SETUP_ONLY:-}" == 1 ]] && KEEP=1
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
NODE_VERSION="$(node -p process.versions.node)"
IMG=fleet-live-test NET=fleet-live-test MACHINES=(m1 m2 m3)
log() { echo "==> $*"; }
cleanup() {
  [[ "${KEEP:-}" == 1 ]] && { echo "KEEP=1: containers left running"; return; }
  docker rm -f fleet-live-server "${MACHINES[@]/#/fleet-live-}" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
log "building the image (Node $NODE_VERSION)"
docker build -q -t "$IMG" --build-arg NODE_VERSION="$NODE_VERSION" test/live >/dev/null
docker network create "$NET" >/dev/null
run() { docker run -d --name "fleet-live-$1" --hostname "$1" --network "$NET" --privileged --cgroupns=private \
  --tmpfs /run --tmpfs /run/lock "$IMG" >/dev/null; }
boot() { for _ in $(seq 60); do s=$(docker exec "fleet-live-$1" systemctl is-system-running 2>/dev/null || true); [[ $s == running || $s == degraded ]] && return; sleep 1; done; echo "$1 did not boot" >&2; exit 1; }

log "server container: install.sh from this checkout"
run server; boot server
tar --exclude=node_modules --exclude=.git --exclude=data --exclude=files -cf - . | docker exec -i fleet-live-server bash -c 'mkdir -p /opt/fleet-control && tar -xf - -C /opt/fleet-control'
docker exec fleet-live-server bash -c 'cd /opt/fleet-control && ./install.sh' | sed 's/^/   /'
SERVER_IP="$(docker inspect -f "{{(index .NetworkSettings.Networks \"$NET\").IPAddress}}" fleet-live-server)"

for m in "${MACHINES[@]}"; do
  log "machine $m: fleet-agent --install --server $SERVER_IP"
  run "$m"; boot "$m"
  docker exec "fleet-live-$m" bash -c "curl -sk https://$SERVER_IP/install/fleet-agent.js -o /tmp/fleet-agent.js && node /tmp/fleet-agent.js --install --server $SERVER_IP" 2>&1 | grep -v '^Created symlink' | sed 's/^/   /'
done

if [[ "${SETUP_ONLY:-}" == 1 ]]; then
  log "set up: server https://$SERVER_IP (no password yet: the first sign-in sets it), machines ${MACHINES[*]} (pending)"
  log "certificate: docker exec fleet-live-server cat /opt/fleet-control/data/tls.crt"
  exit 0
fi
log "running test/live/live.test.js"
FLEET_LIVE_SERVER="https://$SERVER_IP" FLEET_LIVE_MACHINES="${MACHINES[*]}" node --test --test-concurrency=1 --test-reporter=spec test/live/live.test.js
