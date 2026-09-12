# CoCalc Hub (Launchpad / Rocket)

This package contains the hub process used by Launchpad and Rocket. It serves
the public application shell and HTTP API, authorizes and routes Conat traffic,
and coordinates project lifecycle and persistence services. Normal project
file, terminal, notebook and agent traffic uses the project-host data plane;
this is not a promise that all project traffic is proxied through the hub.

## Local development

With workspace dependencies and build outputs prepared, run from
`src/packages/hub`:

```sh
pnpm app
```

`app` selects `app:pglite`. The available variants are:

```sh
pnpm app:pglite
pnpm app:postgres
```

These invoke [bin/start.sh](bin/start.sh), which sets
`COCALC_PRODUCT=launchpad` and starts the hub with `--all`. PostgreSQL mode
uses the local PostgreSQL bootstrap; PGlite mode uses an embedded database.
There are no `app:pglite:cloud` or `app:postgres:cloud` scripts.

The default data directories are:

```text
src/data/app/pglite
src/data/app/postgres
```

Set `DATA_BASE` to change their common parent. The script deliberately clears
inherited `DATA` and `COCALC_DATA_DIR` before deriving the mode-specific paths;
setting those two variables beforehand does not override this launcher. It
also clears inherited database and CLI targeting/authentication variables.
Reload the matching development environment before running CLI commands
against the started hub, as described in the root development instructions.

## Ports and deployment

`HOST` selects the launcher's bind hostname and defaults to `localhost`.
The hub's `PORT` defaults to `5000`. See
[the Launchpad reference](../../../docs/launchpad.md) for its related services,
port configuration and SSH access; a local hub start is not a tested public
or multi-host installation.

Rocket uses its own deployment configuration. These local scripts do not
install a Rocket deployment or configure a cloud provider.
