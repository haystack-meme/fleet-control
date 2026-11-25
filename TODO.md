# To do

## CI

`npm test` covers the REST API end to end (`test/api.test.js`) and `sudo npm run test:live` runs the real thing in
Docker (`test/live/`). Still missing: a GitHub Actions workflow that runs `npm test` on every push (Node 26), and
unit tests for the agent's WebSocket frame parser and `--server` argument parsing.

## Harden the server's systemd unit

fleet-server can run any command as root on every approved machine, so its own process should be locked down.
In `deploy/fleet-server.service` (the template `install.sh` fills in), add sandboxing such as:

```ini
ProtectSystem=strict
ReadWritePaths=/opt/fleet-control/data
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
LockPersonality=yes
```

(plus `ReadOnlyPaths=` for the public file folder, `FLEET_FILES_DIR`). Check that first-start certificate creation with
`openssl` still works under it.
