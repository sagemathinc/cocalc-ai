# Scalable Architecture Remaining Checklist

Status: active checklist as of 2026-04-21.

This is the current execution checklist for finishing the scalable control-plane
work after the recent multibay auth/bootstrap work and the large project-host
runtime/lifecycle cleanup.

It is intentionally narrower and more current than:

- [scalable-architecture-implementation-plan.md](/home/user/cocalc-ai/src/.agents/scalable-architecture-implementation-plan.md)
- [phase-5-remaining-checklist-2026-04-13.md](/home/user/cocalc-ai/src/.agents/phase-5-remaining-checklist-2026-04-13.md)
- [project-host-daemon-upgrade-rollback-plan.md](/home/user/cocalc-ai/src/.agents/project-host-daemon-upgrade-rollback-plan.md)

## Current Assessment

The architecture is now well past the "does this basically work?" stage.

What is proven or substantially implemented:

- one-bay Rocket / Launchpad architecture is real enough to operate
- account home bay, project owning bay, and host bay can be different
- the browser can stay on one stable public URL while using a different
  account-home bay for the control-plane websocket/API
- wrong-bay auth recovery exists
- per-bay public DNS and seed-managed bay tunnel provisioning exist
- many major project-local runtime paths no longer hairpin through bays:
  - project log
  - touch
  - storage / disk usage
  - document activity / file-use
  - snapshot / backup reads
  - major CLI project operations
- 3-bay local development is automated and usable
- project-host runtime architecture is much stronger than before:
  - split daemon model exists
  - `host-agent` exists
  - automatic rollback exists
  - desired runtime state exists
  - align-runtime-stack exists
  - runtime retention / rollback inventory is much better surfaced
- the major project-host performance regression was found and fixed:
  - btrfs qgroups were the wrong mechanism
  - simpler quota mode is the intended direction
  - the sqlite locking issue affecting backend Codex turns was also fixed
- browser-to-project-host auth has been improved:
  - bay-minted token is now used to establish auth
  - project-host cookie auth carries reconnects afterward
  - this reduces bay load and removes a class of reconnect complexity
- spot-instance support now exists and materially improves the production cost
  story for project hosts

Recent 3-way fixture validation:

- on 2026-04-20, a bay-1-owned project running on a bay-1 spot project-host was
  validated from bay-2 collaborator accounts through the stable multibay control
  path
- validated CLI paths:
  - remote collaborator listing
  - invite projection and redeem from bay-2
  - snapshot listing
  - storage summary
  - remote stop, start, and restart with LRO completion
- validated browser smoke paths:
  - bay-2 home-bay impersonation finishes back on the stable site URL
  - stable URL can open the bay-1-owned project as the bay-2 collaborator
  - browser opens a direct project-host session on the bay-1 host
- backup listing from a bay-2 collaborator against the bay-1-owned fixture now
  succeeds; attached bays delegate backup repo config to the seed bay, and the
  bay-1 project row records the returned seed repo id
- manual backup creation from a non-owning bay now returns a waitable source-bay
  LRO and delegates execution to the owning bay's backup worker; validated from
  bay-2 against the bay-1-owned fixture after redeploying hubs
- on 2026-04-21, the browser matrix was replayed against the stable
  `lite4b.cocalc.ai` fixture with account home bay `bay-1`, project owning bay
  `bay-0`, and host execution on `host2`:
  - stable URL sign-in to the project passed
  - stable URL reconnect / network flap passed and stayed on the stable origin
  - browser lifecycle `start`, `restart`, `stop`, and final `start` passed
  - browser terminal attach passed after both start and restart
  - browser terminal interactive smoke passed after removing the stale
    `reconnection:false` terminal-editor assumption: stream delivery, stdin,
    pty resize via `stty`, `sizes()`, resize broadcast, history, and cleanup
    all validated through the stable URL fixture
  - browser notebook runtime smoke passed: disposable notebook creation through
    routed project FS, Jupyter backend start through project API, raw routed
    `jupyter.project-*` socket execution, stdin request/response, output
    streaming, run completion, kernel status, and cleanup
  - browser app-server runtime smoke reached the disposable managed HTTP app,
    verified HTTP response delivery and app metrics updates, and found one
    important privacy/security bug: the short-lived project-host bearer query
    token could be forwarded to app code when an existing browser session cookie
    also authorized the request
  - after deploying the project-host HTTP proxy auth fix, the app-server runtime
    replay passed: the app response did not receive the bearer query token, HTTP
    response delivery worked, and request / bytes metrics were recorded
  - browser storage / snapshot / backup reads passed
  - browser invite redeem passed with cleanup
  - browser invite duplicate, revoke, already-collaborator, remove, and
    re-invite edge cases passed with cleanup
  - the reusable QA runner now prints lifecycle progress and bounds browser
    cleanup so long lifecycle runs are debuggable
- a fresh bay-2 sign-up replay was attempted on 2026-04-21 but the available
  registration token was exhausted; previous non-seed sign-up/sign-in
  validation remains the evidence for this item

What should still be treated as incomplete:

- inter-bay observability / replay / load-test readiness
- explicit completion of host placement and lifecycle validation under multibay
  failure modes
- 2FA / TOTP auth, which should be added later as a home-bay-owned auth layer
  and not as a project-host or cross-bay runtime concern
- account rehome workflow
- project rehome workflow

## Phase Summary

### Phases 0-4

Treat these as done enough for forward progress.

- foundations / measurement: done enough
- projection / routing groundwork: done enough
- one-bay Rocket / Launchpad mode: done enough

Open work here is mainly refinement, not phase-defining migration work.

### Phase 5: Inter-Bay Plumbing

Treat this as structurally advanced but not formally closed.

Core Phase 5 results that are now real:

- stable public URL + hidden account-home control-plane routing
- wrong-bay auth recovery
- seed-managed per-bay public endpoints
- explicit split between account/project ownership and host execution placement
- major remote collaborator and CLI plumbing

Phase 5 remaining work is now mostly:

- validation
- observability
- cleanup of leftover hidden one-bay assumptions

Auth note for later:

- 2FA should fit naturally into the stable-URL shell + home-bay auth-authority
  design
- TOTP secrets, backup codes, and challenge verification should be owned by the
  account home bay
- real session issuance should only happen after the home bay completes the
  second factor
- this should not change project-host routing or runtime placement logic

### Phase 6: Project Host Reachability And Placement

This phase moved forward substantially in the last few days.

The recent daemon/runtime work is not just "project-host polish". It is a real
piece of Phase 6 and of production-readiness in general.

Still, Phase 6 is not complete until:

- multibay start/stop/restart is validated in browser and CLI
- owning-bay vs host-bay failure behavior is validated
- host reachability and placement behavior is measured under load

### Phases 7-9

These remain future-facing:

- account rehome
- project rehome
- real multi-bay rollout / sizing guidance

Some groundwork exists, but the workflows do not.

## Exit Target For "Close Enough To Move On"

The scalable architecture should be considered ready to leave this phase of
work when:

- the browser-side multibay session/bootstrap model is validated enough that it
  no longer feels experimental
- project-host hot paths no longer depend on bays except for auth/routing
  metadata
- host runtime lifecycle is dependable enough for production-like operation
- inter-bay lag / replay / failure state is observable enough to operate
  safely
- there is a first believable multibay load story, not just architectural
  confidence

## What Remains

### 1. Close Browser Multibay Validation

- [x] replay the full browser-side multibay validation matrix against current
      code and current DNS/bootstrap behavior
- [x] validate sign-up for a non-seed home bay
- [x] validate sign-in for a non-seed home bay
- [x] validate invite / collaborator acceptance flow for a non-seed home bay
- [x] validate impersonation flow all the way back to the stable public URL
- [x] validate browser reconnect after network flap while staying on the stable
      public URL
- [x] confirm there are no remaining frontend bootstrap calls that still assume
      same-origin auth/session authority

Notes:

- the stable-URL + hidden-home-bay websocket trick appears to work in real
  testing and should now be treated as demonstrated
- invite projection/redeem has now been validated in both CLI and browser flows
- browser sign-in through the bay-2 home-bay impersonation retry path was
  validated and ended on `lite4b.cocalc.ai`, and browser project open reached
  the bay-1 project host
- the final sign-up replay could not create another user because the current
  registration token is exhausted; this is not a routing failure, but future
  QA should use disposable registration tokens so sign-up can be replayed
  without manual token management

### 2. Finish Remaining Runtime Bay-Hairpin Audit

The rule remains:

- interactive runtime traffic should be direct client -> project-host
- bays should provide auth, routing metadata, durable state, and orchestration

Remaining audit targets:

- [x] terminal creation / attach / resize / stream paths
- [x] notebook kernel / session / exec paths
- [x] app-server interactive reads / status paths
- [x] any remaining user-hot-path `hub.projects.*` runtime reads
- [x] convert browser filesystem/listing/storage/project-info wrappers away
      from implicit synchronous `routeSubject(...)` fallback
- [x] audit any remaining frontend code that can silently fall back to the default
      global Conat client instead of an explicit routed client

Notes:

- notebook runtime was validated on 2026-04-21 through the stable
  `lite4b.cocalc.ai` fixture with account home bay `bay-1`, project owning bay
  `bay-0`, and host execution on `host2`
- the reusable QA scenario creates a disposable `.ipynb`, derives the
  corresponding `.sage-jupyter2` syncdb path, starts the Jupyter backend via the
  routed project API, runs code over the routed `jupyter.project-*` socket,
  handles stdin, verifies output and `run_done`, reads kernel status, and cleans
  up both disposable files
- a missing Python kernelspec is now clearly exposed as fixture/image readiness,
  not as a multibay routing failure; the validated fixture has `python3`
  available
- app-server runtime QA now creates a disposable managed HTTP app through the
  routed project API, starts it, opens it through the project-host auth URL,
  verifies the response body, checks request/bytes metrics, and deletes the app
  afterward
- the first live app-server replay exposed that project-host bearer query tokens
  were forwarded to app code if a browser-session cookie authorized first; after
  deploying the project-host fix, the stable-URL replay passed with HTTP 200,
  no token leakage in the app-visible path, one private request recorded, and
  bytes sent metrics updated
- a 2026-04-21 frontend audit found no remaining `hub.projects.*` browser
  runtime-read path that is both user-hot and unrouted; chat archive/search and
  Codex credential project helpers are already in the project-host-routed
  `callHub(...)` whitelist, while remaining `hub.projects.*` call sites are
  metadata, lifecycle, collaboration, backup/snapshot orchestration, or LRO
  control-plane paths
- the remaining browser-side risk is the synchronous `routeSubject` fallback:
  project-subject calls route directly to the project-host only when project
  host routing info is already cached; if that info is cold, the default
  hub/home-bay client is still used implicitly
- a partial browser routing fix now makes `projectApi(...)` and
  `projectWebsocketApi(...)` explicitly warm project-host routing before use,
  and makes `primus(...)`, `terminalClient(...)`, and `routeSubject(...)` warn
  when they must fall back to the default hub client
- browser listing, project filesystem, storage/disk-usage, snapshot/backup
  archive reads, project-info, and project-status paths now explicitly warm
  project-host routing before constructing their low-level Conat clients; this
  closes the main known cold-host-info fallback in the user-visible runtime UI
- the async project-runtime batch now also warms project-host routing for
  shared project dstreams, Codex log AKV reads/deletes, chat project read-state,
  chat activity-log cleanup, Jupyter live-run/usage/run-code clients, recent
  document activity, and course file-use reads
- the final frontend fallback audit is now closed: account-local stores
  intentionally stay on the signed-in/home-bay browser client, while
  project-local runtime wrappers either explicitly warm routing or fail closed
  instead of silently using the default home-bay client
- syncdoc routing was validated live on 2026-04-21 with the reusable browser QA
  runner against both a seed-owned project and a bay-1 home/project case through
  `lite4b.cocalc.ai`; both syncstring and syncdb writes selected the project-host
  address and persisted to disk
- the final fallback audit found the remaining silent default-client project
  traffic in browser `ProjectClient` streaming file read/write and exec-stream
  helpers; those now obtain an explicit routed project client before sending
  project subjects
- synchronous project syncdoc factories now fail closed when `requireRouting` is
  set but project host routing metadata is cold, instead of returning the default
  home-bay Conat client; remaining default-client usages in chat draft and git
  review stores are account-local AKV state and intentionally stay on the
  account/home-bay client

### 3. Finish Project-Host Runtime Productionization

This is the major new area that changed in the last few days.

Current project-host runtime facts:

- the production shape is now an explicit host-local daemon stack:
  - `host-agent`: low-churn supervisor and local project-host rollback
    authority
  - `project-host`: main project runtime/control process
  - `conat-router`: managed local ingress/router process for project-host
    traffic
  - `conat-persist`: managed local persist daemon
  - `acp-worker`: policy-managed Codex/ACP worker component
- `project-host`, `conat-router`, and `conat-persist` use `restart_now`
  rollout semantics; `acp-worker` uses `drain_then_replace`
- `host-agent` has a separate pid/log/state file and should not depend on the
  candidate `project-host` process being healthy enough to roll itself back
- project-host rollback state is persisted in `host-agent-state.json` as
  last-known-good, pending rollout, and last automatic rollback metadata
- supervision events are persisted in `supervision-events.jsonl`; CLI log
  collection includes `project-host`, `conat-router`, `conat-persist`,
  `host-agent`, and `supervision-events`
- the daemon starts and health-checks the managed local router and persist
  before starting `project-host`; unhealthy project-host recovery preserves the
  auxiliary router/persist daemons
- daemon children are launched from the selected current project-host bundle,
  not from the host-agent's own bundle
- durable desired runtime deployment state, host overrides, rollback targets,
  runtime deployment status/history, and resume-default flows exist in the hub
  and CLI

- [x] codify and document that qgroups are not part of the intended production
      quota path
- [x] validate simple quota behavior under realistic host churn and snapshot
      load
- [x] fix project backup creation LRO routing when the caller bay is not the
      owning bay; the caller bay keeps the waitable source LRO while the owning
      bay queues and runs the actual backup
- [x] validate sqlite persistence/concurrency under Codex-heavy workloads after
      the recent locking fixes
- [x] write down the intended production runtime layout explicitly:
  - which daemons are essential
  - which can degrade independently
  - which state is persistent vs disposable
- [x] validate the implemented daemon split under adversarial live conditions:
  - `project-host` restart
  - `conat-router` restart
  - `conat-persist` restart
  - `acp-worker` crash / restart
  - `host-agent` rollback path
- [x] validate upgrade / rollback / resume-default flows on live hosts under
      actual background load
- [x] validate daemon restart ordering and operator UX under partial runtime
      failure

Notes:

- on 2026-04-21, a first live managed-daemon restart pass was run against the
  local 3-bay hub cluster after rebuilding and upgrading the online hosts:
  - selected project: `e9290ac6-1dda-4629-b9e0-19b162e6c108`
  - selected host: `london`
  - `project-host`, `conat-router`, `conat-persist`, and `acp-worker` were
    restarted one at a time through `cocalc host deploy restart --wait`
  - after each component restart, `cocalc project exec` against the running
    project succeeded
  - runtime deployment history showed each restart as a succeeded rollout with
    the requested component and reason
  - supervision events showed the expected managed daemon start events
- that pass found one operator-status bug: router/persist were healthy and
  running but reported `drifted` because their runtime version was inferred from
  the numeric bundle directory while desired state used the build id
- after normalizing current numeric project-host bundle versions to the current
  build id, `host deploy status` on the redeployed `host2` showed
  `project-host`, `conat-router`, `conat-persist`, and `acp-worker` all
  `running` and `aligned`
- this is good evidence for restart-only component rollout, but it does not yet
  close the full adversarial item because host-agent automatic rollback,
  browser-session recovery under load, and partial-failure UX still need live
  drills
- on 2026-04-21, a corrected background-load daemon restart drill was run
  against the local 3-bay hub cluster:
  - selected project: `abd37947-fd69-40ea-999c-190a9458e6b2`
  - selected host: `host2`
  - four async project exec jobs completed successfully while `project-host`,
    `conat-router`, `conat-persist`, and `acp-worker` were restarted through
    managed rollout operations
  - foreground exec remained usable after each restart
  - rollout operation ids:
    - `conat-persist`: `85b4c21a-4e4c-401b-89a0-43f8dfdf0c89`
    - `conat-router`: `28550f0e-7e6d-43c7-a2eb-8c2ed6105fa8`
    - `project-host`: `dbdd22ce-45a0-4075-948d-35cbf254e9c0`
    - `acp-worker`: `13e3c1f1-9234-40f4-90ed-6fc823e3344a`
- the browser-session recovery drill exposed two local QA/control-plane issues
  before the actual recovery test could run:
  - the hub daemon inherited project-scoped agent environment variables from
    the shell, causing spawned browsers to attempt auth against a stale project
  - `system.listBrowserSessions` treated a Conat `callMany` async iterable as a
    synchronous array and used `timeout` instead of `maxWait`, causing
    discovery hangs instead of bounded fanout
- after fixing those two issues, spawned Chromium still failed to register a
  browser heartbeat: HTTP requests authenticated with the CLI-minted
  `remember_me`, but the proxied `/conat` websocket reached the Conat server
  with no auth cookie. This was fixed in `96b7d62afd` by pinning spawned
  Playwright sessions to the target control-plane origin before app JavaScript
  runs; the underlying bug was local QA sessions accepting an account
  `home_bay_url` pointing at `https://lite4b.cocalc.ai`, then opening Conat
  against that external origin without the local `remember_me` cookie.
- after the spawned-browser control-plane pinning fix, browser-session recovery
  under background load was validated against the local 3-bay hub cluster:
  - selected project: `abd37947-fd69-40ea-999c-190a9458e6b2`
  - selected host: `host2`
  - spawned browser: `UuiQQBRKwf`
  - four async project exec jobs completed successfully while
    `conat-persist`, `conat-router`, `project-host`, and `acp-worker` were
    restarted through managed rollout operations
  - browser `workspace-state` and foreground project exec succeeded before and
    after each component restart
  - rollout operation ids:
    - `conat-persist`: `d8d24acf-eaea-474a-9623-840c08d5074d`
    - `conat-router`: `d4f84dcc-5103-4fa4-8075-6662e08cf1c7`
    - `project-host`: `d6a968de-868d-4b9c-8636-3841b7b33796`
    - `acp-worker`: `e0272d85-dae2-4c2a-89d7-c52a0df606df`
  - final host status showed all four managed components `running` and
    `aligned`
  - the spawned browser session was destroyed afterward
- a rollback drill under project exec load found a partial-failure UX bug:
  rolling `project-host` back to the previous retained version failed because
  the software URL returned 404, but desired component state had already been
  rewritten to the unavailable version. The host kept running the last known
  good daemon, but status showed persistent drift until restoring
  `--last-known-good`.
- the first rollback fix was incomplete: retained project-host versions should
  not go through software URL download at all. The retained-version rollback
  path now routes through the host SSH/bootstrap reconciler, which reuses the
  already-installed bundle on the host.
- the rollback wait path also ignored stale bootstrap failure metadata only
  after observing new bootstrap activity. This prevents a previous failed
  reconcile from making a newly-started rollback LRO fail before the host has
  done any new work.
- failed project-host SSH/bootstrap rollback now restores the previous desired
  project-host version, so a genuine rollback failure does not leave the host in
  persistent desired/current drift.
- on 2026-04-21, the retained-version project-host rollback was rerun against
  `host2`:
  - rollback operation `8a4c4379-aa09-4517-8768-355821cfde0e` succeeded from
    `1776809337586` to retained version `1776808579069`
  - status showed the project-host artifact current version at
    `1776808579069` with build id `20260421T215608Z-39cf7e213a49`
  - foreground `cocalc project exec` against
    `abd37947-fd69-40ea-999c-190a9458e6b2` succeeded while rolled back
  - restore operation `ad6a0a00-a9b4-4c87-83f2-55006192a1fc` upgraded back to
    `1776809337586`
  - final status showed `project-host`, `conat-router`, `conat-persist`, and
    `acp-worker` all `running` and `aligned`; foreground project exec succeeded
    after restore
- host SSH access for bootstrap reconcile is now owned by the host-owning bay
  instead of depending on manually-installed operator keys:
  - each bay lazily creates a persistent Ed25519 host-owner SSH identity under
    its secrets directory
  - bootstrap/provider metadata includes that public key along with existing
    `project_hosts_ssh_public_keys`
  - SSH bootstrap reconcile uses the generated private key explicitly with
    `IdentitiesOnly=yes`
  - existing GCP hosts are repaired before SSH fallback by updating instance
    `ssh-keys` metadata; host-control authorized-key repair remains a secondary
    best-effort path
- on 2026-04-21, the retained rollback drill was repeated after adding the
  owner-bay SSH identity:
  - the first attempt before provider metadata repair failed with
    `Permission denied (publickey)` while leaving `host2` restored/aligned
  - after adding the GCP metadata repair hook, operation
    `d295f170-4967-4b7f-aa71-9a015d745519` rolled `host2` back to
    `1776808579069`
  - hub logs showed `gcp.ensureSshAccess`, cloud-provider SSH repair,
    host-control key repair, and SSH bootstrap reconcile in that order
  - restore operation `6333d1c0-4757-4dbf-adcf-e5b65e22a394` returned `host2`
    to `1776809337586`; final status showed all managed project-host
    components `running` and `aligned`
- on 2026-04-22, partial runtime failure UX was validated on `host2` by
  terminating host-local auxiliary daemons out-of-band:
  - terminating `conat-router` left the other managed components running; the
    host-agent detected a stale pid file and restarted `conat-router` as pid
    `1971904`
  - terminating `conat-persist` likewise left the rest of the stack running;
    the host-agent detected the stale pid file and restarted `conat-persist` as
    pid `1973134`
  - `cocalc host logs --source supervision-events` exposed the useful operator
    trail: stale pid detection followed by managed component start events
  - final `host deploy status` showed `project-host`, `conat-router`,
    `conat-persist`, and `acp-worker` all `running` and `aligned`; foreground
    `cocalc project exec` against `abd37947-fd69-40ea-999c-190a9458e6b2`
    succeeded after each injected failure
- on 2026-04-22, Section 3 was closed for this phase based on the combined
  implementation and production-use evidence:
  - qgroups are explicitly not the production quota path; the code comments now
    document the simpler quota approach, and qgroups were empirically associated
    with lag/hangs
  - simple quotas have been used for several days, with spot checks comparing
    quota usage against actual usage showing reasonable results
  - sqlite persistence has held up under several days of Codex-heavy workloads
    after the locking fixes, with no recurring lock failures observed
  - managed daemon restart, browser recovery under load, retained rollback,
    owner-bay SSH bootstrap, and partial auxiliary-daemon crash recovery have
    all been validated enough to move on under the current deadline

### 4. Close Phase 6 Placement / Lifecycle Validation

- [x] validate 3-way `start`, `stop`, and `restart` in both browser and CLI
- [ ] validate behavior when the owning bay is healthy and the host bay is slow
- [ ] validate behavior when the host bay is healthy and the owning bay is slow
- [ ] validate behavior when the host bay is unreachable
- [x] validate LRO progress / errors across owning-bay and host-bay boundaries
- [ ] audit remaining assumptions that `project bay == host bay`
- [ ] measure host heartbeat / lifecycle traffic at realistic bay sizes

Notes:

- CLI remote `stop`, `start`, and `restart` were validated on 2026-04-20 with
  account home bay 2, project owning bay 1, and host bay 1
- browser lifecycle was replayed on 2026-04-21 with stable URL sign-in,
  `start`, terminal attach, `restart`, terminal attach, `stop`, and final
  `start`; it passed, but the full run is slow enough that the QA runner now
  emits lifecycle progress messages
- terminal socket automation found that forcing `reconnection:false` can strand
  the terminal socket before a routed project-host browser session is ready;
  the terminal editor should use the default terminal socket reconnection while
  still routing disconnects through the shared reconnect coordinator

### 5. Spot Instance Operational Readiness

Spot support is strategically important now and should be treated as first-class.

- [ ] document the intended spot-host lifecycle
- [ ] validate preemption / disappearance handling for spot-backed hosts
- [ ] validate project reassignment / recovery behavior when a spot host dies
- [ ] measure how much operator complexity spot instances actually add
- [ ] decide where spot is acceptable vs where on-demand is still required

### 6. Inter-Bay Observability And Replay

- [ ] expose operator-visible mapping for:
  - account -> home bay
  - project -> owning bay
  - host -> host bay
- [ ] expose inter-bay lag and backlog clearly enough to diagnose real issues
- [ ] expose replay state / stale directory state clearly enough to diagnose
      outages
- [ ] expose route-failure / stale-ownership / handoff errors in one place
- [ ] document fencing / replay behavior for:
  - ownership changes
  - host reassignment
  - future account rehome
  - future project move

### 7. Load-Test Readiness

The connection leak fix means future measurements should be much more
trustworthy than before. This is now high-value work.

- [ ] add repeatable N-bay load-test fixture setup on top of the current
      multibay dev harness
- [ ] create a canonical 3-bay load scenario:
  - many accounts on bay A
  - projects owned on bay B
  - hosts on bay C
- [ ] measure:
  - browser/bootstrap latency
  - project open latency
  - terminal/notebook latency
  - exec latency
  - inter-bay request volume
  - bay CPU / Postgres pressure
  - project-host daemon pressure
- [ ] specifically measure the impact of project-host cookie-based reconnect
      auth on bay traffic reduction
- [ ] write the first real sizing guidance for:
  - bays
  - project-hosts
  - spot vs on-demand mix

### 8. Bay Operations UI / Operator Surface

Bays are now production resources in the same sense that project hosts are
production resources. The current CLI/API work is useful, but production
operation should not depend on remembering ad hoc commands and reading logs.

The first browser UI should be intentionally non-fancy and mostly read-only,
probably under the existing admin surface. It should make bay state visible and
provide copy/pasteable CLI commands for risky mutating operations until those
operations have enough validation to deserve direct buttons.

Initial read-only page:

- [ ] add an admin bay list page showing bay id, role, public URL, tunnel/DNS
      state, software version, uptime/heartbeat, and whether the bay accepts new
      ownership
- [ ] add a bay detail page showing owned accounts, owned projects, owned hosts,
      active sessions/connections, and recent control-plane/inter-bay errors
- [ ] show projection/replay health: account-project index lag, collaborator
      index lag, notification index lag, replay backlog, and stale directory
      indicators
- [ ] show route/failure signals in one place: wrong-bay auth redirects, stale
      ownership errors, handoff failures, and inter-bay RPC failures
- [ ] show backup/config health relevant to bays: seed-delegated backup repo
      config, bay-local config, public endpoint/tunnel state, and DNS state
- [ ] include copy/pasteable CLI commands for common operations:
  - `cocalc bay list`
  - `cocalc bay show ...`
  - `cocalc bay projection status-account-project-index ...`
  - `cocalc project rehome-drain --source-bay ... --dest-bay ...`
  - `cocalc project rehome-status --op-id ...`
  - `cocalc project rehome-reconcile --op-id ...`

Later mutating UI, only after the CLI/API paths are proven:

- [ ] mark a bay as accepting or not accepting new ownership
- [ ] dry-run and execute project ownership drains
- [ ] dry-run and execute future account/host ownership drains
- [ ] trigger projection drains/rebuilds with bounded limits
- [ ] restart/update bay software with explicit confirmation and status
      tracking

### 9. Account Rehome

This remains future work, but it is the next major workflow after Phase 5/6
close-out.

- [ ] account-write fencing
- [ ] home-state copy
- [ ] projection rebuild / copy
- [ ] directory update
- [ ] forced browser reconnection
- [ ] CLI workflow
- [ ] rollback / replay plan

### 10. Project Rehome

Project rehome is an invisible operator workflow for changing the bay that owns
project control-plane metadata. It is not a user-facing project data move. The
main production reasons to do it are:

- **maintenance drain:** a bay is old or unhealthy enough that we want to drain
  its project ownership and delete/recreate it instead of upgrading it in place
- **ops/load shedding:** a bay is approaching a control-plane load limit, so we
  move project ownership to other bays without moving project-host
  materialization

- [x] define terminology: **project rehome** means moving the authoritative
      project control-plane/metadata owner bay, while existing `project move`
      remains host-placement/data relocation
- [x] initial admin-only CLI workflow: `cocalc project rehome --bay ... --yes`
- [x] source bay sends the full project row to the destination bay before
      flipping `owning_bay_id`
- [x] destination bay accepts/upserts the authoritative project row, emits a
      project projection event, and drains local account-project projection rows
- [x] source bay flips `owning_bay_id` only after destination accept succeeds
      and updates its local account-project projection rows
- [x] durable per-project rehome operation record with explicit state machine:
      `requested -> destination_accepted -> source_flipped -> portable_state_copied -> projected -> complete`
- [x] idempotent reconcile command for stuck operation states, especially
      destination-accepted/source-flip-failed
- [x] batch/drain wrapper that groups many per-project rehomes into a bay drain
      or load-shedding campaign
- [x] bay admission control so an operator can mark a bay as "do not place new
      project ownership here" before draining existing ownership
- [x] copy portable bay-local project state during rehome; initially this means
      merging the `project-log` Conat stream into the destination bay after the
      source ownership flip and before projection completion
- [x] project fence / quiesce for concurrent metadata writes during rehome
- [x] live 3-bay happy-path validation for per-project rehome and projection
      convergence
- [x] rollback / retry plan for destination-accepted/source-flip-failed cases
- [x] failure-injection validation for destination-accepted/source-flip-failed
      cases and delayed projection convergence

Live 3-bay validation evidence, 2026-04-21 PT:

- Started the local 3-bay hub cluster and verified `bay-0`, `bay-1`, and
  `bay-2` were running and accepting project ownership.
- Created disposable project
  `4f9b5b19-69c8-4572-bafa-86452513f061`, initially owned by `bay-0`,
  then ran `cocalc project rehome --bay bay-1 --yes`. Operation
  `129fddf3-c2bd-44c5-99d6-35949923ce70` completed with
  `status=succeeded`, `stage=complete`, `portable_state_copied_at`,
  `projected_at`, and `finished_at` all set. `project where` reported
  `owning_bay_id=bay-1`, and `account_project_index` converged to `bay-1`.
- Created host-assigned disposable project
  `f389c8bb-6912-4c7c-88a4-ab86a542f701` on host
  `fe625be4-c86f-4fc4-b324-fda2f895e448`, initially owned by `bay-0`,
  then ran `cocalc project rehome --bay bay-2 --yes`. Operation
  `2cca11ff-d2df-41c6-9adf-f1aff63becf2` completed with
  `status=succeeded`, `stage=complete`, `portable_state_copied_at`,
  `projected_at`, and `finished_at` all set. `project where` reported
  `owning_bay_id=bay-2`, the host assignment was preserved, `project log`
  routed successfully after rehome, and `account_project_index` converged to
  `bay-2`.
- `cocalc project rehome-drain --source-bay bay-0 --dest-bay bay-2` dry-run
  returned five source-bay candidates and no errors. Running the same command
  from the seed while specifying `--source-bay bay-1` correctly failed because
  drain execution must happen on the source bay.
- Both disposable rehomed projects were cleaned up with
  `cocalc project delete --hard --purge-backups-now --wait --yes`; both delete
  operations completed with `status=succeeded`.

Retry / rollback plan, 2026-04-22 PT:

- Project rehome is intentionally forward-reconciled, not rolled back, once the
  destination bay has accepted the project row. The source bay remains the
  operation owner and durable source of retry state.
- `requested` failures are safe to retry because the destination accept upserts
  the same project row idempotently.
- `destination_accepted` failures are retried by flipping source ownership to
  the destination bay and then continuing with portable-state copy.
- `source_flipped` failures are retried by re-reading the preserved project row
  and copying portable bay-local state, currently the `project-log` stream.
- `portable_state_copied` failures are retried by updating local projection rows
  and draining projection state.
- `projected` failures are retried by marking the operation complete and
  appending the `project_rehomed` project-log evidence row on the destination
  bay.
- Operators can now inspect stuck operation state with
  `cocalc project rehome-status --op-id ...` and retry with
  `cocalc project rehome-reconcile --op-id ...`.
- Unit coverage now validates a failed `destination_accepted` operation can be
  inspected and then reconciled through source flip, portable project-log copy,
  projection, and completion.

Failure-injection validation, 2026-04-22 PT:

- Created disposable project `2e6b2a22-58d4-4023-aea7-7fcf75d01136` on
  `bay-0` and completed a normal rehome to `bay-1` with operation
  `c17ed624-d504-49c3-8ac9-8fe829141206`.
- Injected a source-flip failure by setting the operation to
  `status=failed`, `stage=destination_accepted`, rewinding the disposable
  project and account-project projection to `bay-0`, and setting
  `last_error='injected source flip failure for Section 9 validation'`.
  `cocalc project rehome-status --op-id ...` reported the failed
  `destination_accepted` state, then
  `cocalc project rehome-reconcile --op-id ...` completed the operation,
  advanced attempt count from 1 to 2, cleared `last_error`, and converged both
  project ownership and `account_project_index` to `bay-1`.
- Injected delayed projection convergence by setting
  `account_project_index.owning_bay_id=bay-0` and operation
  `status=failed`, `stage=portable_state_copied`, with
  `last_error='injected delayed projection convergence for Section 9 validation'`.
  `rehome-status` exposed the failed portable-state-copied stage, and
  `rehome-reconcile` completed the operation and restored
  `account_project_index.owning_bay_id=bay-1`.
- The disposable project was hard-deleted with
  `cocalc project delete --hard --purge-backups-now --wait --yes`; delete
  operation `a5f50644-0f9f-4567-b872-e585f815aedd` completed with
  `status=succeeded`.

### 11. Host Move / Reassignment

This is now a production-critical multibay workflow, not just a spot-instance
cleanup concern.

- **host rehome** means changing the authoritative bay that owns the
  `project_hosts` row and host-management authority. It does not move the
  host VM/container and does not move projects assigned to the host.
- **project evacuation** means moving projects off a host.
- **project move** remains project materialization/runtime placement movement.

- [x] define whether "host move" means host-bay ownership transfer, project
      evacuation/reassignment, or both
- [x] explicit operator confirmation for any operation that can strand or lose
      project data
- [ ] host/project fencing model during reassignment
- [x] directory update and projection convergence
- [ ] recovery behavior when the source host or source bay disappears mid-move
- [ ] rollback / retry plan
- [x] CLI workflow

Initial host rehome target:

- [x] admin-only CLI workflow:
      `cocalc host rehome <host> --bay ... --yes`
- [x] durable per-host rehome operation record with state machine:
      `requested -> destination_prepared -> destination_accepted -> source_flipped -> host_reconnected -> complete`
- [x] destination preparation before source flip:
  - destination bay has a host-owner SSH identity
  - host trusts the destination bay's host-owner SSH public key
  - destination bay can resolve and reach the host management endpoint
- [x] source flip changes only `project_hosts.bay_id`; assigned projects remain
      on the same host unless a separate evacuation/project-move operation is
      requested
- [x] post-flip validation waits for the host-agent/project-host heartbeat or a
      direct host-control status check to confirm the host is manageable via the
      destination bay
- [x] operator status/retry commands:
  - `cocalc host rehome-status --op-id ...`
  - `cocalc host rehome-reconcile --op-id ...`
- [ ] failure-injection validation for:
  - destination prepared but source flip failed
  - source flipped but host did not reconnect to destination bay
  - source flipped but projection/directory state is stale

Implementation checkpoint, 2026-04-22 PT:

- Added the first host rehome implementation slice:
  - hub RPCs `hosts.rehomeHost`, `hosts.getHostRehomeOperation`, and
    `hosts.reconcileHostRehome`
  - CLI commands `cocalc host rehome`, `cocalc host rehome-status`, and
    `cocalc host rehome-reconcile`
  - inter-bay host rehome RPCs for source-bay orchestration and
    destination-bay prepare/accept
  - durable `project_host_rehome_operations` state table
- Destination preparation installs the destination bay's host-owner SSH public
  key onto the host through the existing routed host-control API before
  changing ownership.
- Destination accept copies the `project_hosts` row to the destination bay with
  `bay_id` set to the destination; source flip updates the source row's
  `bay_id` only, leaving assigned projects untouched.
- Post-flip validation calls `getHostAgentStatus` through the routed host
  control client, which exercises the new owner-bay route.
- Remaining work is live 3-bay validation plus explicit failure injection.

Non-goals for initial host rehome:

- moving project data
- automatically evacuating projects from the host
- replacing project move
- handling source-bay disappearance before the destination bay has been
  prepared

## What Is No Longer A Priority Bottleneck

These should not distract the team unless they block one of the checklist items
above:

- abstract architecture debate about whether bays/project-host split is correct
- one-bay Launchpad cleanup for its own sake
- broad host daemon controller redesign beyond the current landed model
- polishing rare admin-only paths before load / lifecycle / validation work
- exotic public ingress ideas beyond the current stable-URL + per-bay endpoint
  model

## Recommended Next Order

1. Treat Section 2 and Section 3 as closed for this phase.
2. Keep Section 4/5 validation opportunistic, only when it blocks safe move
   semantics or exposes a production risk.
3. Start move workflow design and implementation now:
   - project rehome first, because it is the highest control-plane ownership
     workflow
   - host move/reassignment next, because project move needs clear host
     ownership and evacuation semantics
   - account rehome after the project/host data-safety model is explicit
4. Start real multibay load measurement in parallel when it can reuse the same
   move/recovery fixtures, rather than as a separate prerequisite.
