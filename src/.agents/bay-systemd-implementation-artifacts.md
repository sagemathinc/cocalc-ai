# Bay Systemd Implementation Artifacts

## Purpose

This document turns the higher-level bay systemd deployment plan into a
concrete set of files and scripts that can actually be implemented.

It is still a plan, not a commitment to exact filenames forever, but it is
specific enough that somebody can start creating the files without inventing
the structure.

## Top-Level Principle

There should be three layers:

1. **Immutable bay bundle**
   - versioned code and helper scripts under `/opt/cocalc/bay/bundles/<version>`
2. **Operator-managed host configuration**
   - files under `/etc/cocalc/`
3. **Runtime state and logs**
   - files under `/mnt/cocalc/bays/<bay-id>/`

The systemd unit files should mostly be static. Bundle version changes should
not require rewriting the unit files.

## Files To Create

### Operator Configuration

- `/etc/cocalc/bay.env`
- `/etc/cocalc/bay-workers.env`
- `/etc/cocalc/bay-secrets.env`

### Systemd Units

- `/etc/systemd/system/cocalc-bay.target`
- `/etc/systemd/system/cocalc-bay-postgres.service`
- `/etc/systemd/system/cocalc-bay-migrations.service`
- `/etc/systemd/system/cocalc-bay-conat-persist.service`
- `/etc/systemd/system/cocalc-bay-conat-router.service`
- `/etc/systemd/system/cocalc-bay-hub@.service`
- `/etc/systemd/system/cocalc-bay-hub-workers.target`
- optional:
  - `/etc/systemd/system/cocalc-bay-nginx.service`
  - `/etc/systemd/system/cocalc-bay-cloudflared.service`
  - `/etc/systemd/system/cocalc-bay-exporter.service`

### Bundle Helpers

Inside `/opt/cocalc/bay/current/bin/`:

- `bay-preflight`
- `bay-postgres-check`
- `bay-migrate`
- `bay-conat-persist`
- `bay-conat-router`
- `bay-hub-worker`
- `bay-health`
- `bay-worker-health`
- `bay-rollout-workers`
- `bay-rollout-full`
- `bay-rollback-workers`
- `bay-rollback-full`
- `bay-scale-workers`
- `bay-status`

### Runtime State

- `/mnt/cocalc/bays/<bay-id>/state/current-version`
- `/mnt/cocalc/bays/<bay-id>/state/previous-version`
- `/mnt/cocalc/bays/<bay-id>/state/rollout-events.jsonl`
- `/mnt/cocalc/bays/<bay-id>/state/drain-state.json`
- `/mnt/cocalc/bays/<bay-id>/run/`
- `/mnt/cocalc/bays/<bay-id>/logs/`

## Environment Files

### `/etc/cocalc/bay.env`

This should contain bay-wide configuration:

- `COCALC_BAY_ID`
- `COCALC_BAY_REGION`
- `COCALC_BAY_PUBLIC_URL`
- `COCALC_BAY_INTERNAL_HOST`
- `COCALC_BAY_DATA_DIR`
- `COCALC_BAY_LOG_DIR`
- `COCALC_BAY_RUN_DIR`
- `COCALC_BAY_POSTGRES_HOST`
- `COCALC_BAY_POSTGRES_PORT`
- `COCALC_BAY_POSTGRES_DB`
- `COCALC_BAY_ROUTER_PORT`
- `COCALC_BAY_PERSIST_PORT`
- `COCALC_BAY_HUB_BASE_PORT`
- `COCALC_BAY_MIN_HEALTHY_WORKERS`
- `COCALC_BAY_SOFTWARE_BASE_URL`
- `COCALC_BAY_BUNDLE_ROOT`

This file should not contain secrets if that can be avoided.

### `/etc/cocalc/bay-workers.env`

This should contain worker-scaling and tuning settings:

- `COCALC_BAY_WORKER_COUNT`
- `COCALC_BAY_WORKER_CONCURRENCY`
- `COCALC_BAY_WORKER_MEMORY_MB`
- `COCALC_BAY_WORKER_NODE_OPTIONS`

### `/etc/cocalc/bay-secrets.env`

This should contain:

- database passwords if needed
- auth secrets
- signing keys
- cloud credentials references

Permissions must be strict:

- owned by root
- readable only by root and the service user if absolutely necessary

## Systemd Units

### `cocalc-bay.target`

Purpose:

- one aggregate target for the whole bay

Expected shape:

- `Wants=`:
  - `cocalc-bay-postgres.service`
  - `cocalc-bay-conat-persist.service`
  - `cocalc-bay-conat-router.service`
  - `cocalc-bay-hub-workers.target`
- optionally `nginx` / `cloudflared`

### `cocalc-bay-postgres.service`

Purpose:

- bay-local Postgres

Expected behavior:

- starts first
- has a preflight data-dir check
- writes to journald
- uses a fixed data dir under `/mnt/cocalc/bays/<bay-id>/postgres`

### `cocalc-bay-migrations.service`

Type:

- `oneshot`

Purpose:

- run bundle migrations against bay-local Postgres

Expected behavior:

- ordered after Postgres
- ordered before router/persist/workers
- exits successfully or blocks rollout

### `cocalc-bay-conat-persist.service`

Purpose:

- bay-local persist service

Expected behavior:

- starts after Postgres and migrations
- has readiness check
- restart policy should be aggressive but bounded

### `cocalc-bay-conat-router.service`

Purpose:

- bay-local router

Expected behavior:

- starts after persist
- readiness should verify required upstreams
- should not be considered healthy just because the process exists

### `cocalc-bay-hub@.service`

Purpose:

- one replicated hub worker instance

Expected instance parameter:

- `%i` is the worker number

Derived values:

- worker port = `COCALC_BAY_HUB_BASE_PORT + (%i - 1)`
- worker log identifier = `bay-hub-%i`

Expected behavior:

- starts after Postgres/migrations/router/persist
- restartable independently
- readiness check can be per-worker

### `cocalc-bay-hub-workers.target`

Purpose:

- group the currently enabled worker instances

Practical use:

- `systemctl restart cocalc-bay-hub-workers.target`
- or helper scripts manage explicit instance lists

## Helper Scripts

### `bay-preflight`

Checks:

- required env files exist
- directories exist and permissions look correct
- current bundle symlink exists
- required ports are free
- enough disk space

### `bay-postgres-check`

Checks:

- Postgres is reachable
- expected DB exists
- expected migrations table/schema exists

### `bay-migrate`

Responsibilities:

- run migrations once
- print migration target version
- fail clearly
- never silently auto-repair

### `bay-conat-persist`

Wrapper for the persist service:

- load env
- exec correct bundle binary
- tag logs consistently

### `bay-conat-router`

Wrapper for the router:

- load env
- exec correct bundle binary
- validate required upstream config

### `bay-hub-worker`

Wrapper for one worker:

- compute worker id and port
- load env
- set worker-specific identifier
- exec correct hub entrypoint

### `bay-health`

Bay-level readiness:

- Postgres healthy
- persist healthy
- router healthy
- at least `COCALC_BAY_MIN_HEALTHY_WORKERS` worker checks healthy

Output should be machine-readable enough for automation.

### `bay-worker-health`

Worker-level readiness:

- process reachable
- app readiness endpoint or internal check succeeds
- can reach Postgres/persist/router if required

### `bay-scale-workers`

Responsibilities:

- read desired worker count
- enable/start missing worker instances
- stop/disable extra worker instances
- update rollout event log

### `bay-rollout-workers`

Low-disruption worker-only rollout.

Responsibilities:

1. verify new bundle exists
2. record previous/current version
3. restart worker instances one by one
4. wait for worker health after each restart
5. stop on first failure
6. leave singleton services untouched

### `bay-rollout-full`

Full-bay rollout.

Responsibilities:

1. verify bundle
2. verify backup/migration safety
3. run migration
4. restart singleton services in order
5. restart worker instances
6. verify bay-level health

### `bay-rollback-workers`

Responsibilities:

- restore worker layer to previous bundle
- keep singleton services untouched

### `bay-rollback-full`

Responsibilities:

- restore previous bundle
- restart singleton services and workers in order

## Unit File Shape

Each service unit should use:

- `EnvironmentFile=/etc/cocalc/bay.env`
- `EnvironmentFile=-/etc/cocalc/bay-workers.env`
- `EnvironmentFile=-/etc/cocalc/bay-secrets.env`
- `User=cocalc-bay`
- `WorkingDirectory=/opt/cocalc/bay/current`
- `Restart=always` for long-running services
- `RestartSec=...`
- `StandardOutput=journal`
- `StandardError=journal`

Prefer wrappers in the bundle over large inline shell snippets in systemd unit
files.

## Suggested Unit Snippets

### Worker Template

Conceptually:

```ini
[Unit]
Description=CoCalc Bay Hub Worker %i
After=cocalc-bay-postgres.service cocalc-bay-migrations.service cocalc-bay-conat-persist.service cocalc-bay-conat-router.service
Requires=cocalc-bay-postgres.service cocalc-bay-conat-persist.service cocalc-bay-conat-router.service

[Service]
Type=simple
User=cocalc-bay
EnvironmentFile=/etc/cocalc/bay.env
EnvironmentFile=-/etc/cocalc/bay-workers.env
EnvironmentFile=-/etc/cocalc/bay-secrets.env
ExecStart=/opt/cocalc/bay/current/bin/bay-hub-worker %i
ExecStartPost=/opt/cocalc/bay/current/bin/bay-worker-health %i
Restart=always
RestartSec=2

[Install]
WantedBy=cocalc-bay-hub-workers.target
```

### Router Service

Conceptually:

```ini
[Unit]
Description=CoCalc Bay Conat Router
After=cocalc-bay-conat-persist.service
Requires=cocalc-bay-conat-persist.service

[Service]
Type=simple
User=cocalc-bay
EnvironmentFile=/etc/cocalc/bay.env
EnvironmentFile=-/etc/cocalc/bay-secrets.env
ExecStart=/opt/cocalc/bay/current/bin/bay-conat-router
ExecStartPost=/opt/cocalc/bay/current/bin/bay-health --router-only
Restart=always
RestartSec=2
```

The exact syntax may change, but the shape should stay this simple.

## Rollout Event Log

`/mnt/cocalc/bays/<bay-id>/state/rollout-events.jsonl` should record:

- timestamp
- actor
- action
- target version
- previous version
- scope (`workers` / `full`)
- result

This creates a minimal local audit trail even before richer control-plane
integration exists.

## Drain State File

`/mnt/cocalc/bays/<bay-id>/state/drain-state.json` should record:

- current bay state: `active|cordoned|draining|drained|deleting`
- when the state changed
- why
- optional remaining object counts

This does not replace the control plane, but it gives local visibility and a
place for helper scripts to write/read state.

## First Implementation Cut

If we want a short path to something real, start with:

- `cocalc-bay.target`
- `cocalc-bay-postgres.service`
- `cocalc-bay-migrations.service`
- `cocalc-bay-conat-persist.service`
- `cocalc-bay-conat-router.service`
- `cocalc-bay-hub@.service`
- `bay-migrate`
- `bay-conat-persist`
- `bay-conat-router`
- `bay-hub-worker`
- `bay-worker-health`
- `bay-rollout-workers`
- `bay-scale-workers`

That is enough to prove:

- one bay VM
- N worker processes
- worker-only rollout
- no Kubernetes

## Things To Keep Out Of The First Cut

- automatic multi-VM bay clustering
- over-abstracted shared runtime-controller code
- deep secret-management integration
- perfect control-plane/CLI integration
- fancy systemd code generation if static files are enough

## Recommendation

Implement the bay as:

- static systemd unit files
- bundle-provided wrapper scripts
- operator-managed env files
- one small set of rollout/scale scripts

That is the fastest route from design to something real and operable.
