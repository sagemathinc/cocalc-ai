# Phase 5 Remaining Checklist

Status: active checklist as of 2026-04-13.

This is the short operational checklist for finishing Phase 5 of the scalable
control-plane work. It is intentionally narrower and more current than the main
implementation plan.

## Current Assessment

Phase 5 is no longer blocked on core architecture uncertainty.

What is now proven:

- account home bay, project owning bay, and host bay can be different
- a `bay-1` account can access a `bay-2` owned project running on a `bay-0`
  host
- browser control-plane bootstrap now supports:
  - one stable public site URL
  - per-bay public control-plane hostnames derived from site `dns`
  - wrong-bay auth recovery using `home_bay_url + retry_token`
- seed-managed bay DNS/tunnel lifecycle now works:
  - attached bays get managed Cloudflare tunnels from the seed
  - attached bays start local `cloudflared` automatically
  - stable bay hostnames are reconciled on the seed
  - the seed bay alias is served by the main launchpad tunnel
- direct project-host runtime paths now work for the major project-local
  surfaces that were migrated:
  - project log
  - touch
  - storage / disk usage
  - document activity / file-use
  - snapshot / backup reads
  - CLI `project start`
  - CLI `project exec`
- 3-bay local development is automated and usable

What is not finished:

- full end-to-end validation of browser/bootstrap/account-home routing
- full 3-way browser validation matrix
- lifecycle cleanup / hardening
- inter-bay observability, replay, and load-test hardening

## Exit Target

Phase 5 should be considered complete enough to move on when:

- browser session bootstrap always lands on the account home bay
- wrong-bay sign-in has a clear and correct recovery path
- the full 3-way user matrix is validated end to end
- no major interactive project-local path still unnecessarily hairpins through
  bays
- inter-bay routing, replay, and lag are observable enough to operate safely

## Checklist

### 1. Session And Bootstrap

- [x] Confirm the intended public-browser model is enforced:
  - one stable public URL
  - one account-home control-plane bay
  - direct project-host runtime connections remain separate
- [ ] Audit login/bootstrap code for any remaining assumptions that the current
  bay is also the account home bay
- [x] Implement or finish wrong-bay sign-in handling:
  - detect the mismatch early
  - redirect or recover without user confusion
  - avoid partial session state on the wrong bay
- [x] Implement seed-managed public bay endpoints:
  - stable bay hostnames derived from configured site `dns`
  - attached bays provisioned through seed-managed Cloudflare tunnels
  - seed bay alias served on the main launchpad tunnel
- [ ] Validate registration / invite / login flow with an account homed on a
  non-seed bay

### 2. Three-Way Browser Validation

Use this exact topology:

- `bay-0`: host bay
- `bay-1`: account home bay
- `bay-2`: project owning bay

Required checks:

- [ ] open project metadata
- [ ] file listing
- [ ] open a file
- [ ] edit and save a file
- [ ] collaborative editing between two accounts
- [ ] terminal
- [ ] notebook
- [ ] project log
- [ ] storage / disk usage
- [ ] snapshot reads
- [ ] backup reads
- [ ] start / stop / restart

Notes:

- use the existing real 3-way fixture project first
- only create new fixtures if the current one becomes too messy to trust
- public browser endpoints now exist for this topology:
  - stable site URL, e.g. `lite4b.cocalc.ai`
  - `bay-0-<dns>`
  - `bay-1-<dns>`
  - `bay-2-<dns>`
- for every failure, record whether it is:
  - control-plane routing
  - direct project-host auth
  - stale client caching
  - host-local runtime behavior

### 3. CLI Parity

- [x] `project where`
- [x] `project start`
- [x] `project exec`
- [x] `project file put/get`
- [x] `project log`
- [x] `project storage show`
- [x] `project backup` read path
- [ ] terminal-equivalent workflows through CLI where missing
- [ ] notebook workflows through CLI for the same 3-way topology
- [ ] explicit fixture helpers for:
  - create account on chosen bay
  - create project on chosen owning bay
  - assign to chosen host bay
  - add collaborator from another bay

### 4. Remaining Bay-Hairpin Audit

The rule is:

- interactive user runtime operations should be direct client -> project-host
- bays should provide auth, routing metadata, and durable control-plane state

Audit and either migrate or explicitly justify any remaining user-hot-path
operations that still go through a bay unnecessarily.

- [ ] terminal create/read/write paths
- [ ] notebook kernel/session exec paths
- [ ] app-server interactive status/read paths
- [ ] any remaining `hub.projects.*` runtime reads
- [ ] any remaining frontend code that falls back to a global/default Conat
  client instead of an explicit routed client

### 5. Lifecycle Hardening

Do not redesign lifecycle yet beyond what is needed for correctness, but finish
the current model enough that it is dependable.

- [ ] validate 3-way `start`, `stop`, and `restart` from both browser and CLI
- [ ] validate behavior when the host bay is reachable but the owning bay is
  slow
- [ ] validate behavior when the owning bay is available but the host bay is
  unreachable
- [ ] confirm LRO progress and error propagation remain correct across bays
- [ ] audit any remaining assumptions that `project bay == host bay`
- [ ] write down the later lifecycle redesign target explicitly:
  - bay owns desired state
  - host owns execution FSM
  - bay stores projected summary only

### 6. Inter-Bay Correctness And Observability

- [ ] expose enough operator-visible data to diagnose:
  - project -> owning bay
  - host -> host bay
  - account -> home bay
  - current bridge/fabric lag
  - route failures and stale-ownership errors
- [ ] ensure replay / fencing behavior is documented for:
  - ownership changes
  - host reassignment
  - account rehome
- [ ] add or finish metrics for:
  - inter-bay request counts
  - inter-bay request latency
  - bridge failures
  - queue / backlog depth
  - LRO forwarding failures

### 7. Load-Test Readiness

The architecture is close enough now that load testing becomes high value.

- [ ] add a repeatable N-bay fixture command set on top of the new dev cluster
  config
- [ ] create a canonical 3-bay load-test scenario:
  - many accounts on one bay
  - projects owned on another
  - hosts on a third
- [ ] measure:
  - bootstrap latency
  - project open latency
  - exec latency
  - inter-bay request volume
  - hub CPU / Postgres pressure
- [ ] record practical conclusions about whether additional migration off bays
  is needed before larger-scale testing

## Not Phase 5

These are important, but they should not delay closing Phase 5 unless they
block the above checklist:

- full lifecycle redesign
- broad production rollout automation
- account rehome as a polished routine operator workflow
- advanced load-harness UX
- deep cleanup of rare admin-only paths

## Immediate Next Recommendations

In order:

1. Finish the browser-side 3-way validation matrix.
2. Validate real sign-up / sign-in / invite flows for non-seed home bays.
3. Add explicit CLI fixture helpers for account/project/host topology setup.
4. Start the first real 3-bay load measurements.
