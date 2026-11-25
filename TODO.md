# To do

## Agent unit tests

`npm test` (also run by GitHub Actions on every push) covers the REST API end to end, and `sudo npm run test:live`
runs the real thing in Docker. Still missing: unit tests for the agent's WebSocket frame parser, its `--server`
argument parsing and its unit-file quoting (covered only indirectly by the live test).
