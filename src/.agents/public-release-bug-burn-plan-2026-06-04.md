# CoCalc-ai Public Release Bug Burn Plan, 2026-06-04

Status: active triage and execution plan

Source backlog: `/home/user/wstein.tasks.md`

Release target: public release readiness in less than one month for:

- `cocalc.ai`: hosted multibay SaaS for desktop browsers.
- `cocalc-plus`: single-user local SEA binary for macOS and Linux.
- `cocalc-star`: polished single-VM Ubuntu 24.04 appliance.
- `cocalc-launchpad`: clear product story, not necessarily fully polished.
- `cocalc-cli`: Linux/macOS SEA binary and desktop-agent sandbox store.

## Triage Rules

1. Data correctness beats polish. Anything that can silently show stale state,
   lose output, reorder terminal input, or leave a user believing work is still
   running when it failed is P0.
2. Operator release paths count as product. Hosted SaaS and Star cannot ship
   if admins cannot safely upgrade hosts, understand host state, or recover
   from expected deployment operations.
3. Reduce risky surface instead of polishing it. If a complex feature is not
   needed for first release and creates security or support risk, hide it,
   feature-flag it, or narrow it.
4. Quick fixes should run in parallel, but must not distract from the core
   correctness blockers.
5. Every item below needs either a fix, an explicit deferral decision, or a
   release-scope cut.

## Priority Definitions

- `P0`: release blocker for at least one named release product.
- `P1`: should finish before release if P0 burn-down is healthy.
- `P2`: useful polish or product story work, but not a release blocker.
- `Decision`: needs a product or architecture decision before engineering
  should spend implementation time.

Size estimates:

- `S`: likely same day.
- `M`: one to three days.
- `L`: multi-day investigation or implementation.
- `XL`: likely needs a dedicated plan or sustained iteration.

## Current Top Five

1. Fix the frontend projection/changefeed correctness model for project state
   and account settings.
2. Fix terminal reconnect ordering so buffered keystrokes are never reordered.
3. Make Codex/ACP failure states durable and visible when workers or app
   servers die.
4. Restore project-host software upgrade controls in the admin UI.
5. Get CoCalc Star to a clean install/product-gating release candidate.

## P0 Workstreams

### P0-A: Frontend Projection And Changefeed Correctness

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source items:

- Project appears stuck in `Starting` while actually running after rootfs pull.
- Account settings switches get stuck because the frontend waits for a
  changefeed update that never arrives.

Why this blocks release:

- This is the same class of bug as stale file/sync state: the browser is a
  projection of distributed backend state and can silently stop converging.
- Optimistically changing local Redux state would hide the failure and make the
  distributed model less trustworthy.

Plan:

1. Audit the project/account changefeed path end to end:
   - write request,
   - database commit,
   - changefeed emission,
   - frontend subscription,
   - Redux projection update,
   - stale/disconnected detection.
2. Add instrumentation that distinguishes:
   - write RPC failed,
   - write RPC succeeded but changefeed did not arrive,
   - changefeed subscription disconnected,
   - local projection ignored or dropped an update.
3. Define an acknowledgement model for user actions that are intentionally
   backend-confirmed:
   - UI can show "Saving" or "Waiting for backend state",
   - timeout must turn into an actionable retry/error,
   - no silent stuck switch or stuck project state.
4. Add focused regression tests for project start state convergence and account
   setting toggles.

Exit criteria:

- Rootfs-pull project start transitions converge without refresh.
- Account switches either update from backend state or show a clear failure.
- Browser resume/network loss cannot leave these surfaces silently stale.

Estimate: `XL`

First action:

- Build a minimal reproducible projection trace for one account setting toggle
  and one project start operation, then fix the first broken invariant found.

### P0-B: Terminal Reconnect Must Preserve Input Order

Status: fixed first pass 2026-06-05.

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`, `cocalc-cli` indirectly

Source item:

- Terminal reconnect preserved disconnected keystrokes but reordered them:
  buffered `git pu` was sent after newly typed `sh`.

Why this blocks release:

- Reordered terminal input is data corruption. Dropping input during a clear
  reconnect state would be less dangerous than reordering it.

Plan:

1. Trace `connected-terminal.ts` buffering and reconnect flush order.
2. Ensure all terminal input passes through a single FIFO queue whenever the
   terminal is not fully ready.
3. Block direct writes until buffered data has flushed or explicitly drop the
   buffer with a visible warning.
4. Add a deterministic test:
   - queue input while disconnected,
   - reconnect,
   - type more input immediately,
   - assert backend receives bytes in original user order.

Exit criteria:

- No typed bytes can overtake older buffered bytes. (done)
- Reconnect states have either FIFO preservation or explicit, visible discard.
  (FIFO preservation implemented)

Implemented:

- terminal input now only writes directly when the pty is connected and the
  reconnect/spawn path has explicitly marked input ready;
- if any older buffered input exists, later input is appended to the same FIFO
  and the queue is drained in order;
- deterministic frontend regression test covers:
  - queue input while disconnected,
  - start reconnect with spawn pending,
  - type more input before flush,
  - assert backend receives the original user order.

Estimate: `M`

### P0-C: Codex/ACP Failure State Durability

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source items:

- Codex app-server exits unexpectedly and the main chatroom still looks like
  the turn is running.
- ACP worker interruption loses activity log and leaves the turn showing
  `Thinking...`.
- Disk quota failure path did not end the turn cleanly.

Why this blocks release:

- Agents are central to the product. A failed worker must never look like a
  live turn forever, and activity history must survive worker death.

Plan:

1. Treat app-server exit, ACP worker exit, quota failure, and worker timeout as
   first-class terminal turn states.
2. Persist enough turn/activity state before and during execution so a worker
   crash cannot erase the visible trail.
3. Make the chatroom state derive from durable turn state, not only from a live
   worker stream.
4. Add fault-injection tests:
   - kill Codex app-server mid-turn,
   - kill ACP worker mid-turn,
   - simulate quota failure,
   - assert chat shows failed/interrupted state and activity remains visible.

Exit criteria:

- No released build can leave a dead turn in `Thinking...` indefinitely.
- Activity log and main chat agree on final failure/interruption state.

Estimate: `L`

### P0-D: Project-Host Software Upgrade Controls

Products: `cocalc.ai`, `cocalc-star`

Source item:

- Admin UI no longer exposes controls to upgrade tools bundle, project bundle,
  or project-host bundle. CLI still works:
  `cocalc host upgrade spot-utah --artifact tools --hub-source --wait`.

Why this blocks release:

- Public hosted SaaS and Star both need an operator path to roll forward and
  recover without requiring hidden CLI knowledge.

Plan:

1. Locate CLI API calls for host upgrade and artifact selection.
2. Add minimal controls to "Software lifecycle detail":
   - artifact: `tools`, `project bundle`, `project-host`,
   - version selector sorted newest-first,
   - apply/promote action with current status.
3. Keep V1 conservative:
   - admin-only,
   - confirmation on project-host bundle changes,
   - visible progress/result.

Exit criteria:

- Admin can select and apply the three release-critical artifact types from UI.
- UI reflects current/default artifact state after action completes.

Estimate: `M`

### P0-E: CoCalc Star Release Candidate

Products: `cocalc-star`

Source item:

- Star install/product issues:
  - initial rootfs should be published as official/public during provisioning,
  - include Ubuntu 26.04 plus LaTeX/Jupyter basics,
  - project-host access should be enabled for all accounts,
  - host should be visible in admin project-host listing,
  - installer failed because `node` was not found in `star-poc.sh`,
  - first project start stopped and needed another start,
  - Star UI should hide cloud/multibay/billing/provider features.

Why this blocks release:

- Star is a named release product. It must install cleanly on Ubuntu 24.04 and
  present itself as an appliance, not as the full SaaS operator console.

Plan:

1. Fix installer dependency assumptions:
   - no bare `node` unless provisioning installs it or uses bundled runtime.
2. Define and publish the initial official/public Star rootfs.
3. Ensure single appliance host is:
   - registered,
   - visible to admins,
   - usable by all local accounts.
4. Add Star mode UI gating:
   - hide Cloudflare config,
   - hide cloud provider hosts,
   - hide external project-host creation,
   - hide Stripe config,
   - hide bay operations,
   - hide backup shards,
   - hide software licenses,
   - hide SSO providers/domains.
5. Add an appliance smoke test:
   - fresh Ubuntu 24.04 VM,
   - install from plus/SEA path,
   - open browser,
   - create account,
   - create/start project,
   - open terminal/Jupyter.

Exit criteria:

- One-command install completes without manual port forwarding or missing
  command failures.
- First project start succeeds and remains running.
- UI matches the appliance product surface.

Estimate: `XL`

### P0-F: Project Apps Security Scope Cut

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source item:

- Project Apps are confusing and risky:
  - "expose" is a security/egress risk,
  - public sharing is complicated and undertested,
  - app creation can stop the project,
  - website hosting is needed long-term but not defined for release.

Why this blocks release:

- A confusing app UX is bad; an exposed network/public-sharing surface with
  unclear limits is a security and support risk.

Plan:

1. Remove or feature-flag `Expose` from first public release.
2. Hide public sharing for project apps unless explicitly enabled by a
   deployment feature flag.
3. Keep a narrow safe app launcher path for JupyterLab/VS Code/etc.
4. Record website publishing as a post-release product track:
   - static directory publishing,
   - external hosting target,
   - large site support,
   - update button/workflow.

Exit criteria:

- First release does not expose a dangerous app publishing surface by default.
- App creation does not unexpectedly stop a project in supported flows.

Estimate: `L`

### P0-G: Static Upgrade File Retention

USER: It turns out we did this yesterday already for the multibay systemd deployment (rocket = cocalc.ai).

Products: `cocalc.ai`, `cocalc-star`, `cocalc-launchpad`

Source item:

- During multibay/static upgrades, old frontend files must not be deleted while
  existing clients may still reference them.

Why this blocks release:

- Public SaaS upgrades must not break active browser sessions until refresh.

Plan:

1. Audit static artifact retention in hosted, Star, and Launchpad packaging.
2. Define retention window and cleanup policy.
3. Add a smoke test or deployment checklist:
   - load old static asset,
   - deploy new static,
   - verify old asset remains available,
   - verify new clients get new asset.

Exit criteria:

- Upgrade process keeps old frontend chunks long enough for active clients.
- Cleanup is bounded and documented.

Estimate: `M`

### P0-H: Cross-Region Project Move Decision And Burn-Down

Products: `cocalc.ai`

Source item:

- Moving projects between regions is marked `#blocker`; it works but is
  "totally horrible".

Why this blocks release:

- Multibay hosted SaaS makes region/host movement a credibility issue. If
  cross-region move is part of the release promise, it must be predictable.

Decision required:

- Either:
  1. explicitly exclude cross-region move from first public user-facing release,
     keeping it admin/internal only, or
  2. treat it as P0 and fix UX/state convergence before release. &lt;-- this: it's very important and easy to hit. I just tried a simple cross region move and after 3 minutes got "transient error" and stuck forever just stopping, so it really is very broken right now:<img src="/blobs/paste-902fycigor6.png?uuid=b91e12ba-ccfe-4f6a-89ff-0ff119098466"   width="1059px"  height="408px"  style="object-fit:cover"/>

If in scope, plan:

1. Reproduce the linked failure path.
2. Split failures into:
   - state/progress reporting,
   - permission convergence,
   - host/project restart timing,
   - browser session reopen handoff.
3. Add an explicit progress model and final "reopen project" state.

Exit criteria:

- Move either is hidden/not promised, or is good enough for real user/admin use.

Estimate: `XL` if in scope

## P1 Workstreams

### P1-A: Deletion Protection For Projects And Project Hosts

Products: `cocalc.ai`, `cocalc-star`

Source item:

- Add deletion protection checkbox for project-hosts and projects. Checking is
  easy; unchecking requires fresh auth. Non-payment enforcement can still
  override.

Why it matters:

- This is a high-leverage guardrail against catastrophic data loss.

Estimate: `M`

Exit criteria:

- Protected projects/hosts cannot be deleted through UI/API/CLI ordinary delete
  paths.
- Unprotect requires fresh auth.

### P1-B: Disk Usage Scan Budget

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source item:

- Disk usage scan fails after 5 seconds on large folders, blocking quota/usage
  visibility.

Plan:

- Replace hard timeout with a budget/rate model and cache stale results when
  needed.

Estimate: `M`

### P1-C: Agents Panel Performance And State Retention

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source items:

- Agents flyout reopens/switches long threads slowly.
- Agent management problem:
  - do not rerender full thread every time,
  - no animated scroll restore,
  - project-home dropdown should show all agents,
  - opening a file from an agent needs a clear path back to the exact agent
    state.

Plan:

1. Retain loaded agent syncdb/actions state across flyout agent switches.
2. Persist and restore scroll without animation and without remount.
3. Add navigation affordance from file opened by agent back to exact agent.

Estimate: `L`

### P1-D: Scheduled Automation UX And Permissions

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source items:

- Scheduled automations at top of Agents flyout are confusing.
- Scheduled automation manual run/project wake fails with permission error.
- Automation UX has accidental-click risk when "1 unacknowledged" changes
  layout and exposes "run now".

Plan:

1. Move automations out of primary Agents list or hide behind a clear
   "Automations" section/toggle.
2. Fix manual/scheduled run permission path so automation can wake project when
   allowed.
3. Stabilize row layout so acknowledgement clicks cannot accidentally trigger
   run.

Estimate: `M`

### P1-E: Host Metrics And Lifecycle Correctness

Products: `cocalc.ai`, `cocalc-star`

Source items:

- Host uptime does not reset after restart.
- New host shows unplanned downtime on first start.
- Host resources column cuts off total disk size.
- `/scratch` should show as another resource row when available.
- If `/scratch` is not configured, show an info popover with config link.
- Add resources detail view with actual plots like drawer/card view.

Estimate: `M`

### P1-F: Project Bulk Stop Correctness

Products: `cocalc.ai`, `cocalc-star`

Source item:

- Stopping many projects tries already stopped projects, errors on no assigned
  host, and times out.

Plan:

1. Treat stop on no-assigned-host or already-stopped project as no-op success.
2. Batch or throttle stop operations.
3. Investigate timeout cause separately if still reproducible.

Estimate: `S-M`

### P1-G: Workspaces Timeout Must Show Error And Retry

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source item:

- Workspaces timeout silently shows no workspaces.

Plan:

- Show "Failed to load workspaces" with `Refresh`.

Estimate: `S`

### P1-H: File Explorer Correctness Bugs

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source items:

- Duplicate file fails due to likely absolute/relative path mismatch.
- Drag/drop to parent folder silently does nothing.
- Remove `@` from file filter entirely.
- Skinny flyout loses close/fullscreen controls.

Estimate: `S-M`

Suggested order:

1. Duplicate file.
2. Skinny flyout controls.
3. Remove `@`.
4. Parent folder drag/drop.

### P1-I: TimeAgo Correctness

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source item:

- TimeAgo does not update consistently until unrelated rerender.

Plan:

- Audit the rewritten TimeAgo timer/subscription model and add a deterministic
  fake-timer test.

Estimate: `S-M`

### P1-J: Disable Paged Block Markdown Editor By Default

Products: `cocalc.ai`, `cocalc-plus`, `cocalc-star`

Source item:

- Alpha testers report that the full Slate markdown editor paging model is
  weird and confusing.
- The paged block markdown editor is implemented in
  `packages/frontend/editors/slate/block-markdown-editor.tsx`.
- It splits large markdown files into editable pages, but markdown files are
  usually small enough that this optimization is unlikely to matter in normal
  release usage.

Plan:

1. Put the paged block markdown editor behind a feature flag or advanced
   setting.
2. Default ordinary `.md` editing to the non-block editor path used by chat,
   tasks, or a similar single-document Slate editor.
3. Keep the block editor available only for explicit dogfood/performance
   testing of unusually large markdown files.

Exit criteria:

- Opening a normal markdown file no longer shows confusing page boundaries.
- Existing chat/tasks markdown editing behavior is not regressed.
- The old block editor remains reachable for internal testing if needed.

Estimate: `S-M`

## Quick Win Lane

These should be picked off opportunistically while P0 work proceeds.

1. Host drawer access-control selected user height mismatch.
   - Product: `cocalc.ai`
   - Estimate: `S`
2. Rename "Persistent disk" to "System disk" in host purchase price breakdown.
   - Product: `cocalc.ai`
   - Estimate: `S`
3. Workspaces timeout error/refresh.
   - Product: all project surfaces
   - Estimate: `S`
4. Duplicate file action abs/relative path bug.
   - Product: all project surfaces
   - Estimate: `S`
5. Skinny flyout close/fullscreen controls.
   - Product: all project surfaces
   - Estimate: `S`
6. Remove `@` from file filter.
   - Product: all project surfaces
   - Estimate: `S`
7. Project stop no-op for already stopped/no-host projects.
   - Product: hosted/admin
   - Estimate: `S`
8. Feature-flag/default-disable the paged block markdown editor.
   - Product: all markdown editor surfaces
   - Estimate: `S-M`

## Product Story And Positioning

### Landing Pages

Products: all

Source item:

- Landing pages should advertise four products:
  - `cocalc.ai`: SaaS.
  - `cocalc-plus`: single-user direct app.
  - `cocalc-star`: single-VM sandbox appliance.
  - `cocalc launchpad/rocket`: multi-VM/cloud scalable solution.

Priority: `P1` for release clarity.

Plan:

1. Update product positioning copy and information architecture.
2. Treat Launchpad/Rocket as one product category with deployment-size
   variants.
3. Avoid overpromising Launchpad polish for first release.

### cocalc-cli

Products: `cocalc-cli`

Source list has no dedicated CLI bug besides terminal/socket-adjacent issues,
but release goals require a CLI SEA smoke.

Priority: `P1`

Plan:

1. Build Linux and macOS SEA artifacts.
2. Smoke:
   - auth,
   - project/file commands,
   - browser action/docs commands,
   - agent sandbox use case.
3. Verify no dependency on bare `node` in the shipped binary path.

## Explicit Deferrals Or Scope Cuts

These are important but should not be full release blockers if the risky part
is hidden or clearly scoped.

1. Website hosting integration from projects.
   - Keep as post-release product design unless a minimal static publish path
     already exists and can be safely exposed.
2. Polishing cocalc-launchpad as a full release product.
   - Required now: product story and install direction.
   - Not required now: same polish level as SaaS/Plus/Star.
3. Public project-app sharing and arbitrary app expose.
   - Hide/feature-flag for release unless security review is complete.
4. Cross-region project move.
   - Must be either fixed or explicitly removed from the first-release promise.

## Suggested Execution Order

### Day 1-2: Fast Confidence Gains

- Fix the quick win lane items that are truly small.
- Start terminal input-order regression test and fix.
- Start Codex/ACP failure-state fault injection.
- Start project/account changefeed trace instrumentation.

### Week 1: Core Trust

- Land terminal FIFO reconnect fix.
- Land workspaces/duplicate/file-filter/flyout-control fixes.
- Land Codex app-server/worker failure final-state fixes.
- Produce a written diagnosis for project/account projection correctness and
  fix the first concrete broken invariant.

### Week 2: Operator And Appliance

- Restore host software upgrade controls.
- Fix Star installer missing-node issue and appliance UI gating.
- Verify static artifact retention across deploy.
- Fix host uptime/resource display correctness.

### Week 3: Release Candidate Hardening

- Star fresh Ubuntu 24.04 smoke.
- cocalc-plus Linux/macOS SEA smoke.
- cocalc-cli Linux/macOS SEA smoke.
- cocalc.ai dogfood soak with browser suspend/resume, project start/stop,
  Codex turns, file explorer, and admin host upgrade.
- Decide cross-region move release scope.

## Release Exit Checklist

- No known stale projection bug for project state or account settings.
- No known terminal input reorder bug.
- Codex/ACP failed turns always become durable visible failure states.
- Admin can upgrade project-host/tools/project bundle artifacts from UI.
- Star installs cleanly on a fresh Ubuntu 24.04 VM and presents appliance UI.
- Static upgrades do not strand active browser sessions.
- High-risk Project Apps expose/public-sharing surfaces are hidden or reviewed.
- Quick-win file explorer/workspace/flyout bugs are closed or explicitly
  accepted.
- Product pages clearly describe SaaS, Plus, Star, and Launchpad/Rocket.
- Linux/macOS SEA smoke passes for Plus and CLI.
