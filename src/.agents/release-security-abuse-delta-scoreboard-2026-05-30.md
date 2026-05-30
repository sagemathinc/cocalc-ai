# Release Security and Abuse Delta Scoreboard

Status: started, 2026-05-30.

This scoreboard tracks the changed-surface audit described in
[release-security-abuse-delta-audit-plan-2026-05-30.md](./release-security-abuse-delta-audit-plan-2026-05-30.md).
It is scoped to work landed after the 2026-05-11 release security audit.

Statuses:

- `unknown`: not audited in this delta pass.
- `investigating`: actively being inspected.
- `finding`: concrete issue found; fix or risk decision needed.
- `fixed`: code fix landed and focused validation passed.
- `guarded`: protections exist, but broader policy or manual validation remains.
- `accepted-risk`: explicitly accepted for this release with reason.
- `deferred`: not release-blocking; follow-up item should exist.

## Summary

Current score:

- `unknown`: 1
- `guarded`: 17
- `finding`: 0
- `fixed`: 5
- `accepted-risk`: 0
- `deferred`: 0

| ID    | Area                  | Surface                                       | Status  | Severity | Primary Risk                                                                                    | Current Guardrail                                                                                                                                                                                    | Next Check                                                                                                                                                   | Notes                                                                                                                                      |
| ----- | --------------------- | --------------------------------------------- | ------- | -------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| D-001 | Project viewers       | Project-host viewer file service              | guarded | high     | Viewer reaches write/runtime project-host capabilities.                                         | Viewer mode uses narrower read-only project-host services and UI hides most write/runtime affordances.                                                                                               | Re-run endpoint deny audit for runtime/start, proxy/app-server, terminal, Jupyter, Codex, SSH, secrets, snapshots/backups, settings, and collaborator paths. | Prior manual viewer demo found no obvious bugs after fixes, but endpoint regression coverage should remain explicit.                       |
| D-002 | Project viewers       | Viewer `getListing` and sparse read policies  | guarded | high     | Listing leaks hidden paths or blocks discovery of allowed nested paths.                         | Viewer listing filters results and can expose ancestor path entries needed to reach allowed descendants.                                                                                             | Add/verify sparse-policy tests for allowed `/home/user/foo/bar` while listing `/home/user`.                                                                  | This was a real UX/blocking bug during viewer rollout.                                                                                     |
| D-003 | CLI                   | Viewer project file commands                  | guarded | high     | CLI uses collaborator APIs for viewers or exposes write/runtime actions.                        | Viewer list/cat/get were moved toward viewer-safe file APIs with explicit write/runtime denials.                                                                                                     | Smoke `cocalc project list/cat/get` as viewer and attempt write/runtime commands.                                                                            | Keep aligned with browser viewer FS surface.                                                                                               |
| D-004 | Access requests       | Project access request flow                   | guarded | high     | Non-member info leak, unauthorized approval, or request spam.                                   | Signed-in-only info, default viewer request, collaborator upgrade path, manager authorization, blocking, cooldown, daily cap, notifications, and project logs.                                       | Manual test non-member, viewer, collaborator, owner, blocked requester; verify multibay owning-bay routing.                                                  | Recent commits added the main flow and limits.                                                                                             |
| D-005 | Access requests       | Requester blocking                            | guarded | medium   | Harassment via repeated access requests or notifications.                                       | Project-scoped requester blocks and unblock UI exist.                                                                                                                                                | Verify blocked requester gets no new request, notification, email, or project-log spam.                                                                      | Similar intent to invite blocking.                                                                                                         |
| D-006 | Notifications         | Access request notification/email fanout      | guarded | medium   | Email/notification spam, wrong recipient, or metadata leak.                                     | Access requests create durable account-notice events only for authorized approvers, pending-request edits do not notify again, and owner-only management excludes ordinary collaborators.            | Manual notification-center smoke should verify inbox/email preference behavior on the notification transport side.                                           | No direct email send happens in the access-request RPC; it uses the shared notification outbox layer.                                      |
| D-007 | Scratch disk          | Shared scratch spend admission                | fixed   | critical | Large scratch disk could create very high monthly cloud cost if omitted from spend enforcement. | Purchase, edit, resize, spend maintenance, and background shared scratch auto-grow now price with `shared_disk_gb/shared_disk_type`; auto-grow reconciles the active purchase session after resize.  | Keep full server package tests in release validation.                                                                                                        | Focused auto-grow regression covers pre-resize denial and post-resize purchase reconciliation.                                             |
| D-008 | Scratch disk          | Scratch edit/delete authorization             | fixed   | high     | Unauthorized user edits or deletes a shared host disk affecting all projects on host.           | Scratch create/edit/delete runs through host owner-only `updateHostMachine`, cloud mutations require fresh auth, and live delete now reconciles active billing to the post-delete non-scratch rate.  | Manual live host delete smoke should confirm the provider disk is removed, `/scratch` unmounted, and the purchase session rate drops.                        | Intentional all-project read/write access to mounted scratch is out of scope; control-plane disk mutation is in scope.                     |
| D-009 | Scratch disk          | Scratch auto-grow                             | fixed   | high     | Provider resize or auto-grow bypasses pricing/admission or grows on unsupported provider.       | Shared scratch auto-grow re-estimates the next rate, checks billing runway before cloud resize, reconciles the active purchase session after resize, and remains gated to online-resize providers.   | Keep Nebius high-cost manual/provider validation in the broader host smoke pass.                                                                             | Fixed in `project-host/auto-grow.ts` with focused regression coverage.                                                                     |
| D-010 | Codex/ACP             | Codex fast service tier                       | guarded | high     | Fast/priority tier enabled by default or silently used, causing unexpected spend.               | UI makes fast explicit; backend resolves service tier and logs requested/resolved tier; standard maps to no fast tier.                                                                               | Manual standard and fast turns via UI/CLI; confirm app-server receives only supported tier variants and activity log shows config.                           | Earlier mismatch `priority` versus `fast/flex` was found and fixed.                                                                        |
| D-011 | Codex/ACP             | ACP queued/running status                     | guarded | medium   | Submitted message remains queued while work runs, causing duplicate retry or confusing state.   | Backend queued-job startup clears prompt `acp_state: queued`; ChatStreamWriter writes running thread-state for the assistant turn; frontend sync drops stale prompt queue state when the reply runs. | Keep focused chat writer and frontend sync tests in release validation; manually watch for stale queued labels during ACP smoke.                             | User observed this intermittently; no current code gap found in focused audit.                                                             |
| D-012 | Codex/ACP             | ACP scheduling limits                         | guarded | high     | Unbounded queued/running turns or retry/recovery work.                                          | Chat turns and automations check creation admission before enqueue; detached workers check running admission before transactional claim; project-host workers use actor effective limits.            | Manual high-volume queue smoke is still useful, especially across worker restart and recovery continuation paths.                                            | Recovery continuations bypass queued/created counters only after an admitted parent job and are capped to one continuation per parent.     |
| D-013 | Launchpad/PGLite      | Launchpad SEA startup                         | guarded | medium   | Single executable crashes at startup due to asset/database assumptions.                         | Recent Launchpad/PGLite fixes landed.                                                                                                                                                                | Run Launchpad SEA smoke and confirm no real Postgres behavior changed.                                                                                       | Item 2 in release-blocker triage.                                                                                                          |
| D-014 | Launchpad/PGLite      | PGLite transaction behavior                   | guarded | medium   | PGLite-only transaction serialization causes deadlocks/timeouts or hides real Postgres bugs.    | PGLite-specific direct/single-hub path added after test failures.                                                                                                                                    | Verify guards are PGLite/local only and server/database tests pass.                                                                                          | Real Postgres behavior should remain unchanged.                                                                                            |
| D-015 | Operator tooling      | Host upgrade/deploy selection                 | fixed   | high     | Selecting one component upgrades disruptive unrelated services.                                 | Per-component deploy now sets the selected component desired version and immediately rolls out only that selected component instead of invoking full-stack project-host upgrade alignment.           | Manual browser smoke should verify selecting ACP worker does not restart router or persist.                                                                  | User saw selecting only `acp-worker` upgrade router and persist too; root cause was frontend immediate action using `align_runtime_stack`. |
| D-016 | Admin RPC             | Dangerous public hub RPC drift                | guarded | high     | New destructive/admin RPC ships without fresh-auth classification.                              | Dangerous RPC registry test exists and recently caught new RPCs.                                                                                                                                     | Re-run registry test after access-request and scratch work; inspect new RPC decisions.                                                                       | Keep this as a regression gate.                                                                                                            |
| D-017 | Public routes         | Project URL access landing                    | guarded | medium   | Signed-out user learns project title/owner/avatar before auth.                                  | Plan requires sign-in before showing any project info; implementation recently added safe flow.                                                                                                      | Manual signed-out route test plus frontend route test.                                                                                                       | Auth-before-info is stricter than normal public docs behavior.                                                                             |
| D-018 | Project viewers       | Read-only previews and frame UI               | guarded | medium   | Viewer preview triggers compile/run/write side effects or confusing collaborator controls.      | Viewer read-only mode has simplified frame title bars, reload controls, and read-only preview fixes.                                                                                                 | Manual open md/chat/pdf/ipynb/tex/task as viewer and inspect console for collaborator/runtime errors.                                                        | Several bugs were fixed through browser testing.                                                                                           |
| D-019 | Runtime/proxy         | Viewer runtime and app-server denial          | guarded | high     | Viewer starts project runtime, reaches app-server/proxy, or runs project-local code.            | Viewer UI hides runtime controls; project-host access should enforce denial.                                                                                                                         | Endpoint-level deny tests or manual requests as viewer.                                                                                                      | Do not rely only on frontend hiding controls.                                                                                              |
| D-020 | Project list/index    | Viewer projection and project relation labels | guarded | medium   | Viewer project does not show, shows wrong relation, or wrong role affects access checks.        | Project list projection was updated to include viewers and relation labels.                                                                                                                          | Re-run project list tests and manual accepted-viewer flow.                                                                                                   | Earlier viewer accepted invite did not appear in list.                                                                                     |
| D-021 | Dependencies/config   | Dependency and default drift                  | fixed   | high     | New dependency, env default, or config opens public access or vulnerable code.                  | Dependency consistency passes; production and dev audits are clean after raising vulnerable `tmp` and `qs` pins/overrides.                                                                           | Keep `version-check` plus prod/dev audit in release validation.                                                                                              | Audit found `tmp <0.2.6` in `project` and `qs <=6.15.1` via `express`; both were updated.                                                  |
| D-022 | Public docs/rendering | Public-safe markdown/docs renderers           | guarded | medium   | Public rendering loads authenticated app-only actions or leaks private data.                    | Public docs pass no private state or action runner, admin/signed-in docs are excluded by default, and project/host action selectors are dynamically imported only when app action execution exists.  | Keep public docs route tests in release validation; raw HTML in repo-authored docs remains a code-review concern, not a user-content surface.                | Focused public docs and docs-browser tests pass; test run still emits existing Ant Design act warnings.                                    |
| D-023 | Browser automation    | Browser/agent auth after recent CLI work      | unknown | high     | Agent or browser automation can use broader auth than intended.                                 | May 11 browser/CLI audit added caps and raw-exec policy.                                                                                                                                             | Re-check new cocalc-cli viewer and access-request commands under agent auth.                                                                                 | Especially important for shared browser automation contexts.                                                                               |

## Findings and Notes

### D-007: Shared scratch spend enforcement fixed for auto-grow

Initial manual audit found that spend maintenance could re-estimate active host
cost without including `shared_disk_gb` and `shared_disk_type`. That is a
critical cost-control gap because a malicious or careless user could allocate a
large scratch disk and later have background billing/enforcement overwrite the
active rate with a value that excludes the disk.

Closeout evidence:

- Purchase-session estimates include scratch through
  `estimateDedicatedHostRateUsdPerHour`.
- Host edit estimates include scratch before interactive resize.
- Spend maintenance includes scratch when recomputing active host rates.
- Background shared scratch auto-grow now estimates the next scratch-inclusive
  rate, checks billing runway before cloud resize, and reconciles the active
  purchase session after successful resize.
- Focused regression:
  `pnpm test project-host/auto-grow.test.ts` in `src/packages/server`.

### D-015: Host upgrade component selection needs a dedicated fix

Observed behavior: selecting only `acp-worker` in the upgrade UI upgraded
router and persist too. This is a high-severity operational tooling issue
because router/persist restarts are disruptive and the UI creates a false sense
of scoped action.

Closeout evidence:

- The bug was in the frontend per-component deploy path. It correctly wrote the
  selected component deployment, but then immediately called host software
  upgrade with `align_runtime_stack: true`, which intentionally rolls
  project-host, conat-router, conat-persist, and acp-worker together.
- The immediate action now calls `rolloutHostManagedComponents` with exactly the
  selected component.
- Manual browser smoke should still verify ACP worker selection leaves router
  and persist untouched in the live UI.

### D-008: Scratch edit/delete authorization and billing closeout

Control-plane scratch disk mutation is owner-only: `updateHostMachine` calls
`loadOwnedHost`, which requires the caller to match `project_hosts.metadata.owner`.
The RPC is also classified as fresh-auth-required, and cloud scratch delete uses
host-control unmount plus provider disk deletion before metadata is persisted.

One adjacent billing gap was fixed during the audit: live scratch delete
previously skipped active purchase-session reconciliation. The delete path now
re-estimates the running host rate without `shared_disk_gb/shared_disk_type`,
updates host billing metadata, and reconciles the active purchase session.
Focused regression: `pnpm test conat/api/hosts.test.ts` in
`src/packages/server`.

### D-006: Access-request notification fanout guarded

Access request creation uses `createNotificationEventGraph` rather than direct
email sends. The notification payload goes only to accounts that can approve the
request: owners always, and collaborators only when project settings allow
collaborator management. Existing pending-request edits intentionally skip both
project-log and notification fanout, which limits repeated-notification spam.
Request decisions notify only the requester.

Focused regression: `pnpm test projects/collaborators.test.ts` in
`src/packages/server`, including owner-only fanout coverage.

### D-011: ACP queued/running status guarded

The intermittent "submitted message stays queued while the turn is running"
symptom is covered at both persistence boundaries. When a queued job is claimed,
`prepareQueuedUserMessageForExecution` clears the prompt row's
`acp_state: queued` before execution. When the assistant writer starts,
`ChatStreamWriter` writes running thread-state for the assistant message. The
frontend sync layer also reconciles stale prompt queue state away when
thread-state points at the running assistant reply, while preserving genuinely
queued follow-up messages.

Focused regressions:

- `pnpm test hub/acp/__tests__/chat-writer.test.ts` in `src/packages/lite`.
- `pnpm test chat/__tests__/normalize.test.ts` in `src/packages/frontend`.

### D-021: Dependency audit drift fixed

The dependency/config drift pass found two current audit advisories after the
May 11 baseline:

- `tmp <0.2.6` through `@cocalc/project`.
- `qs <=6.15.1` through `http-api > express`.

The direct `tmp` dependency and workspace override were raised to `0.2.6`, and
the `qs` override now requires `>=6.15.2`. The lockfile resolves both patched
versions.

Focused validation:

- `pnpm -C src version-check`.
- `pnpm -C src/packages audit --prod`.
- `pnpm -C src/packages audit --dev`.
- `pnpm tsc --build` in `src/packages/project`.

### D-022: Public docs/rendering guarded

Public docs are built from static `@cocalc/docs` entries. The public route does
not pass private docs state or `onRunAction`, so private learning state is not
rendered and project/project-host action selectors do not dynamically import
`app-framework` or `webapp-client`. Admin and signed-in-only entries are
excluded by default through the `DocsAccess` registry filters.

One boundary remains worth remembering: docs markdown uses the lightweight
HTML-based renderer, but the content is repository-authored, not user supplied.
Treat raw HTML in docs content as a code-review concern.

Focused validation:

- `pnpm test public/docs/__tests__/app.test.tsx docs/browser.test.tsx` in
  `src/packages/frontend`.

### D-012: ACP scheduling limits guarded

The changed ACP paths still route through admission before durable enqueue or
running claim:

- chat turns call `admitAcpJobCreation` before `enqueueAcpJob`.
- manual/scheduled automations check active automation and job creation limits.
- detached workers call `admitAcpJobExecution` before claim and pass running
  caps into the transactional SQLite claim.
- project-host ACP workers install a limits provider backed by actor account
  effective limits, falling back to project-owner limits when no actor is known.

Recovery continuations intentionally bypass queued/created counters, but only
after a parent job exists and only one continuation can be queued per parent
operation. Focused regression:
`pnpm test hub/acp/__tests__/acp-jobs.test.ts hub/acp/__tests__/detached-worker.test.ts`
in `src/packages/lite`.

## Manual Validation Log

Record manual runs here as the audit progresses.

| Date       | Scenario                 | Result  | Notes                                           |
| ---------- | ------------------------ | ------- | ----------------------------------------------- |
| 2026-05-30 | Delta audit plan created | pending | Manual validation not started in this document. |
