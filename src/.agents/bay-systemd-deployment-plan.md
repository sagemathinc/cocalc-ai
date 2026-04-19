# Bay Systemd Deployment Plan

## Summary

For the release, each scalable bay should run as a **single deployable appliance
on one VM**, managed by `systemd`, with **multiple identical hub worker
processes** inside that VM.

This is intentionally **not Kubernetes**. The goal is:

- support more than one hub/node process per bay
- keep rollout and rollback understandable
- preserve a clear bay fault boundary
- avoid introducing a container scheduler and extra operational layers before
  release

The right release compromise is:

- **distribution unit**: one bay software bundle
- **deployment unit**: one bay VM
- **scaling unit**: replicated hub worker processes inside the bay
- **operator control plane**: explicit bay lifecycle and version management

## Goals

- One bay can use more than one hub/node process.
- A bay can be deployed, restarted, rolled back, and inspected with
  deterministic systemd-managed behavior.
- Postgres remains bay-local and explicit.
- The release path stays boring enough to operate under pressure.
- The bay remains a visible unit for fault isolation, backup, sizing, and
  rollout.

## Non-Goals

- No Kubernetes dependency before release.
- No attempt to unify bay deployment code with project-host runtime deployment
  before release.
- No generalized multi-role runtime controller refactor before release.
- No multi-VM bay sharding inside one bay for release 1.

## Core Design

Each bay VM runs these categories of services:

1. **Stateful singleton services**
   - `postgres`
   - bay-local durable event/projector services as needed

2. **Bay-local control/data-plane singleton-ish services**
   - `conat-router`
   - `conat-persist`
   - optional local ingress helper / tunnel sidecar if needed

3. **Replicated hub workers**
   - `N` identical node processes running the bay hub application
   - these are the scaling target

The bay is still one appliance:

- one versioned bundle
- one bay configuration
- one local Postgres
- one local log root
- one local backup scope

## Why Systemd

`systemd` is the right release mechanism here because it gives:

- process supervision
- restart policy
- dependency ordering
- templated units for worker replicas
- explicit service status and logs
- a predictable operator surface on a plain VM

It is enough for the current problem:

- we need **replicated hub workers**
- we do **not** yet need a cluster scheduler

## Bay VM Layout

### Users

- `cocalc-bay`: runtime user for bay services
- `postgres`: Postgres user, if using distro Postgres

### Filesystem Layout

Suggested paths:

- `/opt/cocalc/bay/bundles/<version>/`
  - immutable installed bay bundles
- `/opt/cocalc/bay/current`
  - symlink to selected active bundle
- `/etc/cocalc/bay.env`
  - operator-managed bay config
- `/etc/cocalc/bay-workers.env`
  - worker-count and worker-specific tuning
- `/mnt/cocalc/bays/<bay-id>/postgres/`
  - Postgres data
- `/mnt/cocalc/bays/<bay-id>/logs/`
  - log root
- `/mnt/cocalc/bays/<bay-id>/run/`
  - pid/socket/runtime scratch
- `/mnt/cocalc/bays/<bay-id>/backups/`
  - local staging for backup work if needed
- `/mnt/cocalc/bays/<bay-id>/state/`
  - bay-local durable state not already in Postgres

### Bundle Contents

Each bay bundle should contain:

- hub application code
- bay router code
- bay persist code
- migration helpers
- health check helpers
- version metadata
- rollout helper scripts

The bundle should be self-describing:

- `version`
- build timestamp
- commit
- optional operator message

## Systemd Units

### Aggregate Target

- `cocalc-bay.target`

Purpose:

- one target that brings up the whole bay
- one obvious command to stop/start the bay

### Singleton Services

- `cocalc-bay-postgres.service`
- `cocalc-bay-conat-persist.service`
- `cocalc-bay-conat-router.service`
- `cocalc-bay-migrations.service` (oneshot)
- optional:
  - `cocalc-bay-cloudflared.service`
  - `cocalc-bay-nginx.service`
  - `cocalc-bay-exporter.service`

### Replicated Worker Service

- `cocalc-bay-hub@.service`

Example instances:

- `cocalc-bay-hub@1.service`
- `cocalc-bay-hub@2.service`
- `cocalc-bay-hub@3.service`
- `cocalc-bay-hub@4.service`

This is the key release feature:

- scale one bay by increasing the number of worker instances
- no scheduler required

### Optional Helper Target

- `cocalc-bay-hub-workers.target`

Purpose:

- group all hub worker instances together
- simplify start/stop/restart of the replicated layer

## Unit Dependencies

Recommended ordering:

1. `cocalc-bay-postgres.service`
2. `cocalc-bay-migrations.service`
3. `cocalc-bay-conat-persist.service`
4. `cocalc-bay-conat-router.service`
5. `cocalc-bay-hub@N.service`

Important points:

- hub workers should not start before Postgres and migrations are ready
- router should not report healthy until required backends are reachable
- worker instances should be restartable independently
- singleton services must not be casually restarted during low-disruption worker
  rollouts

## Scaling Model

For release, scaling a bay means:

- keep one VM
- increase CPU/RAM if needed
- increase `HUB_WORKER_COUNT`
- start more `cocalc-bay-hub@N` instances

This should be controlled by a small helper:

- `cocalc bay workers set <bay-id> --count N`

Internally, this can:

- render or update the worker instance set
- `systemctl enable --now cocalc-bay-hub@{1..N}`
- stop higher-numbered workers when scaling down

## Configuration

`/etc/cocalc/bay.env` should contain:

- `COCALC_BAY_ID`
- `COCALC_BAY_REGION`
- `COCALC_API_BASE_URL`
- `COCALC_PUBLIC_BASE_URL`
- `COCALC_POSTGRES_DSN`
- `COCALC_ROUTER_PORT`
- `COCALC_PERSIST_PORT`
- `COCALC_HUB_BASE_PORT`
- `COCALC_WORKER_COUNT`
- `COCALC_LOG_DIR`
- `COCALC_DATA_DIR`
- `COCALC_SOFTWARE_BASE_URL`
- auth/secrets references

Prefer:

- one operator-visible env file
- explicit version selection outside the env file
- no hidden magic defaults for critical ports/paths

## Ports

Suggested pattern:

- Postgres: local-only
- conat-persist: local-only
- conat-router: local-only unless it is the public entrypoint
- hub workers: local-only, one port per worker if needed
- one public entrypoint:
  - local nginx / router / cloudflared path

Do not expose every worker publicly.

## Logging

Use journald plus structured local log files where needed.

Minimum expectations:

- `journalctl -u cocalc-bay-*`
- per-service recent log inspection
- per-worker log visibility
- one bay-local event log for rollout/restart/health transitions

Suggested service identifiers:

- `bay-postgres`
- `bay-conat-persist`
- `bay-conat-router`
- `bay-hub-1`
- `bay-hub-2`
- etc.

## Health Checks

Each service needs a concrete health check:

- Postgres:
  - local connection succeeds
- conat-persist:
  - local readiness endpoint or RPC responds
- conat-router:
  - `/healthz` or equivalent responds
  - required upstreams are reachable
- hub worker:
  - worker process is alive
  - worker readiness endpoint or internal self-check succeeds
  - worker can reach Postgres and required local services

The bay overall is healthy only if:

- singleton services are healthy
- at least one hub worker is healthy
- ideally, the configured minimum worker count is healthy

## Rollout Semantics

### Low-Disruption Hub Rollout

For code that affects only hub workers:

1. install new bay bundle `X`
2. run migrations if safe and compatible
3. restart hub workers one by one onto `X`
4. keep router/persist/postgres running

This is the release-critical workflow.

### Full Bay Rollout

For code that affects router/persist or other shared bay services:

1. install new bundle `X`
2. run migrations
3. restart singleton services in the required order
4. restart hub workers

This is more disruptive and should be explicit.

### Postgres / Migration-Sensitive Rollout

For schema or stateful changes:

1. preflight backup check
2. verify migration compatibility
3. fence writes if needed
4. run migration
5. restart dependent services in order
6. verify health

This path must be much more conservative than project-host rollout.

## Rollback Semantics

Keep rollback explicit.

### Hub-Only Rollback

If a new hub-worker version is bad but singleton services are fine:

1. switch worker instances back to previous bundle
2. leave router/persist/postgres alone

### Full Bay Rollback

If singleton services are affected:

1. restore previous bundle selection
2. restart singleton services in order
3. restart workers

### Migration-Aware Rollback

If schema changes are not backward compatible:

- ordinary code rollback is not enough
- require either:
  - explicitly compatible migrations, or
  - restore from backup/PITR

This must be treated as a separate operator path.

## Backup and Recovery

Per bay:

- Postgres backup is mandatory
- WAL/archive/PITR if possible
- enough metadata to know:
  - bundle version
  - config version
  - migration level

Minimum release requirement:

- verify one documented restore path for one bay
- do not ship a bay appliance without a believable restore procedure

## Operator Surface

The operator needs a small explicit command set.

Examples:

- `cocalc bay start <bay-id>`
- `cocalc bay stop <bay-id>`
- `cocalc bay restart <bay-id>`
- `cocalc bay status <bay-id>`
- `cocalc bay logs <bay-id> [--service ...]`
- `cocalc bay workers set <bay-id> --count N`
- `cocalc bay deploy workers <bay-id> --version X`
- `cocalc bay deploy full <bay-id> --version X`
- `cocalc bay rollback workers <bay-id> --version Y`
- `cocalc bay rollback full <bay-id> --version Y`

The CLI should speak in bay/operator language, not raw systemd internals, even
if `systemd` is the implementation underneath.

## Bay Drain Workflow

For major upgrades, risky reconfiguration, or structural changes, the safest
operator workflow may be:

1. create a new bay
2. drain the existing bay
3. delete the old bay

This should be a first-class supported path, not an improvised emergency move.

### What Draining Means

Draining a bay should mean:

- stop placing new accounts/projects/hosts onto that bay
- stop assigning new work there
- gradually evacuate or rehome what is already there
- keep the bay healthy and readable while it is draining
- make the drain state explicit in operator surfaces

In other words, draining is not “stop the VM.” It is controlled removal from
service.

### Bay Drain States

Suggested operator-visible states:

- `active`
  - normal placement allowed
- `cordoned`
  - no new placement, but existing workloads continue
- `draining`
  - explicit evacuation/rehome work is in progress
- `drained`
  - nothing active remains except what is required for inspection/cleanup
- `deleting`
  - final teardown in progress

### What Must Stop First

On entering `cordoned` or `draining`:

- new account home-bay assignment to this bay stops
- new project owning-bay assignment to this bay stops
- new host assignment to this bay stops
- new long-running background placement onto this bay stops

This must happen before any migration work starts, otherwise the bay keeps
refilling.

### What Gets Moved During Drain

Depending on the system state, draining may require:

- rehoming accounts to a new home bay
- moving projects to a new owning bay
- moving or reprovisioning hosts to a new bay
- waiting for transient work to finish

The exact mechanics may differ by object type, but the operator concept should
be one thing:

- “this bay is leaving service; move its owned work elsewhere”

### Safe Release-Oriented Drain Procedure

The release-safe pattern should be:

1. **Create the replacement bay**
   - provision VM
   - bootstrap bay software
   - verify health
   - verify backups
   - verify routing and auth

2. **Cordon the old bay**
   - stop new placements there
   - make this visible in CLI/UI

3. **Drain gradually**
   - rehome accounts
   - move projects
   - move/reassign hosts
   - monitor lag, failures, and workload counts

4. **Verify drained state**
   - no remaining active placements
   - no pending migrations
   - no backlog requiring the old bay

5. **Delete or archive the old bay**
   - final backup snapshot
   - disable routing
   - stop services
   - destroy VM or keep fenced for forensic retention

### Why This Matters

This gives a safer path for:

- major schema or deployment changes
- region moves
- instance type changes
- replacing a problematic bay appliance image
- escaping from a bay that has become operationally suspicious

The key point is that some changes are safer as **bay replacement** than as
in-place upgrade.

### Systemd Implications

Because the bay is a VM appliance under `systemd`, drain should be modeled above
the service manager:

- `systemd` manages the local processes
- the control plane manages whether the bay is eligible for placement and
  whether it is actively draining

So draining a bay should not initially stop services. It should first change
control-plane placement behavior.

Only near the end, when the bay is actually drained, should the operator stop:

- hub workers
- router/persist
- postgres

### Minimal CLI Surface

This suggests at least:

- `cocalc bay cordon <bay-id>`
- `cocalc bay drain <bay-id>`
- `cocalc bay uncordon <bay-id>`
- `cocalc bay delete <bay-id>`
- `cocalc bay show <bay-id>`

Where `bay show` should clearly answer:

- is the bay accepting new placement?
- is a drain in progress?
- how many accounts/projects/hosts remain?
- is it safe to delete?

### Recommended Release Policy

For release, explicitly support this conservative policy:

- **minor change**: worker-only or in-place bay rollout
- **moderate change**: in-place full-bay rollout
- **major/risky change**: create new bay, drain old bay, delete old bay

That gives operators a safe escape hatch without requiring Kubernetes-style
rolling infrastructure.

## Release Phases

### Phase 1: Single-VM Bay Appliance

Implement:

- bay bundle layout
- bay env/config file
- singleton services under systemd
- replicated hub workers under `cocalc-bay-hub@.service`
- health checks
- basic CLI wrappers

Success criteria:

- one bay can run on one VM
- one bay can run with more than one hub worker
- operator can restart one worker without restarting the whole bay

### Phase 2: Safe Rollout

Implement:

- low-disruption worker-only rollout
- full-bay rollout path
- previous-version rollback
- journald/log surfacing

Success criteria:

- a hub-only fix can be deployed with minimal disruption
- a bad worker build can be rolled back without touching singleton services

### Phase 3: Hardening

Implement:

- migration gates
- better health summaries
- backup/restore automation
- canary procedures

Success criteria:

- one bay can be upgraded confidently for release
- rollback story is explicit
- recovery story is believable

## What Not To Do Before Release

- do not introduce Kubernetes just to scale hub workers
- do not unify project-host and bay deployment systems at the implementation
  level yet
- do not make bay rollout depend on a generic framework that does not already
  exist
- do not make Postgres lifecycle “just another daemon”

## Relationship To Project-Host Runtime Work

The bay design should **borrow concepts** from the project-host deployment work:

- versioned bundles
- health-checked rollout
- explicit rollback
- retained versions
- operator-visible state

But it should **not** try to reuse the project-host runtime model directly
before release.

The reusable layer, later, is:

- bundle management
- service supervision helpers
- rollout/rollback state tracking
- retention policy

The bay-specific layer remains:

- Postgres lifecycle
- migration safety
- replicated hub worker management
- bay routing and backup contract

## Recommendation

For release:

- build a **systemd-managed bay appliance**
- support **replicated hub workers inside one bay VM**
- keep rollout semantics explicit:
  - worker-only
  - full-bay
  - migration-sensitive

This satisfies the real requirement:

- bays must scale beyond one node process

without taking on the cost and risk of a Kubernetes control plane before
release.
