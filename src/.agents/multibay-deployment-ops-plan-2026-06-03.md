# Multibay Deployment And Operations Plan

Date: 2026-06-03

## Goal

Turn the current two-VM Bella experiment into a repeatable, testable multibay
deployment process for `cocalc.ai`.

The target is not "high availability" in the first release. The target is a
correct horizontally scalable control-plane architecture where:

- each bay is a clear operational unit;
- public ingress is separate from internal bay-to-bay traffic;
- inter-bay control traffic uses private cloud networking;
- local one-bay behavior keeps working when unrelated bays fail;
- adding a bay is automated and reversible;
- upgrades, static deploys, rollbacks, and health checks are scripted;
- load tests exercise the same topology we intend to run in production.

This plan is the deployment/ops companion to:

- [scalable-architecture.md](./scalable-architecture.md)
- [bay-systemd-deployment-plan.md](./bay-systemd-deployment-plan.md)
- [phase-5-inter-bay-plumbing-design.md](./phase-5-inter-bay-plumbing-design.md)
- [multibay-data-ownership-correctness-plan-2026-06-03.md](./multibay-data-ownership-correctness-plan-2026-06-03.md)

## Current Bella Baseline

As of 2026-06-03, `bella.cocalc.ai` has two GCP VM bays:

- `bella-bay-0`
  - bay id: `bay-0`
  - zone: `us-south1-a`
  - machine: `t2d-standard-4`
  - internal IP: `10.206.0.21`
  - external IP: `34.0.157.185`
- `bella-bay-1`
  - bay id: `bay-1`
  - zone: `us-south1-c`
  - machine: `t2d-standard-4`
  - internal IP: `10.206.0.22`
  - external IP: `34.0.146.0`

Both VMs are on the same GCP VPC/subnet and can reach each other by internal
IP. That only proves network adjacency.

They are not yet one CoCalc multibay cluster:

- each bay is configured as `COCALC_CLUSTER_ROLE=standalone`;
- each bay only lists itself in `COCALC_CLUSTER_BAY_IDS`;
- Postgres, Conat router, Conat persist, and hub workers bind to `127.0.0.1`;
- internal bay service ports are not reachable from the peer bay;
- there is no inter-bay routing, shared directory, peer health, or ownership
  routing.

This is the right starting point. The next work is to turn two standalone bays
on one private network into one explicitly configured multibay cluster.

## Product Assumptions

### Public Ingress

Use Cloudflare reverse tunnels for public ingress unless a concrete technical
blocker appears.

Reasons this is a good first-release default:

- no public VM ingress ports are required for the web app;
- TLS and hostname management are outside the VM lifecycle;
- it works across clouds without requiring provider-specific load balancers;
- it keeps the operator story close to the current Star/Launchpad simplicity.

Public ingress is for browser/API traffic. It is not the bay-to-bay transport.

### Internal Bay Traffic

Use internal GCP IPs for bay-to-bay control traffic.

Reasons:

- lower latency;
- lower cost;
- avoids public internet exposure for internal control-plane services;
- lets us enforce access with GCP firewall rules scoped to bay tags or service
  accounts.

Bay-to-bay control traffic should never depend on Cloudflare tunnels or public
DNS.

### Multibay Is Not HA

The first multibay release is for scale and operational isolation, not full high
availability.

Expected behavior:

- if a non-seed bay is down, users/projects/hosts owned by other bays should
  continue to work as much as possible;
- operations that need the down bay should fail clearly and locally;
- UI/API paths must not blindly enumerate all bays and turn one failed peer into
  a global outage;
- if the seed bay is down, seed-global operations can fail, but existing local
  bay operations should degrade as gracefully as the data model permits.

## Release-Blocking Milestones

### 1. Topology Model

Create one cluster topology source of truth.

It must describe:

- cluster id;
- seed bay id;
- all bay ids;
- each bay's internal address;
- each bay's public ingress identity;
- each bay's region/zone;
- each bay's role and state: `seed`, `attached`, `draining`, `disabled`;
- per-bay software release version.

Initial implementation can be a generated config file installed on every bay.
The longer-term model should be seed-authoritative and mirrored to attached
bays.

Exit criteria:

- `bay-status` prints local bay identity and cluster peers;
- every bay agrees on the same cluster id, seed bay, and peer list;
- topology changes are versioned or have an epoch.

### 2. Internal Network And Firewall

Bind only intentional inter-bay services to internal addresses.

Required work:

- decide the minimal internal ports for inter-bay Conat/router/control health;
- bind those services to the VM internal IP, not `0.0.0.0`;
- keep Postgres bay-local unless there is an explicit seed-global reason;
- create GCP firewall rules scoped by `cocalc-bay` tag or service account;
- keep SSH as an operator path, not an application dependency.

Exit criteria:

- peer health succeeds over `10.206.x.x`;
- required internal ports are reachable only from other bay VMs;
- unrelated public traffic cannot reach internal bay services;
- `ss -ltnp` on each VM clearly shows which services are loopback-only and
  which are internal.

### 3. Authenticated Inter-Bay Health RPC

Implement the smallest useful inter-bay RPC before product routing.

The first RPC should answer:

- bay id;
- cluster id;
- release id;
- local health;
- known peer topology epoch;
- seed connectivity status;
- current time, for skew detection.

It must be authenticated with a cluster secret or stronger mechanism. It must
not be browser-callable directly.

Exit criteria:

- `bay-health --peers` works from every bay;
- peer failures are reported as degraded peers, not process crashes;
- one down non-seed bay does not make the seed or another non-seed bay report
  itself unhealthy.

### 4. Inter-Bay Conat Routing

Move from "two local Conat islands" to a controlled inter-bay fabric.

This should follow
[phase-5-inter-bay-plumbing-design.md](./phase-5-inter-bay-plumbing-design.md):

- local-first by default;
- control-plane only;
- no project data-plane traffic through the inter-bay fabric;
- no unbounded global broadcast;
- explicit subject families for cross-bay RPC/events.

Exit criteria:

- a bay can call an allowed control-plane RPC on a peer bay;
- disallowed subject families are rejected;
- routing failure is observable and bounded;
- local-only operations remain local.

### 5. Ownership-Aware Routing

Make account, project, and host operations route by ownership.

Required ownership rules:

- account operations route to `home_bay_id`;
- project operations route to `owning_bay_id`;
- host operations route to `bay_id`;
- seed-global operations route to the seed bay;
- projections and caches can be local but must be rebuildable.

This work must follow
[multibay-data-ownership-correctness-plan-2026-06-03.md](./multibay-data-ownership-correctness-plan-2026-06-03.md).

Exit criteria:

- create accounts on both bays;
- create projects owned by both bays;
- from either frontend bay, start/stop/archive/restore a project on its owning
  bay;
- a failed peer only breaks operations whose authority is on that peer;
- tests fail when new durable state lacks an ownership class.

### 6. Browser Bootstrap And Public Ingress

Keep browser public ingress separate from internal bay routing.

Initial recommended shape:

- Cloudflare tunnel exposes `bella.cocalc.ai`;
- browser login/bootstrap resolves the account home bay;
- browser control connection is established to the home bay through public
  ingress;
- project runtime traffic remains direct to the project host when possible;
- internal bay-to-bay routing uses private IPs.

Open design question:

- whether Cloudflare routes all browser traffic to seed first, or can route to
  attached bays directly after bootstrap.

Pragmatic first step:

- route public traffic to seed;
- use seed for login/bootstrap and static serving;
- route control actions internally to owning/home bays;
- only optimize direct home-bay public ingress after the correctness model is
  working.

Exit criteria:

- a user can sign in at `https://bella.cocalc.ai`;
- account home bay is visible in diagnostics;
- projects on both bays are visible and operable;
- browser state remains understandable when one non-home bay is down.

### 7. Static And Backend Release Operations

Extend `scripts/bay-systemd` from one bay to a cluster.

Required operations:

- `status --all-bays`;
- `health --all-bays --peers`;
- `upgrade --bay <bay-id>`;
- `upgrade --all-bays`;
- `static-only --bay <bay-id>`;
- `static-only --all-bays`;
- `rollback --bay <bay-id>`;
- `rollback --all-bays`.

Static-only upgrades must remain restartless by default. Hub worker restarts
should be opt-in fallback behavior via `--restart-hub-workers`.

Static asset safety requirements:

- preserve hash-named chunks from previous releases;
- avoid deleting old frontend chunks while existing clients may still load them;
- make cleanup a separate retention policy, not part of the deploy flip.

Exit criteria:

- static-only deploy across both bays does not restart hub workers by default;
- old browser sessions can lazy-load chunks after a deploy;
- each bay reports active backend and static release ids;
- partial rollout is visible and reversible.

### 8. Add-Bay Automation

Automate the "add another bay" lifecycle.

Command shape can be refined, but should support:

```sh
./scripts/bay-systemd/create-gcp-bay.sh \
  --cluster bella \
  --bay-id bay-2 \
  --zone us-south1-b \
  --machine t2d-standard-4

./scripts/bay-systemd/attach-bay.sh \
  --cluster bella \
  --bay-id bay-2 \
  --remote ubuntu@<internal-or-public-ip>
```

The automation should:

- create VM and disk layout;
- install the bay bundle;
- install shared cluster secrets;
- assign bay id and region metadata;
- register with seed topology;
- configure internal firewall access;
- start systemd services;
- run local and peer health checks;
- leave the bay disabled until explicitly enabled for placement if needed.

Exit criteria:

- adding `bay-2` is one scripted path;
- the new bay appears in topology and peer health;
- the new bay can be disabled/drained without affecting existing bays.

### 9. Drain And Failure Behavior

Implement operational states before relying on multiple bays.

Bay states:

- `active`: accepts new accounts/projects/hosts according to placement policy;
- `no-new-placement`: keeps current work but receives no new placement;
- `draining`: actively moving owned accounts/projects/hosts away;
- `degraded`: health problem detected, avoid new placement;
- `disabled`: known offline or administratively removed.

Failure cases to test:

- non-seed bay down;
- seed bay down;
- inter-bay Conat broken;
- Cloudflare tunnel down for one ingress path;
- one hub worker down;
- one bay on an older release;
- one project host unavailable.

Expected non-seed-down behavior:

- unaffected account/project/host operations continue;
- project lists may show stale/degraded entries for affected projects;
- actions against the down bay fail with a clear bay-specific error;
- global "enumerate all bays" views tolerate missing peer responses.

Expected seed-down behavior:

- seed-global writes fail clearly;
- login/bootstrap may be unavailable if seed is the only auth ingress;
- already connected local bay sessions should keep local capabilities where
  possible;
- no attached bay should corrupt seed-global state while seed is down.

Exit criteria:

- failure behavior is documented in operator runbooks;
- automated smoke tests cover at least non-seed-down behavior;
- manual seed-down test has a known expected outcome.

### 10. Load Testing

Run load tests only after correctness and failure behavior are stable.

Load tests should cover:

- many active browser control connections;
- many accounts distributed across bays;
- many projects distributed across bays;
- project list projection/read behavior;
- cross-bay project operations from a non-owning bay;
- static-only deploy during active clients;
- one non-seed bay becoming unavailable during traffic.

Useful metrics:

- hub worker CPU/RAM;
- Conat message rate and latency;
- inter-bay RPC latency and failure rate;
- Postgres connection count and query latency per bay;
- browser reconnect and stale-state recovery;
- project start/stop latency by owning bay.

Exit criteria:

- load profile is repeatable from scripts;
- results distinguish per-bay local load from cross-bay load;
- the system degrades predictably when a non-seed bay is removed.

## Suggested Implementation Order

1. Document current Bella topology and make `bay-status` print cluster-relevant
   local facts.
2. Add cluster topology config generation.
3. Configure internal GCP firewall and service binding for one authenticated
   inter-bay health RPC.
4. Add `bay-health --peers`.
5. Add inter-bay Conat routing for one intentionally narrow subject family.
6. Route one low-risk ownership-aware operation across bays.
7. Expand routing to project lifecycle operations.
8. Add public Cloudflare tunnel ingress for Bella.
9. Add `--all-bays` upgrade/status/static-only operations.
10. Add automated "create/attach bay" scripts.
11. Run non-seed-down failure tests.
12. Run first load tests.

## Immediate Next Engineering Task

Implement the minimum cluster topology and peer health layer:

- config file on each bay listing `bay-0` and `bay-1` internal addresses;
- authenticated internal health RPC;
- `bay-health --peers`;
- GCP firewall rule for only the required internal service port;
- explicit status output proving traffic is private/internal.

Do not start by changing project routing. We need a reliable, observable
inter-bay transport and failure model first.
