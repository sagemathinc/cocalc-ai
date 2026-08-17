# Signed-In Startup Retention Performance Plan

Date: 2026-08-11

Status: execution plan; instrumentation and staging work are the next steps.
Production experiments and rollout require review of staging evidence.

## Production Follow-Up: 2026-08-14

Production `ux_latency_events` were reviewed through 2026-08-14 23:30 UTC.
The route-aware and incomplete-start instrumentation has enough coverage to
identify the next engineering targets, but it does not yet establish that
startup latency causes the observed retention rate.

The frontend split produced a real payload improvement:

- median signed-in startup script bytes fell from 3.57 MiB on August 10-11 to
  about 1.73-1.74 MiB on August 13-14;
- first-day-account `signed_in_app_ready_v2` P95 improved from about 13.7
  seconds on August 11 to 11.4 seconds on August 14; and
- the first-day median changed much less, from about 4.0 seconds to 3.8
  seconds.

The remaining useful-surface latency is still far outside the plan's SLOs:

| Cohort, August 13-14              | P50    | P95     |
| --------------------------------- | ------ | ------- |
| Projects route                    | 3.67 s | 11.25 s |
| Direct project route              | 6.61 s | 21.11 s |
| Reported downlink at least 5 Mbps | 3.43 s | 11.32 s |
| Reported downlink below 1 Mbps    | 7.68 s | 38.64 s |
| Adaptive full mode                | 3.59 s | 12.41 s |
| Adaptive reduced mode             | 5.11 s | 24.23 s |

Reduced mode identifies constrained clients but does not yet provide a thin
enough startup path. The current payload cannot meet the constrained target.

Phase attribution makes the next target more specific. On direct project
loads, time from the common React root commit until useful project readiness is
4.76 seconds at P50 and 14.90 seconds at P95. For direct-project traces taking
more than 10 seconds, this interval alone has a 10.13-second median. On the
Projects route, the initial projects snapshot is 2.00 seconds at P50 and 4.24
seconds at P95, while root-to-surface is 2.32 seconds at P50 and 4.62 seconds at
P95. Initial route chunk loading remains material in slow clients but is no
longer the only dominant interval.

The 30-second incomplete metric is a diagnostic, not a terminal outcome. A
small number of traces emit `signed_in_app_incomplete_v1` and later reach the
useful surface under the same client event id. Most incomplete direct-project
traces had already committed the common React root, which independently
confirms that direct-project convergence after common bootstrap needs study.

For eligible August 13 accounts with a full 24-hour observation window, 505 of
545 reached a measured useful surface. The 40 without a useful-surface trace
activated within 24 hours at 45%, versus 64-67% for accounts whose first
measured useful surface completed within six seconds. This is supportive but
not causal: 29 of the 40 had some app-bootstrap telemetry, 11 had none, and
high-intent users are overrepresented among people willing to wait through a
slow startup. Latency among completed traces is still confounded by intent.

Immediate follow-up decisions:

1. Record the static build timestamp on success and pre-app diagnostics so
   rollout comparisons no longer mix builds by calendar day.
2. Add direct-project gate phases for project record, open-files state,
   open-files order, and final useful-surface eligibility.
3. After one full production day on one build, optimize the gate that explains
   the direct-project post-root tail instead of guessing across several stores.
4. Reduce the Projects route's startup snapshot and route closure toward the
   1.2 MiB ratchet; the current approximately 1.73 MiB median is an improvement,
   not the final thin shell.
5. Run the account-level intent-to-treat experiment before claiming a retention
   win. Continue reporting no-surface and incomplete outcomes independently of
   completed latency percentiles.

Related work:

- `src/.agents/growth-retention-analytics-implementation-plan-2026-08-04.md`
- `src/.agents/project-start-p95-3s-strategy-2026-07-31.md`
- `src/.agents/frontend-standby-load-shedding-plan.md`
- `src/packages/frontend/app/bootstrap-ux-latency.ts`
- `src/scripts/ops/run-ux-latency-harness.mjs`

## Objective

Increase new-user activation and retention by making the first signed-in CoCalc
experience visibly useful, responsive, and trustworthy on ordinary and
constrained client devices.

The primary engineering goal is:

> A signed-in user should see and be able to use the surface they requested
> without first downloading and evaluating most of CoCalc.

This is broader than reducing the existing `signed_in_app_ready_v2` number. The
current event ends after account and site state are ready and React paints. It
does not prove that the requested project list, project, or file surface is
visible and useful. The plan therefore introduces an explicit useful-surface
endpoint and optimizes that path without declaring the whole application ready
early.

## Product Hypothesis And Causal Status

Signed-in startup is the largest measured pre-value performance problem and the
strongest current performance-retention hypothesis. It is not yet proven to be
the largest cause of low retention. Acquisition quality, product fit,
onboarding, pricing, and other failures may matter more.

The hypothesis deserves priority because:

- every signed-in user pays this cost before receiving value;
- first-session and cold-cache users pay more than established users;
- delay before the first useful surface damages trust in every later workflow;
- unlike file, terminal, or Jupyter latency, the startup path affects all
  signed-in workflows; and
- the current payload has a bandwidth floor that guarantees a poor experience
  for constrained users, independent of backend health.

Natural observational retention comparisons cannot prove causality here.
Users with strong intent are more willing to wait, and the existing latency
trace records completed startups rather than people who abandon the page while
it is loading. The final product claim must come from an intent-to-treat
experiment that includes abandonment.

## Production Baseline

The following baseline was measured on 2026-08-11 from recent production
`signed_in_app_ready_v2` events. Preserve the exact cohort and query with the
first implementation report so future comparisons remain reproducible.

### All Completed Signed-In Navigations, Trailing 24 Hours

| Cohort                         | Samples | P50    | P90    | P95     | P99     |
| ------------------------------ | ------- | ------ | ------ | ------- | ------- |
| All completed navigations      | 2,709   | 3.52 s | 8.01 s | 11.57 s | 42.51 s |
| Cold-cache navigations         | -       | -      | -      | 14.87 s | -       |
| Reported downlink below 1 Mbps | -       | -      | -      | 26.22 s | -       |
| At most two logical CPUs       | -       | -      | -      | 40.06 s | -       |
| Script resources cached        | -       | -      | -      | 8.52 s  | -       |

The server response is not the dominant interval in this trace:

- HTML TTFB P95 is approximately 500 ms;
- HTML response-body P95 is approximately 13 ms;
- bootstrap-module-loaded absolute P95 is approximately 6.20 s;
- page-chunk load after bootstrap P95 is approximately 1.47 s;
- account/site readiness after page-chunk load P95 is approximately 3.61 s;
  and
- the final next-paint P95 is approximately 145 ms.

### New-Account First-Day Cohort

For the first fully mature new-account cohort after this instrumentation
launched, completed signed-in document navigations had:

| Measure                      | Value   |
| ---------------------------- | ------- |
| Eligible new accounts        | 291     |
| Accounts with a completion   | 249     |
| Completion P50               | 4.40 s  |
| Completion P90               | 12.44 s |
| Completion P95               | 18.95 s |
| Completions above 3 seconds  | 77.5%   |
| Completions above 6 seconds  | 34.5%   |
| Completions above 10 seconds | 14.5%   |

The 42 accounts without this completed navigation are not automatically
startup abandoners. Some performed meaningful work through flows that did not
produce a measured document navigation. This is a measurement gap, not a
retention conclusion.

Completed-startup duration was not monotonically associated with less
first-day work. That is expected under survivor and intent bias and must not be
used to dismiss the startup hypothesis.

### Payload And Execution Baseline

A current production build and a cold browser trace show:

- the primary app entry is approximately 12.18 MB raw, 3.23 MB gzip, and
  2.41 MB Brotli;
- the browser transferred approximately 3.04 MB for that entry;
- the primary page chunk transferred approximately 444 KB;
- total startup JavaScript transfer was approximately 3.75 MB; and
- the app entry represented approximately 81% of those startup bytes.

The entry graph contains approximately 2,320 modules. It includes all
CodeMirror modes and keymaps plus substantial editor, chat, account, admin,
host, billing, notification, and project functionality that is not needed to
render every initial route.

The browser observed CDN cache hits. CDN tuning may still be useful, but it is
not the primary explanation for the payload or CPU cost.

A cold Chromium run with 1 Mbps download bandwidth, 150 ms round-trip latency,
and 4x CPU slowdown took approximately 31 seconds to render the application.
Transferring 3.75 MB over 1 Mbps alone takes about 30 seconds. A universal
three-second rich-application target is therefore physically impossible
without changing what is initially transferred.

## Current Architectural Causes

The current dependency graph matches the observed behavior:

- `frontend/app/page.tsx` describes itself as bringing in everything on the
  desktop after sign-in and directly imports substantial navigation, billing,
  warning, support, and application content;
- `frontend/entry-point.ts` statically imports and initializes account,
  projects, news, notifications, file-use, webhooks, Markdown input, jQuery
  plugins, customization, and other global systems before rendering;
- `frontend/app/active-content.tsx` statically imports Account, Admin, Docs,
  File Use, Notifications, Project, Projects, Share, SSH, Hosts, Auth, and
  license-claim pages even though only one route is active; and
- `frontend/editors/register-all.ts` imports all editor registrations,
  CodeMirror modes, addons, and keymaps before any editor is requested.

There are two distinct performance problems:

1. Cold clients must transfer a large route-independent application graph.
2. Warm clients still pay parsing, evaluation, initialization, account/site
   synchronization, and main-thread work; cached-script P95 remains 8.52 s.

The loading transition also removes the startup banner before the page chunk
has loaded. This can expose an avoidable blank or unstable state. Correcting it
improves perceived reliability but must not be reported as a latency win unless
the useful-surface endpoint also improves.

## Readiness Definitions

### Primary Product Endpoint: First Useful Signed-In Surface

Add a versioned route-aware endpoint, provisionally
`signed_in_surface_ready_v1`, measured from document navigation start until the
requested surface has committed and its primary action is available.

The endpoint is route-specific:

- Projects route: recent projects or a truthful empty state and Create Project
  action are visible and interactive.
- Project route: project chrome and the requested project surface are visible,
  with project identity and authorization resolved.
- File route: project chrome and a truthful file loading/preview state are
  visible; content-visible and sync-ready remain separate existing metrics.
- Account, Docs, Admin, Hosts, and other routes: the selected route's shell and
  primary navigation are visible, without waiting for unrelated route code.

A generic spinner, blank root, or static application frame is not useful
readiness. The endpoint must not wait for background news, notifications,
avatars, billing warnings, idle prefetches, or nonselected editors.

### Supporting Endpoints

Keep `signed_in_app_ready_v2` during the transition for historical continuity,
but add phases that answer where time went:

- bootstrap observer installed;
- app entry request started and response completed;
- app entry evaluated;
- route determined;
- route chunk requested, loaded, and evaluated;
- minimal site configuration ready;
- minimal account identity/routing ready;
- initial route data requested and ready;
- React root committed;
- first useful signed-in surface committed;
- full account projection ready; and
- background application initialization complete.

Record browser main-thread pressure during the critical interval:

- long-task count;
- total long-task duration;
- maximum long-task duration;
- script transfer, encoded, and decoded bytes;
- resource cache status where observable;
- reported and measured connection class;
- hardware concurrency and device memory where exposed; and
- visibility changes and navigation type.

### Incomplete And Abandoned Startup

The current app cannot report failures that occur before its telemetry code
loads. Install a bounded observer in the tiny pre-application bootstrap entry.
It must report, without importing the full frontend:

- page hidden or unloaded before useful readiness;
- no useful readiness after a fixed deadline, initially 30 seconds;
- app or route chunk load failure;
- application initialization exception; and
- authentication or minimal-bootstrap failure.

Use `sendBeacon` or an equivalent nonblocking transport where appropriate.
Deduplicate by a random navigation trace id. Do not record URLs containing
secrets, filenames, user content, account data, or resource names.

Operational successes may remain deterministically sampled. Experiment
exposure, abandonment, failure, and bounded product outcomes must be unsampled
or assigned a known probability suitable for intent-to-treat analysis.

## SLOs And Budgets

The final target must distinguish normal clients from constrained clients
rather than hide either population in one aggregate.

### Normal Cold Client

Qualified client: foreground document navigation, at least 5 Mbps measured or
reported downlink, at least four logical CPUs, no browser extension failure,
and a healthy CDN/control-plane path.

- First useful signed-in surface P50 at or below 1.5 seconds.
- First useful signed-in surface P95 at or below 3.0 seconds.
- Startup failure or incomplete rate below 0.1%.
- No unexplained sample above 5 seconds in the staging qualification corpus.

### Warm Client

- First useful signed-in surface P95 at or below 2.0 seconds.
- No full route-independent initialization before the requested surface.

### Constrained Client

Reference profile: 1 Mbps download, 150 ms RTT, and approximately two-core or
4x CPU-slowdown behavior.

- A useful reduced-data shell P95 at or below 8 seconds.
- Clear progress and recovery throughout the load; no unexplained blank page.
- Rich functionality may stream afterward without blocking the first action.

A three-second useful surface at 1 Mbps permits at most 375 KB under perfect
conditions and realistically about 200-250 KB of critical payload. Reaching
that stretch goal requires a genuinely basic shell, not merely compressing the
current application harder.

### Payload Budgets

Budget the transitive critical route closure, not only assets directly named in
`app.html`.

- First ratchet: reduce cold critical transfer below 2 MB.
- Second ratchet: reduce cold critical transfer below 1.2 MB.
- Normal-shell target: at or below 1 MB Brotli across initial JS and CSS.
- Stretch target: 500-800 KB for common Projects and Project routes.
- Reduced-data shell target: approximately 250 KB before the first useful
  action.

Every accepted bundle-reduction change lowers the checked budget. Budgets must
not be raised merely to unblock unrelated feature work without an explicit
review and recorded justification.

## Operating Principles

1. Optimize the user-observed critical path, not build size or an internal mark
   in isolation.
2. Do not declare readiness before the requested surface is truthful and
   interactive.
3. Make the thin route-aware shell the default architecture; reduced-data mode
   should remove optional work rather than maintain an unrelated second app.
4. Prioritize the user's explicit action over presence, news, warnings,
   previews, analytics, and speculative prefetching.
5. Preserve authentication, authorization, multibay routing, project isolation,
   and billing correctness.
6. Use explicit, testable dynamic loaders with loading and error states; do not
   depend on accidental import side effects.
7. Keep changes reversible and measure one major architectural variable at a
   time.
8. Treat long-lived tabs crossing a static deployment as a first-class release
   scenario.
9. Do not use a faster loading animation to conceal unchanged useful readiness.
10. Stop or redirect the optimization if a well-powered experiment shows no
    activation or retention benefit.

## Execution Phases

### Phase 0: Make Startup And Abandonment Trustworthy

Implement the readiness definitions and tiny bootstrap observer before the
large refactor. Extend the existing Chromium harness with startup-specific
profiles, cold/warm cache control, resource timing, long tasks, and a visible
surface assertion.

Add an admin view that reports:

- P50, P90, P95, P99, maximum, success count, and sample rate;
- completed, failed, timed-out, and pagehide-before-ready counts;
- cold versus warm cache;
- new versus established account;
- network, CPU, device-memory, route, browser, and build cohorts; and
- phase attribution and critical transfer size.

Exit criteria:

- every staging harness run produces one terminal outcome;
- a forced chunk failure and a forced 30-second timeout are observable;
- the Projects and direct-project endpoints assert visible, interactive DOM;
- telemetry adds no awaited work to startup; and
- old and new metrics can be compared for at least one staging release.

### Phase 1: Establish A Stable Thin Shell

Keep the startup banner or a lightweight shell visible until React commits a
truthful route state. Move optional top-navigation controls and warnings behind
the first useful commit.

Split `ActiveContent` by top-level route using explicit Promise-based dynamic
loaders, Suspense/loading states, route-scoped error boundaries, and a retry
path. The initial dependency graph should contain only code required to:

- verify the current session;
- load minimal site configuration;
- resolve account and project ownership/routing;
- parse the requested route;
- render common shell/navigation; and
- load the one requested surface.

Inventory each initializer in `frontend/entry-point.ts`. Classify it as
critical, route-required, post-paint, idle, or event-triggered. Convert hidden
side-effect imports into named idempotent initializers before deferring them.

Exit criteria:

- Account, Admin, Docs, File Use, Hosts, Notifications, Projects, Project, SSH,
  Share, Auth, and Claim code are not all in the initial route closure;
- direct deep links, browser back/forward, refresh, exam mode, kiosk mode, and
  impersonation still work;
- a failed route chunk shows a recoverable error instead of a blank page; and
- critical transfer is below the first 2 MB ratchet.

### Phase 2: Make Editor Loading Demand-Driven

Replace eager editor registration with a small metadata registry that maps an
extension or explicit editor type to a dynamic loader. Registration metadata
must not import editor implementations.

Load only on demand:

- CodeMirror core;
- the selected language mode;
- Vim/Emacs/Sublime keymaps and optional addons;
- Jupyter, LaTeX, terminal, chat, whiteboard, and other editor implementations;
- KaTeX and syntax-highlighting runtimes; and
- upload/Dropzone and other feature-specific libraries.

The loader must deduplicate concurrent requests, cache successful modules,
surface failures, and permit one retry after a deployment-related chunk error.
Do not change file-type precedence or fallback behavior as an incidental part
of this work.

Exit criteria:

- CodeMirror modes and keymaps are absent from Projects-route startup;
- opening a plain text file loads only its required editor dependencies;
- every supported file type passes a registration/loader contract test; and
- common-route critical transfer is below 1.2 MB.

### Phase 3: Minimize Bootstrap Data And Main-Thread Work

Instrument account, site customization, routing, recent-project projection,
and Redux initialization separately before changing their contracts.

The current account snapshot includes balances, editor and terminal settings,
passports, SSH keys, RootFS defaults, tags, tours, Stripe state, profile, and
other fields. Define a minimal startup projection containing only the fields
needed for identity, locale/theme, authorization, home-bay routing, and the
initial shell. Load full settings and billing/profile data when their surfaces
or warnings need them.

Before changing account, project, or routing bootstrap, reread
`src/.agents/scalable-architecture.md`. Account data is authoritative at
`home_bay_id`; project actions route through `owning_bay_id`; the optimization
must not reintroduce local-bay assumptions or proxy project data through the
hub.

Audit synchronous initialization and React commits for long tasks. Defer
background stores, subscriptions, news, notifications, webhooks, Markdown
input, and warning calculations until after useful readiness unless a route
explicitly requires them.

Exit criteria:

- account, customization, route-data, and render phases each have independent
  measurements;
- no deferred field is read before its owning feature requests it;
- reconnect, account-feed repair, sign-out/sign-in, and cross-bay routing tests
  pass; and
- warm-client useful-surface P95 is at or below 2 seconds in staging.

### Phase 4: Use Authentication Dwell Time Safely

Run a separate experiment that prefetches the current build's signed-in shell
after clear signup or sign-in intent, such as email submission or identity
approval, while the user is completing verification.

Use the current hashed asset manifest and ordinary browser cache. Do not add a
service worker merely for this optimization. Never prefetch a stale build or
assume an asset URL survives deployment.

Suppress speculative prefetch when:

- `saveData` is enabled;
- measured bandwidth or CPU is constrained;
- the page is hidden without active authentication intent; or
- the browser already has the asset cached.

Measure this separately from the thin-shell refactor. Prefetch can move network
cost into otherwise idle time, but cached-script P95 proves it cannot solve
evaluation and bootstrap cost alone.

Exit criteria:

- post-authentication cold transfer decreases without increasing auth failure;
- no measurable bandwidth regression occurs for users who do not finish
  authentication; and
- cross-deployment and stale-tab tests produce no chunk/runtime mismatch.

### Phase 5: Add Adaptive Reduced-Data Behavior

Build a small startup policy from `saveData`, reported connection information,
measured resource throughput/RTT, recent long tasks, hardware concurrency, and
device memory. Browser-reported network data is advisory and must not be the
only signal.

Under constrained conditions:

- disable idle route and editor prefetching;
- defer avatars, noncritical images, news, notifications, and previews;
- reduce animation and expensive decoration;
- coalesce presence and background projection work;
- render cached recent-project state while revalidating;
- preserve typed input and navigation intent across reconnects; and
- offer a persistent user override for reduced-data mode.

Apply techniques familiar from multiplayer clients: optimistic local response,
stale-while-revalidate state, explicit connection quality, prioritized message
classes, bounded retries, delta coalescing, and resume rather than restart after
transport loss.

Exit criteria:

- the constrained Chromium profile meets the eight-second useful-shell target;
- reduced-data mode never weakens correctness or hides stale/offline state; and
- switching modes does not require a full application reload unless technically
  unavoidable and explained.

### Phase 6: Make Regression Difficult

Replace the current entry budget, which permits 12 MB raw and 3.5 MB gzip, with
route-aware transitive budgets. Record raw, gzip, Brotli, transferred, and
decoded sizes. Publish a per-build bundle census as a CI artifact.

Add forbidden-module guards for the minimal shell. At minimum, all CodeMirror
modes, editor implementations, Admin, Hosts, Jupyter, LaTeX, chat, Dropzone,
KaTeX, and billing-management code require an explicit reviewed exception if
they enter the common startup closure.

Run deterministic Chromium startup checks against staging release candidates.
CI should enforce byte/module budgets; staging qualification should enforce
wall-clock SLOs because network/browser timing is too noisy for a normal unit
test runner.

Exit criteria:

- ordinary feature PRs cannot silently increase the critical route closure;
- budget reports identify the importing path responsible for a regression;
- the release checklist includes cold, warm, constrained, and cross-build tab
  tests; and
- rollback does not depend on rebuilding an old static artifact.

## Staging Test Matrix

Use isolated test accounts and the existing
`src/scripts/ops/run-ux-latency-harness.mjs`. Extend it rather than creating a
second unrelated browser driver.

Required routes:

- Projects page for a new empty account;
- Projects page for an established account with many projects;
- direct project directory URL;
- direct text-file URL;
- direct Jupyter and terminal URLs;
- Account, Docs, and one privileged Admin route; and
- sign-in redirect to each representative route.

Required client profiles:

| Profile           | Cache | Bandwidth/RTT    | CPU         |
| ----------------- | ----- | ---------------- | ----------- |
| Developer best    | warm  | unthrottled      | unthrottled |
| Normal cold       | cold  | 5 Mbps / 50 ms   | 2x slowdown |
| Slow network      | cold  | 1 Mbps / 150 ms  | 2x slowdown |
| Slow device       | cold  | 10 Mbps / 50 ms  | 4x slowdown |
| Fully constrained | cold  | 1 Mbps / 150 ms  | 4x slowdown |
| High latency      | cold  | 10 Mbps / 300 ms | 2x slowdown |

Also test warm repeat navigation, page reload, browser back/forward, offline
transition, reconnect, an intentionally failed chunk request, and an open tab
that crosses a static deployment.

Use 100% success sampling on staging. Preliminary iteration may use 20-30 runs
per cell. Qualification requires at least 100 successful samples for the normal
cold, warm, and fully constrained primary cohorts plus explicit accounting for
every failed or incomplete run. Report P50, P90, P95, P99, maximum, bytes, long
tasks, each phase, and failures.

Repeat representative cases while the hub/control plane is under measured
load. Static/client optimization is not sufficient if account or route data
collapses under production-like contention.

## Retention Experiment

After staging qualification, assign eligible new accounts to control or
candidate at the account level before the large startup payload is requested.
Keep assignment stable across devices and sessions. Begin with a 5% safety
canary, then use a balanced control/candidate allocation after crash and error
guards pass.

Primary product outcomes:

- first useful signed-in surface reached;
- project created or prepared project entered;
- first meaningful project work within 24 hours;
- D1 return and meaningful work; and
- D7 return and meaningful work.

Supporting outcomes:

- pagehide or timeout before useful readiness;
- startup failure and frontend crash rate;
- time to useful surface;
- project/file/Jupyter/terminal/Codex first-use funnel;
- support contacts attributable to loading or blank pages; and
- bytes transferred and long-task burden by client class.

Analyze by assigned variant, including users who never complete startup. Report
new versus returning users, network/CPU class, acquisition source, and requested
route, but do not repeatedly slice until a favorable result appears.

With roughly hundreds of new accounts per day, run long enough to obtain a
credible activation and D1 result, normally at least one full week after the
balanced allocation begins. D7 requires the corresponding maturation period.
Choose the minimum detectable effect and sample-size calculation before reading
the result.

If the candidate is substantially faster but does not improve abandonment,
activation, D1, or D7, retain changes that materially improve reliability or
cost, but lower the priority of further startup optimization relative to the
next measured retention bottleneck.

## Production Rollout And Rollback

Roll out in this order:

1. operator and isolated test accounts;
2. 5% of eligible new accounts;
3. balanced retention experiment;
4. 25% of all accounts after experiment/safety review;
5. 50% of all accounts; and
6. 100% after at least one full normal traffic cycle.

At each gate compare startup failures, browser crash reports, chunk-load errors,
useful-surface latency, incomplete rate, account/project routing errors, and
support reports. Pause on any correctness regression or unexplained tail.

Initially ship old and new startup paths in the same compatible artifact behind
a server-authoritative flag so rollback is a configuration change. Remove the
old path only after full rollout, cross-build tab validation, and a quiet
observation period.

Static rollout validation must include:

- hard refresh during and after deployment;
- an old tab dynamically loading a route after deployment;
- current HTML with current assets in every region;
- missing/stale chunk recovery;
- service-worker absence or explicit compatibility if that changes; and
- frontend crash monitoring grouped by build id.

## Main Risks And Mitigations

### Hidden Initialization Dependencies

Legacy modules may rely on import-time side effects. Inventory and convert them
to named idempotent initialization before deferring them. Add contract tests for
events that can arrive before an optional feature loads.

### Chunk And Build Mismatch

More dynamic chunks create more opportunities for a long-lived tab to request
an asset from a previous release. Keep immutable content-addressed assets long
enough, test tabs across deployment, and show a recoverable reload action after
a bounded retry.

### Duplicate Data Planes

A minimal bootstrap plus the full account/project feeds could race or create
duplicate subscriptions. Define one authoritative handoff and revision model;
do not independently mutate the same Redux state from two uncoordinated paths.

### Security Or Routing Regression

Never render private route data based only on stale local cache. Minimal
bootstrap must preserve fresh server authorization and multibay ownership
routing. A skeleton may be optimistic; private data may not be.

### Instrumentation Regression

The pre-app observer must be tiny, synchronous only where unavoidable,
nonblocking, bounded, and covered by payload tests. Telemetry failure must never
block startup.

### Misclassified Network Quality

`navigator.connection` is missing or imprecise in many browsers. Combine it
with measured resource behavior, use hysteresis, allow user override, and make
the default thin shell safe for everyone.

## 2026-08-14 Implementation Update

Production traces and a manual 2 Mbps Chrome profile isolated two independent
direct-project delays:

- the full project startup closure is 2.79 MiB Brotli when the project Redux
  runtime is counted correctly; and
- a cold directory listing could spend more than 30 seconds in three serial
  ten-second attempts even while the project host had negligible CPU, load,
  and IO pressure.

The first reduced-data implementation now:

- combines `navigator.connection` with measured bootstrap-script throughput
  and fixed bootstrap elapsed time, without a polling loop or separate speed
  test;
- authorizes and resolves host routing in the ordinary projects control plane,
  but does not initialize project editor/session Redux for an ordinary
  directory target;
- lists files directly from the project host through the existing scoped Conat
  filesystem client;
- preserves directory navigation, browser URLs, viewer restrictions, and an
  explicit handoff to the full workspace when a file is opened;
- falls back to the full workspace for files, backup/snapshot virtual paths,
  archived projects, exam/kiosk mode, access edge cases, and Lite;
- limits the fast listing to 200 rendered rows and offers an explicit full
  workspace transition;
- replaces serial visible-listing retries with requests hedged at three and six
  seconds under one twelve-second deadline, while leaving background cache
  warming and watcher catch-up conservative; and
- records directory paint, rather than project chrome initialization, as the
  useful project surface.

The bundle guard now measures both direct-project modes, including the project
Redux runtime in the full mode:

| Route mode      | Brotli   | Gzip     | Assets |
| --------------- | -------- | -------- | ------ |
| Reduced project | 1.24 MiB | 1.38 MiB | 30     |
| Full project    | 2.79 MiB | 3.08 MiB | 107    |

The reduced route-specific group is only 9.6 KiB Brotli; most remaining bytes
are the shared signed-in shell. At 2 Mbps, the ideal transfer floor falls from
about 11.4 seconds for the correctly counted full closure to about 5.1 seconds
for reduced mode, before latency and project data. This is a material first
step, not the final SLO: the shared shell remains the next bundle target.

The production new-account sample from 2026-08-11 through 2026-08-13 also
showed that this cohort is not marginal: 48.4% of accounts with a browser
estimate reported at most 2 Mbps, though the browser API is coarse and must not
be treated as ground truth. Staging qualification must validate actual
directory paint and fallback behavior before any production experiment.

## Immediate Work Queue

1. Save reproducible production baseline queries and add the useful-surface and
   incomplete-startup contracts.
2. Extend the existing Chromium harness with cache/network/CPU profiles and
   startup assertions.
3. Produce a transitive bundle census for Projects, direct project, and direct
   file routes.
4. Split top-level route imports and retain a flag-controlled legacy path.
5. Convert editor registration to metadata plus dynamic loaders.
6. Measure and then split minimal versus full account/site bootstrap.
7. Add auth-intent prefetch as a separate experiment.
8. Add adaptive reduced-data policy after the thin shell is stable.
9. Ratchet CI budgets after every accepted reduction.
10. Qualify on staging, then run the production retention experiment.

## Definition Of Done

This program is complete when:

- first useful signed-in readiness and abandonment are measured independently
  of full app success;
- the normal cold, warm, and constrained SLOs pass the staging matrix;
- the common startup route no longer imports unrelated pages or all editors;
- route-aware byte and forbidden-module budgets prevent regression;
- static deployments preserve long-lived-tab and chunk compatibility;
- production rollout has no startup failure, crash, auth, routing, or privacy
  regression; and
- a preregistered experiment determines whether the faster path improves
  activation and retention.

The ultimate success criterion is not merely a smaller bundle or a lower P95.
It is a measurable increase in the fraction of new users who reach useful work
and return.
