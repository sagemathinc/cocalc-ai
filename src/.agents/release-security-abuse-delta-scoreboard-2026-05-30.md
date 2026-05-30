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

- `unknown`: 7
- `guarded`: 14
- `finding`: 2
- `fixed`: 0
- `accepted-risk`: 0
- `deferred`: 0

| ID     | Area | Surface | Status | Severity | Primary Risk | Current Guardrail | Next Check | Notes |
| ------ | ---- | ------- | ------ | -------- | ------------ | ----------------- | ---------- | ----- |
| D-001 | Project viewers | Project-host viewer file service | guarded | high | Viewer reaches write/runtime project-host capabilities. | Viewer mode uses narrower read-only project-host services and UI hides most write/runtime affordances. | Re-run endpoint deny audit for runtime/start, proxy/app-server, terminal, Jupyter, Codex, SSH, secrets, snapshots/backups, settings, and collaborator paths. | Prior manual viewer demo found no obvious bugs after fixes, but endpoint regression coverage should remain explicit. |
| D-002 | Project viewers | Viewer `getListing` and sparse read policies | guarded | high | Listing leaks hidden paths or blocks discovery of allowed nested paths. | Viewer listing filters results and can expose ancestor path entries needed to reach allowed descendants. | Add/verify sparse-policy tests for allowed `/home/user/foo/bar` while listing `/home/user`. | This was a real UX/blocking bug during viewer rollout. |
| D-003 | CLI | Viewer project file commands | guarded | high | CLI uses collaborator APIs for viewers or exposes write/runtime actions. | Viewer list/cat/get were moved toward viewer-safe file APIs with explicit write/runtime denials. | Smoke `cocalc project list/cat/get` as viewer and attempt write/runtime commands. | Keep aligned with browser viewer FS surface. |
| D-004 | Access requests | Project access request flow | guarded | high | Non-member info leak, unauthorized approval, or request spam. | Signed-in-only info, default viewer request, collaborator upgrade path, manager authorization, blocking, cooldown, daily cap, notifications, and project logs. | Manual test non-member, viewer, collaborator, owner, blocked requester; verify multibay owning-bay routing. | Recent commits added the main flow and limits. |
| D-005 | Access requests | Requester blocking | guarded | medium | Harassment via repeated access requests or notifications. | Project-scoped requester blocks and unblock UI exist. | Verify blocked requester gets no new request, notification, email, or project-log spam. | Similar intent to invite blocking. |
| D-006 | Notifications | Access request notification/email fanout | unknown | medium | Email/notification spam, wrong recipient, or metadata leak. | Intended to follow existing invite notification channel and communication preferences. | Inspect notification projector/email path and duplicate suppression for access requests. | Needs comparison with invite behavior. |
| D-007 | Scratch disk | Shared scratch spend admission | finding | critical | Large scratch disk could create very high monthly cloud cost if omitted from spend enforcement. | Scratch disk hardening landed after audit found spend maintenance could omit scratch cost. | Verify all purchase, edit, resize, auto-grow, spend maintenance, and enforcement paths include `shared_disk_gb/shared_disk_type`. | This is the highest-risk changed-cost surface. |
| D-008 | Scratch disk | Scratch edit/delete authorization | unknown | high | Unauthorized user edits or deletes a shared host disk affecting all projects on host. | Host/project-host control-plane authorization exists, but changed surface needs full review. | Audit RPCs and frontend actions for owner/admin/fresh-auth expectations and host-bay routing. | Intentional all-project read/write access to mounted scratch is out of scope; control-plane disk mutation is in scope. |
| D-009 | Scratch disk | Scratch auto-grow | guarded | high | Provider resize or auto-grow bypasses pricing/admission or grows on unsupported provider. | Auto-grow gated to online-resize providers and recent host hardening exists. | Verify auto-grow rechecks admission immediately before cloud resize and logs denial. | Include Nebius high-cost cases. |
| D-010 | Codex/ACP | Codex fast service tier | guarded | high | Fast/priority tier enabled by default or silently used, causing unexpected spend. | UI makes fast explicit; backend resolves service tier and logs requested/resolved tier; standard maps to no fast tier. | Manual standard and fast turns via UI/CLI; confirm app-server receives only supported tier variants and activity log shows config. | Earlier mismatch `priority` versus `fast/flex` was found and fixed. |
| D-011 | Codex/ACP | ACP queued/running status | unknown | medium | Submitted message remains queued while work runs, causing duplicate retry or confusing state. | Recent stale queued prompt cleanup exists. | Review status transition writes and frontend reconciliation for queued-to-running. | User observed this intermittently. |
| D-012 | Codex/ACP | ACP scheduling limits | unknown | high | Unbounded queued/running turns or retry/recovery work. | May 11 audit added ACP admission limits; recent changes may interact with service tier/status. | Spot-check new ACP paths since May 11 still call admission helpers before durable enqueue or running claim. | Include automation and recovery continuations. |
| D-013 | Launchpad/PGLite | Launchpad SEA startup | guarded | medium | Single executable crashes at startup due to asset/database assumptions. | Recent Launchpad/PGLite fixes landed. | Run Launchpad SEA smoke and confirm no real Postgres behavior changed. | Item 2 in release-blocker triage. |
| D-014 | Launchpad/PGLite | PGLite transaction behavior | guarded | medium | PGLite-only transaction serialization causes deadlocks/timeouts or hides real Postgres bugs. | PGLite-specific direct/single-hub path added after test failures. | Verify guards are PGLite/local only and server/database tests pass. | Real Postgres behavior should remain unchanged. |
| D-015 | Operator tooling | Host upgrade/deploy selection | finding | high | Selecting one component upgrades disruptive unrelated services. | None confirmed. | Reproduce and fix component-selection filtering in UI/RPC. | User saw selecting only `acp-worker` upgrade router and persist too. |
| D-016 | Admin RPC | Dangerous public hub RPC drift | guarded | high | New destructive/admin RPC ships without fresh-auth classification. | Dangerous RPC registry test exists and recently caught new RPCs. | Re-run registry test after access-request and scratch work; inspect new RPC decisions. | Keep this as a regression gate. |
| D-017 | Public routes | Project URL access landing | guarded | medium | Signed-out user learns project title/owner/avatar before auth. | Plan requires sign-in before showing any project info; implementation recently added safe flow. | Manual signed-out route test plus frontend route test. | Auth-before-info is stricter than normal public docs behavior. |
| D-018 | Project viewers | Read-only previews and frame UI | guarded | medium | Viewer preview triggers compile/run/write side effects or confusing collaborator controls. | Viewer read-only mode has simplified frame title bars, reload controls, and read-only preview fixes. | Manual open md/chat/pdf/ipynb/tex/task as viewer and inspect console for collaborator/runtime errors. | Several bugs were fixed through browser testing. |
| D-019 | Runtime/proxy | Viewer runtime and app-server denial | guarded | high | Viewer starts project runtime, reaches app-server/proxy, or runs project-local code. | Viewer UI hides runtime controls; project-host access should enforce denial. | Endpoint-level deny tests or manual requests as viewer. | Do not rely only on frontend hiding controls. |
| D-020 | Project list/index | Viewer projection and project relation labels | guarded | medium | Viewer project does not show, shows wrong relation, or wrong role affects access checks. | Project list projection was updated to include viewers and relation labels. | Re-run project list tests and manual accepted-viewer flow. | Earlier viewer accepted invite did not appear in list. |
| D-021 | Dependencies/config | Dependency and default drift | unknown | high | New dependency, env default, or config opens public access or vulnerable code. | May 11 audit resolved then-known advisories. | Run `pnpm -C src version-check`, inspect lockfile changes since May 11, and reconcile advisories if needed. | Focus only changed manifests/lockfiles first. |
| D-022 | Public docs/rendering | Public-safe markdown/docs renderers | unknown | medium | Public rendering loads authenticated app-only actions or leaks private data. | Recent public-safe renderer and lazy action dependency changes exist. | Review public docs renderer imports and route behavior. | Lower priority than spend/access surfaces. |
| D-023 | Browser automation | Browser/agent auth after recent CLI work | unknown | high | Agent or browser automation can use broader auth than intended. | May 11 browser/CLI audit added caps and raw-exec policy. | Re-check new cocalc-cli viewer and access-request commands under agent auth. | Especially important for shared browser automation contexts. |

## Findings and Notes

### D-007: Shared scratch spend enforcement must be rechecked end-to-end

Initial manual audit found that spend maintenance could re-estimate active host
cost without including `shared_disk_gb` and `shared_disk_type`. That is a
critical cost-control gap because a malicious or careless user could allocate a
large scratch disk and later have background billing/enforcement overwrite the
active rate with a value that excludes the disk.

Required closeout:

- Verify purchase-session estimates include scratch.
- Verify host edit estimates include scratch.
- Verify spend maintenance includes scratch.
- Verify any active host rate recomputation includes scratch.
- Verify scratch resize/auto-grow performs admission before cloud work.
- Verify tests cover at least one high-cost scratch disk type.

### D-015: Host upgrade component selection needs a dedicated fix

Observed behavior: selecting only `acp-worker` in the upgrade UI upgraded
router and persist too. This is a high-severity operational tooling issue
because router/persist restarts are disruptive and the UI creates a false sense
of scoped action.

Required closeout:

- Identify whether the bug is frontend selection state, RPC payload, or backend
  component filtering.
- Add a focused regression test if practical.
- Manually verify a single selected component upgrades only that component.

## Manual Validation Log

Record manual runs here as the audit progresses.

| Date | Scenario | Result | Notes |
| ---- | -------- | ------ | ----- |
| 2026-05-30 | Delta audit plan created | pending | Manual validation not started in this document. |
