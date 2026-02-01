# CoCalc Hub (Launchpad / Rocket)

This package contains the main Hub process. It is not meant to be used
standalone; it is wired into the Launchpad and Rocket products.

The Hub serves:

- static content and Next.js pages
- browser ↔ project proxying (HTTP + websockets)
- project control (start/stop, LRO orchestration, backups/moves)
- Conat API + persistence services

## Local development (Launchpad)

Scripts are intentionally minimal and focus on Launchpad dev. Rocket runs via
Helm and does not use these scripts.

Default is **local network mode** (self‑contained). Cloud mode requires extra
Cloudflare + bucket config and is only for testing those paths.

Run with pglite (default):

```sh
pnpm app
```

Other variants:

```sh
pnpm app:pglite
pnpm app:pglite:cloud
pnpm app:postgres
pnpm app:postgres:cloud
```

Data dirs for these scripts are isolated by DB + mode:

```
src/data/app/pglite/local
src/data/app/pglite/cloud
src/data/app/postgres/local
src/data/app/postgres/cloud
```

You can override any of these with `DATA` or `COCALC_DATA_DIR`.

## Product and deployment mode

These scripts set:

- `COCALC_PRODUCT=launchpad`

Local mode is self‑contained. Cloud mode expects Cloudflare tunnels and a
remote rustic repo, and is not useful without that extra configuration.

## Ports and binding

- `PORT` controls the Hub HTTP(S) port (defaults to 5000).
- `HOST` controls the bind interface (defaults to `localhost` in these scripts).
- `BASE_PATH` can be used to serve the Hub under a sub‑path.

See [docs/launchpad.md](../../docs/launchpad.md) for the full Launchpad
architecture and TLS behavior in local‑network mode.
