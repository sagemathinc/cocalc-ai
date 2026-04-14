# Project-Host Conat Service Split Plan

Status: proposed

Goal: split Conat router and Conat persist out of the main `project-host`
process on Linux project hosts, while keeping `cocalc-plus` and the general
`lite` stack on the current embedded all-in-one path.

This is a deployment/bootstrap split, not a redesign of Conat.

## Why This Is The Next Step

Current `project-host` is still too broad a process boundary. It hosts:

- main project-host control plane
- Conat router
- Conat persist
- ACP supervision
- file-server and project-local services

That means:

- a heavy persist/changefeed workload still appears as a `project-host` stall
- a router bottleneck still appears as a `project-host` stall
- ACP worker churn still drives load through the same process

We now need process boundaries that make overload attributable and contained.

## Scope Boundary

This plan is for:

- single-VM
- Linux-only
- `project-host`

This plan is not for:

- `cocalc-plus`
- macOS or Windows runtime management
- `src/packages/lite` as a general deployment target

The shared code in `src/packages/lite` and `src/packages/conat` must remain
portable. The deployment split belongs in `src/packages/project-host`.

## Hard Requirements

1. `project-host` must be able to run with external router and external persist.
2. `project-host` must still support the current embedded all-in-one mode.
3. `cocalc-plus` must remain simple and keep using embedded services by default.
4. Linux project hosts must use `systemd` under the `cocalc-host` user.
5. Router and persist must be separately observable:
   - distinct process ids
   - distinct logs
   - distinct health checks
6. The split must reuse existing Conat code paths as much as possible.

## Existing Building Blocks To Reuse

### Router

Router already exists as the normal Conat server bootstrap:

- [main.ts](/home/user/cocalc-ai/src/packages/project-host/main.ts)
- [server.ts](/home/user/cocalc-ai/src/packages/conat/core/server.ts)

Conat core server already has built-in local multi-process support:

- `localClusterSize`
- `clusterName`
- `systemAccountPassword`

See:

- [server.ts](/home/user/cocalc-ai/src/packages/conat/core/server.ts)
- [setup.ts](/home/user/cocalc-ai/src/packages/backend/conat/test/setup.ts)
- [benchmark.ts](/home/user/cocalc-ai/src/packages/backend/conat/benchmark.ts)

### Persist

Persist already has a clean backend bootstrap and a separate load-balancer
concept:

- [persist.ts](/home/user/cocalc-ai/src/packages/backend/conat/persist.ts)
- [server.ts](/home/user/cocalc-ai/src/packages/conat/persist/server.ts)
- [load-balancer.ts](/home/user/cocalc-ai/src/packages/conat/persist/load-balancer.ts)

This means we do not need to invent a new persist architecture. We need a
`project-host`-specific service wrapper around the existing server and
load-balancer pieces.

## Recommended Topology

### Router

Run one `router` service under `systemd --user`:

- one parent process
- `localClusterSize = N`
- Conat core server forks local worker nodes internally

Reason:

- simplest to bootstrap
- already supported by the current Conat server code
- no extra worker-manager code required in phase 1

### Persist

Run persist as:

- one `persist-lb` service
- `N` templated `persist@<id>` worker services

Reason:

- persist load balancing is already separate from persist storage handling
- systemd templates are simpler than building a custom Node parent that spawns
  persist workers
- worker ids are explicit and visible
- each persist worker has its own pid and log

Do not start persist inside `project-host` once external persist mode is
enabled.

## Why Router And Persist Should Be Split This Way

### Why Router Uses One Service With `localClusterSize`

Router already knows how to form a local cluster from one bootstrap process.
That is the shortest path to a multi-process router without new orchestration
code.

This avoids:

- writing a separate router cluster manager
- teaching systemd how router nodes find each other in phase 1

### Why Persist Uses `persist-lb` + `persist@.service`

Persist does not currently have the same built-in local worker-cluster
bootstrap that router has. However, it already has:

- worker server bootstrap
- separate id-based sharding
- separate load-balancer logic

That makes systemd templates the simplest clean runtime model.

## Deployment Modes

### Mode A: Embedded All-In-One

Default for:

- `cocalc-plus`
- local development unless explicitly opting into split services

Behavior:

- `project-host` starts embedded router
- `project-host` starts embedded persist

### Mode B: External Router Only

Intermediate migration mode.

Behavior:

- `project-host` uses external router
- `project-host` still starts embedded persist

Value:

- isolates router first
- lower migration risk

### Mode C: External Router And External Persist

Target mode for Linux production project hosts.

Behavior:

- `project-host` does not start router
- `project-host` does not start persist
- `project-host` connects to external router
- clients resolve persist through external persist load-balancer/workers

## New Project-Host Entry Points

Add these Linux-targeted entry points in `src/packages/project-host`:

- `conat-router-daemon.ts`
- `conat-persist-lb-daemon.ts`
- `conat-persist-worker-daemon.ts`

These are deployment wrappers only. They should contain minimal logic:

- parse env
- initialize auth/password/bootstrap
- start the corresponding Conat service
- install shutdown handlers
- log startup identity and health

They should not pull application logic out of `lite`.

## New Env Flags

Add explicit project-host-only env flags:

- `COCALC_PROJECT_HOST_EXTERNAL_CONAT_ROUTER=1`
- `COCALC_PROJECT_HOST_EXTERNAL_CONAT_PERSIST=1`

Optional routing/bootstrap settings:

- `COCALC_PROJECT_HOST_CONAT_ROUTER_URL`
- `COCALC_PROJECT_HOST_CONAT_ROUTER_PORT`
- `COCALC_PROJECT_HOST_CONAT_ROUTER_LOCAL_CLUSTER_SIZE`
- `COCALC_PROJECT_HOST_CONAT_CLUSTER_NAME`
- `COCALC_PROJECT_HOST_CONAT_SYSTEM_PASSWORD`
- `COCALC_PROJECT_HOST_PERSIST_SERVICE`
- `COCALC_PROJECT_HOST_PERSIST_IDS`

Rules:

- if external router flag is off, current behavior stays unchanged
- if external persist flag is off, current behavior stays unchanged
- `cocalc-plus` should never need to set these

## Phase Plan

### Phase 1: Extract Router Bootstrap

Implement:

- `conat-router-daemon.ts`
- `systemd` unit for router
- `main.ts` support for external router mode

Behavior:

- external router URL is set via env
- embedded router creation is skipped in external mode
- everything else remains the same

Validation:

- `project-host` boots and connects to router
- browser/project clients work
- router logs show cluster worker startup
- `project-host` no longer owns router process ids

### Phase 2: Extract Persist Bootstrap

Implement:

- `conat-persist-lb-daemon.ts`
- `conat-persist-worker-daemon.ts`
- `systemd` units:
  - `persist-lb`
  - `persist@`
- `main.ts` support for external persist mode

Behavior:

- embedded persist creation is skipped in external mode
- external persist workers connect to router
- load balancer shards by scope across worker ids

Validation:

- changefeeds work
- chat/editor/terminal sync work
- restart one persist worker and confirm recovery
- restart persist-lb and confirm client lookup recovers

### Phase 3: Project-Host Runtime Integration

Add:

- service status summary to project-host diagnostics
- external service startup checks
- clearer fatal startup errors when required services are missing

Optional:

- small local control script for `cocalc-host`
- log file conventions for each service

### Phase 4: Operational Hardening

Add:

- health endpoints or RPC for router and persist
- readiness gating in `project-host`
- restart/backoff policies in systemd
- per-service metrics and structured logs

## Changes To `project-host/main.ts`

Current `main.ts` embeds both router and persist directly.

That file should be changed so that:

- embedded router startup happens only in embedded mode
- embedded persist startup happens only in embedded mode
- external mode uses the configured router address and shared password
- downstream code does not need to know whether services are embedded or
  external

That means the abstraction boundary in `main.ts` should be:

- resolve Conat transport config
- start embedded services if configured
- otherwise connect to external ones

Do not scatter this decision throughout the codebase.

## Systemd Shape

Use user services under `cocalc-host`, not root system units.

Suggested units:

- `cocalc-project-host.service`
- `cocalc-project-host-conat-router.service`
- `cocalc-project-host-conat-persist-lb.service`
- `cocalc-project-host-conat-persist@.service`

Dependencies:

- `project-host.service` wants router
- in full external mode, `project-host.service` wants persist-lb and required
  persist workers
- router starts before persist-lb and persist workers

Use normal systemd controls for:

- `Restart=always`
- bounded restart backoff
- per-service logs
- explicit environment files

## Why This Does Not Harm `cocalc-plus`

Because the split is deployment-driven, not architecture-driven.

`cocalc-plus` can keep:

- embedded router
- embedded persist
- single-process simplicity

Nothing in this plan requires `cocalc-plus` to adopt:

- systemd
- Linux-only bootstrap
- multi-process service graphs

That is the key reason this should live in `src/packages/project-host`, not be
forced downward into `src/packages/lite`.

## What To Avoid

Do not:

- rewrite Conat for this split
- introduce Kubernetes for single-host project-host runtime
- build a generic service framework before proving the split
- force project-host Linux runtime assumptions into `cocalc-plus`

Do not make router and persist external everywhere by default on day one.

Keep embedded mode available and working.

## Recommended First Implementation Slice

Start with router only.

Why:

- lowest implementation risk
- existing built-in worker cluster support
- immediately separates a large class of Conat work from `project-host`

Then do persist next using `persist-lb` plus templated persist workers.

That sequence gives the best balance of:

- engineering simplicity
- operational visibility
- reduced ambiguity in future stall diagnosis

## Success Criteria

The split is successful when:

1. `project-host` can run without hosting router or persist.
2. `cocalc-plus` still runs in embedded all-in-one mode unchanged.
3. Router overload no longer appears as a generic `project-host` stall.
4. Persist/changefeed overload no longer appears as a generic `project-host`
   stall.
5. Future stall reports can be attributed to:
   - `project-host`
   - router
   - persist
     rather than one undifferentiated Node process.
