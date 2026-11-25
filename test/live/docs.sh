#!/usr/bin/env bash
# Runs every example in docs/API.md against a real fleet in Docker: a fresh server and three machines
# (test/live/run.sh SETUP_ONLY=1), then each Node example and the curl section, checking their output and what
# really happened on the machines. Removes the containers afterwards.
#   sudo npm run test:docs      (needs Docker and jq)
set -uo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"; W=$(mktemp -d); cd "$W"
pass=0; fail=0
ok()   { echo "  ✔ $*"; pass=$((pass+1)); }
bad()  { echo "  ✖ $*"; fail=$((fail+1)); }
check(){ local what=$1 pat=$2 out=$3; if grep -qE -- "$pat" <<<"$out"; then ok "$what"; else bad "$what: expected /$pat/, got:"; sed 's/^/      /' <<<"$out"; fi; }
dx()   { docker exec "fleet-live-$1" bash -c "$2"; }

echo "==> fresh fleet (server + m1 m2 m3)"
(cd "$REPO" && SETUP_ONLY=1 test/live/run.sh) 2>&1 | grep -E "^==> set up" || { echo "setup failed"; exit 1; }
IP=$(docker inspect -f '{{(index .NetworkSettings.Networks "fleet-live-test").IPAddress}}' fleet-live-server)
export FLEET_URL="https://$IP" FLEET_CA="$W/fleet.crt"
dx server 'cat /opt/fleet-control/data/tls.crt' > fleet.crt
COOKIE=$(curl -sS --cacert fleet.crt -c - -H 'Content-Type: application/json' -d '{"password":"docs-test"}' "$FLEET_URL/login" | awk '/fleet_sid/{print "fleet_sid="$7}')
export FLEET_API_KEY=$(curl -sS --cacert fleet.crt -b "$COOKIE" "$FLEET_URL/api/api-key" | jq -r .key)

echo "==> extract the examples"
node -e '
const md = require("fs").readFileSync(process.argv[1], "utf8");
let n = 0;
for (const [, code] of md.matchAll(/```js\n(\/\/ file: (\S+)\n[\s\S]*?)```/g)) { const name = code.match(/^\/\/ file: (\S+)/)[1]; require("fs").writeFileSync(name, code); n++; }
console.log(n + " files");' "$REPO/docs/API.md"
for f in *.js; do node --check "$f" && ok "syntax $f" || bad "syntax $f"; done

echo "==> machines and approval"
out=$(node machines.js 2>&1); check "machines.js lists 3 pending" "m1 +pending.*m2 +pending|m1 +pending" "$out"; [ "$(grep -c pending <<<"$out")" = 3 ] && ok "3 pending" || bad "3 pending: $out"
out=$(node approve.js m1 m2 m3 ghost 2>&1); check "approve.js approves" "m1: approved" "$out"; check "approve.js: unknown" "ghost: not enrolled" "$out"
out=$(node approve.js m1 2>&1); check "approve.js again" "m1: already approved" "$out"
sleep 6; out=$(node machines.js 2>&1); check "machines.js stats after approval" "m1 +approved +online .*cpu [0-9]+ %.*mem [0-9]+ %.*disk [0-9]+ %" "$out"
out=$(node order-machines.js 2>&1); check "order-machines.js" "^m1 > m2 > m3$" "$out"

echo "==> services"
out=$(node create-service.js m1 2>&1); check "create-service.js" "created demo-web v1 on m1 \(fleet-demo-web.service\)" "$out"
out=$(node create-service.js m1 2>&1); check "create-service.js again" "demo-web already exists" "$out"
out=$(node status.js 2>&1); check "status.js: stopped" "m1 +demo-web +v1 +stopped" "$out"
out=$(node start-and-wait.js demo-web 2>&1); check "start-and-wait.js waits for health (≥2 s)" "demo-web started and ready in ([2-9]|[1-9][0-9])\.[0-9] s" "$out"
check "the page really answers on m1" "hello from m1" "$(dx m1 'curl -s 127.0.0.1:18090/')"
out=$(node start-and-wait.js demo-web 2>&1); check "start-and-wait.js again" "already running" "$out"
out=$(node status.js 2>&1); check "status.js: ready" "demo-web +v1 +ready" "$out"
out=$(node update-and-restart.js demo-web '{"env":{"GREETING":"hi"}}' 2>&1); check "update-and-restart.js" "demo-web v2 is ready" "$out"
pid=$(curl -sS --cacert fleet.crt -H "Authorization: Bearer $FLEET_API_KEY" "$FLEET_URL/api/services/demo-web" | jq .status.pid)
check "new env reached the process" "GREETING=hi" "$(dx m1 "tr '\\0' '\\n' < /proc/$pid/environ")"
out=$(node update-and-restart.js demo-web '{"command":"echo broken config >&2; exit 3"}' 2>&1); rc=$?
[ $rc = 1 ] && ok "broken update exits 1" || bad "broken update exit $rc"
check "broken update: start_failed with exit status and logs" "did not come up \(start_failed\): restart failed: demo-web (failed|exited) \(exit status 3\)" "$(tr '\n' ' ' <<<"$out")"; check "broken update: log line shown" "broken config" "$out"
check "broken update: rolled back to v2, ready" "rolled back to v2's definition, and it is ready again" "$out"
check "after rollback it serves again" "hello from m1" "$(dx m1 'curl -s 127.0.0.1:18090/')"
out=$(node history.js demo-web 2>&1); check "history.js lists versions" "^v4 .*rollback of v2" "$out"; check "history.js: what changed" "v3 .*command" "$out"
out=$(node history.js demo-web 1 2>&1); check "history.js rollback + restart" "saved v1's definition as v5.*restarted" "$(tr '\n' ' ' <<<"$out")"
out=$(node logs.js demo-web 5 2>&1); check "logs.js" "python3|Serving|Started|fleet" "$out"; [ "$(wc -l <<<"$out")" -le 5 ] && ok "logs.js ≤ 5 lines" || bad "logs.js lines: $(wc -l <<<"$out")"
out=$(timeout 5 node logs.js demo-web --follow 2>&1); check "logs.js --follow prints" "." "$out"

echo "==> GPU switch (Conflicts both ways)"
for s in a b; do port=$([ $s = a ] && echo 18101 || echo 18102)
  curl -sS --cacert fleet.crt -H "Authorization: Bearer $FLEET_API_KEY" -H 'Content-Type: application/json' -d "{\"name\":\"gpu-$s\",\"machine\":\"m2\",\"run_as\":\"www-data\",\"command\":\"cd /tmp && exec python3 -m http.server $port --bind 127.0.0.1\",\"health_url\":\"http://127.0.0.1:$port/\"}" "$FLEET_URL/api/services" >/dev/null; done
out=$(node start-and-wait.js gpu-b 2>&1); check "gpu-b running first" "ready" "$out"
out=$(node switch-gpu.js gpu-a gpu-b 2>&1); check "switch-gpu.js gpu-a" "gpu-a: ready after .*; gpu-b: stopped" "$out"
out=$(node switch-gpu.js gpu-b gpu-a 2>&1); check "switch-gpu.js back" "gpu-b: ready after .*; gpu-a: stopped" "$out"
out=$(node switch-gpu.js gpu-a gpu-b 2>&1); check "switch-gpu.js again" "gpu-a: ready after .*; gpu-b: stopped" "$out"

echo "==> recipes"
out=$(node ensure-running.js demo-web gpu-a gpu-b 2>&1); rc=$?
check "ensure-running.js" "demo-web: already ready" "$out"; check "ensure-running.js reports each" "gpu-b: (started, ready|already ready)" "$out"; [ $rc = 0 ] && ok "ensure-running.js exit 0" || bad "ensure-running.js exit $rc: $out"
out=$(node ensure-running.js no-such 2>&1); rc=$?; check "ensure-running.js unknown" "no-such: not_found" "$out"; [ $rc = 1 ] && ok "ensure-running.js exit 1" || bad "exit $rc"
out=$(node retry.js demo-web 2>&1); check "retry.js" "demo-web: already running" "$out"
curl -sS --cacert fleet.crt -H "Authorization: Bearer $FLEET_API_KEY" -H 'Content-Type: application/json' -d '{"name":"svc-m3","machine":"m3","run_as":"www-data","command":"exec sleep infinity"}' "$FLEET_URL/api/services" >/dev/null
docker stop fleet-live-m3 >/dev/null
( node after-reboot.js m3 svc-m3 > after.out 2>&1; echo "rc=$?" >> after.out ) &
sleep 3; docker start fleet-live-m3 >/dev/null; wait
out=$(cat after.out); check "after-reboot.js waits for m3 and starts svc-m3" "m3 is online.*svc-m3: started, ready.*rc=0" "$(tr '\n' ' ' <<<"$out")"
docker stop fleet-live-m3 >/dev/null; sleep 2
out=$(node retry.js svc-m3 2>&1 & sleep 4; docker start fleet-live-m3 >/dev/null; wait); check "retry.js rides out machine_offline" "svc-m3: started" "$out"

echo "==> backup, restore, public files"
mkdir -p bk; out=$(node backup.js bk 2>&1); check "backup.js" "bk/fleet-[0-9]{8}-[0-9]{6}\.fleetbackup \([0-9]+ bytes\)" "$out"
f=$(ls bk/*.fleetbackup); [ "$(stat -c %a "$f")" = 600 ] && ok "backup file mode 600" || bad "mode $(stat -c %a "$f")"
out=$(node restore.js "$f" 2>&1); check "restore.js" "restored 3 machines and [0-9]+ services" "$out"; check "restore.js waits for the agents" "all machines are back online" "$out"
printf 'x' > broken.fleetbackup; out=$(node restore.js broken.fleetbackup 2>&1); check "restore.js refuses junk" "bad_backup" "$out"
dx server 'mkdir -p /opt/fleet-control/files/tools && echo "echo hello from setup" > /opt/fleet-control/files/tools/setup.sh'
out=$(node public-file.js tools/setup.sh 2>&1); check "public-file.js" "^echo hello from setup$" "$out"

echo "==> section 11 (curl)"
node -e 'const md=require("fs").readFileSync(process.argv[1],"utf8"); const s=md.slice(md.indexOf("## 11. Shell")); process.stdout.write(s.match(/```sh\n([\s\S]*?)```/)[1]);' "$REPO/docs/API.md" > curl-section.sh
out=$(bash curl-section.sh 2>&1); rc=$?
[ $rc = 0 ] && ok "curl section runs (exit 0)" || bad "curl section exit $rc"
check "curl: machines" "m1	approved	online" "$out"; check "curl: services" "m1	demo-web	true" "$out"; check "curl: start" "demo-web: ready=true changed=false" "$out"
check "curl: PUT answers a version" "^[0-9]+$" "$out"; check "curl: restore" '"ok":true' "$out"
F="$FLEET_URL/api"; H="Authorization: Bearer $FLEET_API_KEY"; C="--cacert $FLEET_CA"
for i in $(seq 30); do [ "$(curl -sS $C -H "$H" "$F/machines" | jq "[.[]|select(.online|not)]|length")" = 0 ] && break; sleep 1; done
out=$(curl -sS $C -H "$H" "$F/services/demo-web" | node -p 'JSON.parse(require("fs").readFileSync(0)).status.ready'); check "node -p one-liner" "^true$" "$out"

echo "==> cleanup"; docker rm -f fleet-live-server fleet-live-m1 fleet-live-m2 fleet-live-m3 >/dev/null; docker network rm fleet-live-test >/dev/null
rm -rf "$W"
echo "RESULT: $pass passed, $fail failed"
[ $fail = 0 ]
