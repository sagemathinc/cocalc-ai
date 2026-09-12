# CoCalc Launchpad - Operator Control Plane Reference

Launchpad packages the lower-level CoCalc control plane for operators and
developers configuring project-host connectivity and product settings. For a
single-machine appliance with local Postgres, a local project host, Caddy, and
web onboarding, start with [CoCalc Star](./star.md).

This is a source reference for Launchpad defaults, not a validated clean-machine
installation recipe. A build alone does not supply project-host storage,
provider credentials, or a working backup destination.

## Product and runtime selection

The Launchpad entry point defaults `COCALC_PRODUCT` to `launchpad` and
`COCALC_DB` to `pglite`. An explicitly configured database can use a different
backend, as Star does with local Postgres. The entry point enables the hub's
`/api/v2` HTTP API router.

The earlier `COCALC_LAUNCHPAD_MODE=onprem|cloud` selector and its Admin Settings
mode-selection step are no longer the configuration model. Local SSH/REST
services and configured Cloudflare connectivity are initialized by the current
Launchpad service setup; they are not two mutually exclusive product modes.
Cloud connectivity still requires its own valid site configuration.

Project execution is separate: normal Launchpad uses external project hosts.
`COCALC_PROJECT_RUNTIME=workspace` is an explicit local process mode for a
trusted machine. It is not container isolation for mutually untrusted users.
See [project runtime selection](../src/packages/project-runner/runtime-mode.ts).

## Ports and data directories

The entry point resolves an explicit base port from `COCALC_BASE_PORT`, then
`COCALC_HTTP_PORT`, then `PORT`. Without an override, it reuses the port stored
in `launchpad-port.json` under the data directory, or chooses and saves an
available port pair. It does not promise a fixed port 8443.

- The hub HTTP port is the selected base port.
- The SSH service defaults to base port plus one; `COCALC_SSHD_PORT` overrides it.
- Explicit or saved ports must be available. On a conflict, free those ports or
  provide a different pair; read the reported error before restarting.
- `COCALC_DATA_DIR` or `DATA` selects the data directory. With neither set, a new
  install uses `~/Library/Application Support/cocalc-launchpad` on macOS and
  `~/.local/share/cocalc-launchpad` elsewhere. Existing legacy data directories
  are reused when detected.
- PGlite data defaults to the `pglite` child of that data directory.

The startup summary prints resolved settings. Keep the data directory stable
when changing ports or upgrading; selecting a new directory selects different
local state.

These defaults are implemented in
[src/packages/launchpad/lib/onprem-config.js](../src/packages/launchpad/lib/onprem-config.js).
They differ from Star's appliance service configuration.

## Host connectivity

Use `COCALC_PUBLIC_HOST` for the hostname reachable by the intended clients.
`COCALC_LAUNCHPAD_HOST` and `COCALC_ONPREM_HOST` are deprecated fallbacks. A bind
address such as `0.0.0.0` is not a public hostname, and a reachable hostname does
not itself configure firewall rules, TLS, or provider access.

SelfHost can run directly on Linux or inside Multipass. The connector can use
SSH tunnels when the hub is not publicly reachable; see
[Self-Hosted Project Hosts](./self-host.md). Keep hub, connector, and project-host
addresses distinct when diagnosing a failed connection.

## Local backup transport

For a SelfHost machine using local backup configuration, the hub builds a
Rustic **REST** repository configuration. The host accesses the local REST
endpoint through the configured tunnel; this is not the old SFTP repository
path. Repository data lives below `COCALC_BACKUP_ROOT` (by default the data
directory's `backup-repo`), with the subpath selected by the configuration
builder. The local REST service defaults to port 9345, with explicit overrides.

The selected repository and password are supplied by the control plane. Do not
replace that configuration with an invented SFTP URL, or assume a local repo is
an independent off-machine backup. Inspect backup completion and verify a
restore before relying on a deployment's recovery procedure.

See [local repository configuration](../src/packages/server/launchpad/rest-repo.ts)
and [Project Backups](./project-backups.md).

## Developer entry points

Build and run commands, bundle output, and container packaging are in the
[Launchpad package README](../src/packages/launchpad/README.md). These commands
assume a prepared development workspace. For current service initialization,
see [onprem-sshd.ts](../src/packages/server/launchpad/onprem-sshd.ts); do not use
the removed mode-selection step as a prerequisite for host registration.
