# To do

## Tests and CI

There are no automated tests. Add a `node --test` suite (no extra dependencies) covering at least:

- service validation (`lib/services.js`: names, `run_as`, env, properties, reserved names)
- create / save / version history / rollback, including rollback to a version whose machine was removed
- backup and restore round trip, and refusal of changed or damaged backup files
- sign-in: first password, wrong password, password change, session expiry, API key and reroll
- enrollment: code expiry, activation, pending / approved / rejected, name collisions (`box`, `box-2`)
- the agent's WebSocket frame parser and `--server` argument parsing

Then a GitHub Actions workflow that runs it on every push, on Node 26.

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
