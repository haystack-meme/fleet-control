# To do

## Agent unit tests

`npm test` (also run by GitHub Actions on every push) covers the REST API end to end, and `sudo npm run test:live`
runs the real thing in Docker. Still missing: unit tests for the agent's WebSocket frame parser, its `--server`
argument parsing and its unit-file quoting (covered only indirectly by the live test).

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
