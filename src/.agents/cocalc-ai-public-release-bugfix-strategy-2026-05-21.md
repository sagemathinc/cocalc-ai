# CoCalc.ai Public Release Bug-Fixing Strategy

Last updated: 2026-05-21

Source blocker list: `/home/user/wstein.tasks.md`

Target: first public release of `https://cocalc.ai`, ideally within about two
weeks.

## Goal

Turn the blocker list into a focused release push that prioritizes correctness,
security, data safety, and first-run trust.

The public release should not be blocked by every rough edge. It should be
blocked by issues that can cause:

- Data loss or apparent data loss.
- Broken auth/session/security boundaries.
- Users getting stuck with no recovery path.
- Core project/file/chat workflows failing after normal operations such as
  reconnect, refresh, hub restart, project-host restart, or going offline.
- Launch-facing UX confusion in sign-in and first project workflows.

## Release Gates

Do not ship public release until these are true:

- Markdown/Slate collaborative editing is not known to lose content. **Fixed
  2026-05-21** for the reproduced unsaved-local-edit plus remote-merge data
  loss path.
- Browser file/project clients recover from hub/project-host restarts without
  requiring a page refresh.
- Cross-bay impersonation works. **Fixed 2026-05-21** via central
  impersonation grant routing plus shared-domain bay identity cookies.
- Impersonation state is persistently obvious after refresh. **Fixed
  2026-05-21** via home-bay auth bootstrap.
- Sign-in redirects to `/projects` after success.
- Passkey sign-in UI does not confuse "select passkey method" with "use
  passkey now".
- Codex/agent entry points either start a turn or show a clear actionable auth
  or runtime error.
- Project list/lifecycle state does not remain stale after start/stop.
- Storage/backup timestamps and reload buttons do not knowingly lie.
- Security/status visibility issues are resolved or explicitly scoped as admin
  only.

## Triage Buckets

### Solved During This Push

| Item                                               | Area            | Status | Resolution                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------- | --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-bay impersonation stopped working            | auth / multibay | fixed  | Grants are routed through a central seed-bay directory and token-only URLs. Grant redemption on the subject home bay now sets shared-domain `account_id` and `home_bay_id` cookies before redirecting back to the site origin.                                                                             |
| Impersonation banner disappears after refresh      | auth / admin UX | fixed  | The app now bootstraps auth state from the authoritative stored/home control-plane origin, so active impersonation sessions are read from the home bay and the banner persists after refresh. The impersonation grant URL also shows a non-consuming support confirmation page before session replacement. |
| Markdown Slate collaborative editing loses content | editor / sync   | fixed  | Added Playwright coverage for full Slate and block-mode editors where a local unsaved edit is merged with a remote update before the local debounce fires. The merged value is now forced back to the shared markdown from the current editor, so the local contribution is not only visible locally.      |
| Agent button creates message but no Codex turn     | chat / codex    | fixed  | `forceCodex: true` navigator/agent submissions now default to the standard Codex model when no explicit `codexConfig.model` is provided, so Jupyter/editor agent buttons launch ACP instead of writing an inert user message.                                                                              |

### P0: Release Blockers

These should be worked before broad UI polish.

| Item                                                      | Area                            | Risk                                         | First investigation                                                                                                   |
| --------------------------------------------------------- | ------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Offline editor switches to loading                        | editor / sync / offline         | Apparent data loss and unusable offline mode | Identify loading gate that hides existing document; keep last synced content visible and editable while reconnecting. |
| Hub/project-host restart breaks browser FS client forever | conat / files / recovery        | Core files unusable until refresh            | Reproduce with controlled restart; inspect reconnect/recovery scheduler and file client state machine.                |
| Project table stale after start                           | hub changefeeds / projections   | User sees stopped project that is running    | Trace project lifecycle event path; add watchdog/refetch when command succeeds but projection remains stale.          |
| Tiny "Loading" forever after backend upgrade              | chat / sync / recovery          | User stuck until close/reopen                | Capture stuck component state; identify missing reconnect or stale load promise.                                      |
| Agent button expired-auth path unclear                    | chat / codex / auth             | Core agent action can fail without guidance  | Ensure expired auth renders actionable payment/credentials guidance in the agent thread or launcher.                  |
| Codex live chat log drops chunks                          | chat / codex activity rendering | Users cannot trust agent output              | Compare activity drawer source with chat rendered source; find dropped grouping/render filter.                        |
| Chat scroll often near top                                | chat / UX                       | Broken long-chat usability                   | Audit scroll anchoring, initial load, archived hydration, active turn append behavior.                                |
| Hide status security issue                                | privacy / security              | Sensitive status visibility                  | Define exact policy; ensure UI and backend enforce hidden status, not UI-only.                                        |

### P1: Launch-Critical UX And Correctness

These are important for first impression and support load. Fix as many as
possible after P0s are under control.

| Item                                                          | Area                           | Risk                              | First investigation                                                                                     |
| ------------------------------------------------------------- | ------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Disk usage reload says "Updated just now" without recomputing | storage UI / quota             | Misleading quota data             | Separate "refresh cached state" from "recompute usage"; show recompute pending/running/completed time.  |
| Backup time in storage overview appears random                | backups / storage UI           | Users cannot trust backups        | Confirm latest backup source field; ensure overview and tooltip use same authoritative timestamp.       |
| Sign-in success leaves user on sign-in page                   | auth / routing                 | First-run confusion               | Fix post-auth redirect target to `/projects`; preserve intended redirect only when safe.                |
| Right after sign-in load `/projects`, not `/`                 | auth / routing                 | First-run confusion               | Same as above; add regression around auth completion.                                                   |
| Passkey selector looks like primary action                    | auth UI                        | User confusion                    | Make auth method selection look like segmented/radio choice; reserve primary button for actual sign-in. |
| Passkey triggers password save/autofill into unrelated fields | auth UI / browser autocomplete | Bad auth UX                       | Review form names/autocomplete attributes; avoid username-like fields leaking to host search.           |
| SSO domain check row jumps during sign-in/up                  | auth UI                        | Visual instability                | Reserve space or use inline spinner without adding/removing rows.                                       |
| Bulk delete hits queued/running project delete limit          | projects / workers             | User cannot clean up projects     | Serialize user bulk delete one-at-a-time or raise limit with backpressure; show progress.               |
| Delete files modal breaks with many files                     | file UI                        | Simple operation looks broken     | Use scrollable file list and concise summary after first N files.                                       |
| Agent view missing thread `...` menu/configuration            | chat UI                        | Missing essential thread controls | Share thread action menu with normal chat view.                                                         |
| Community support page stale                                  | support / content              | Launch support confusion          | Remove dead Discord/Google Group/GitHub Discussions references; verify Zendesk path.                    |
| Project quota/memory should apply at start/restart            | projects / quotas              | Membership changes appear ignored | Confirm current runtime quota source on every start; invalidate stale cached limits.                    |

### P2: Important But Can Ship With Known Notes

These are important but can be scheduled after the first public launch if P0/P1
remain active.

| Item                                          | Area                         | Risk                           | First investigation                                                            |
| --------------------------------------------- | ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------ |
| Postgres WAL logs not trimmed                 | infra / backup retention     | Disk growth                    | Define retention relative to last two snapshots; measure six-hour WAL volume.  |
| Project/account "name" fields appear unused   | product / security / sharing | Confusing and maybe misleading | Confirm no vanity URL dependency; hide/deprecate from UI if unused.            |
| Nebius H200 Python ML packages do not see GPU | GPU images / host runtime    | GPU product credibility        | Test CUDA/PyTorch/TensorFlow image expectations separately from host hardware. |
| Nebius/R2 backup throughput slow              | backups / host network       | Poor large-project performance | Benchmark disk, network, R2 region path, rustic config.                        |

## Workstreams

### A. Auth, Session, And Admin Safety

Primary files/packages to inspect:

- `src/packages/frontend/account`
- `src/packages/frontend/auth` if present
- `src/packages/conat/hub/api/system.ts`
- `src/packages/conat/hub/api/accounts*`
- `src/packages/database`
- `src/.agents/scalable-architecture.md`

Scope:

- Cross-bay impersonation. **Fixed 2026-05-21.**
- Persistent impersonation banner. **Fixed 2026-05-21.**
- Sign-in redirect to `/projects`.
- Passkey selector/action distinction.
- Browser autocomplete/passkey password-save behavior.
- SSO domain-check layout stability.

Acceptance:

- Manual cross-bay impersonation smoke test passes. **Done for
  `wstein+1@gmail.com`, home bay `bay-1`.**
- Refresh while impersonating still shows obvious banner. **Done for
  cross-bay lite4b dogfood.**
- Sign-in lands on `/projects`.
- Passkey method choice and passkey submit are visually distinct.
- Chrome no longer offers to save a password after passkey auth.
- SSO check does not shift the form vertically.

### B. Sync, Recovery, And Data Safety

Primary files/packages to inspect:

- `src/packages/conat`
- `src/packages/frontend/project`
- `src/packages/frontend/frame-editors`
- `src/packages/frontend/editors/slate`
- `src/packages/sync`

Scope:

- Markdown Slate collaborative editing data loss. **Fixed 2026-05-21** for the
  reproduced remote-merge write-back failure; remaining Slate caret/selection
  flakiness is tracked separately.
- Offline editor should remain visible/editable.
- Browser FS client recovery after hub/project-host restart.
- Tiny loading forever after backend upgrades.
- Project list stale lifecycle state.

Acceptance:

- Two-browser concurrent Markdown editing test does not delete content.
- Simulated offline keeps editor content visible and editable.
- Restarting hub/project-host recovers without browser refresh.
- Project start/stop UI converges to real state.
- Stuck loading state has a timeout/recovery path and diagnostics.

### C. Chat And Codex Reliability

Primary files/packages to inspect:

- `src/packages/frontend/chat`
- `src/packages/lite/hub/acp`
- `src/packages/conat/ai`
- `src/packages/conat/project`

Scope:

- Agent action creates message but turn does not start. **Fixed 2026-05-21**
  for the missing default Codex model path.
- Codex auth expired should be surfaced before or immediately after action.
- Live chat log drops output chunks.
- Chat scroll position starts near top.
- Agent view missing thread menu/config.

Acceptance:

- Agent button either starts a turn or renders actionable failure. **Partly
  done 2026-05-21** for no-explicit-model Codex agent submissions.
- Expired Codex auth path links to payment/credentials configuration.
- Chat-rendered activity and activity drawer show the same chunks.
- Chat opens anchored to recent messages unless user explicitly scrolled.
- Agent view has the same thread menu/config affordance as normal chat.

### D. Storage, Backups, Quotas, And Deletes

Primary files/packages to inspect:

- `src/packages/frontend/project/settings`
- `src/packages/frontend/projects`
- `src/packages/conat/hub/api/projects.ts`
- `src/packages/project-host`
- `src/packages/server`

Scope:

- Disk usage reload lie.
- Backup timestamp randomness.
- Project runtime quotas at start/restart.
- Bulk project delete queue limit.
- File delete modal overflow.
- WAL retention.

Acceptance:

- Disk usage UI distinguishes cached values from recompute jobs.
- Backup overview and tooltip use authoritative latest backup timestamp.
- Start/restart uses current membership/default quotas.
- Bulk delete completes sequentially with progress or clear queuing.
- File delete modal remains readable for large selections.
- WAL retention is bounded and documented.

### E. Launch Content And GPU Acceptance

Primary files/packages to inspect:

- `src/packages/frontend/support`
- `src/packages/project-host`
- rootfs/image build definitions
- host provisioning docs/scripts

Scope:

- Community support page stale links.
- Zendesk path verification.
- Nebius H200 image GPU usability.
- Backup and disk throughput on GPU hosts.

Acceptance:

- Support page contains only active support channels.
- Zendesk support path is tested.
- `nvidia-smi`, PyTorch CUDA, and TensorFlow CUDA expectations are documented
  and tested for H200 images.
- GPU host backup/disk throughput has benchmark numbers and next action.

## First 48 Hours Execution Plan

1. Fix or disable cross-bay impersonation failure. **Done 2026-05-21.**
2. Make impersonation banner persistent after refresh. **Done 2026-05-21.**
3. Reproduce Markdown Slate collaborative data loss with a minimal harness.
   **Done 2026-05-21.**
4. Reproduce hub/project-host restart FS-client failure with a scripted smoke
   test.
5. Fix sign-in redirect to `/projects` and passkey method/action confusion.
6. Fix Codex agent-button silent failure path, especially expired auth.
7. Fix the Codex live-log dropped-output rendering bug or add instrumentation
   that proves where output is filtered.
8. Fix disk usage reload wording or recompute semantics.

## Bug Fix Workflow

For each blocker:

1. Add a short note under this file or a dedicated issue doc with:
   - exact reproduction steps,
   - observed behavior,
   - expected behavior,
   - likely package/files,
   - whether it is single-bay or multibay relevant.
2. Write a regression test or smoke script before or alongside the fix when
   practical.
3. Prefer small commits grouped by subsystem.
4. Run package-local validation first.
5. For browser/runtime issues, validate with the correct env:
   - `cd src && eval "$(pnpm -s dev:hub:env)"`
   - use the exact CoCalc CLI path when browser automation is needed.
6. Mark each item as:
   - `fixed`,
   - `mitigated for release`,
   - `needs live dogfood`,
   - `deferred with explicit risk`.

## Suggested Commit Batches

### Batch 1: Auth And Admin Safety

- Sign-in redirect to `/projects`.
- Passkey selector visual fix.
- SSO layout stability.
- Impersonation banner persistence. **Done 2026-05-21.**
- Cross-bay impersonation fix. **Done 2026-05-21.**

### Batch 2: Editor And Recovery Correctness

- Markdown Slate collaborative editing fix.
- Offline editor visibility.
- FS client restart recovery.
- Project table stale-state convergence.

### Batch 3: Codex/Chat Reliability

- Agent button no-explicit-model launch failure. **Done 2026-05-21.**
- Agent button expired-auth/preflight guidance.
- Live log dropped chunks.
- Scroll anchoring.
- Agent view thread menu.

### Batch 4: Storage And Quota Honesty

- Disk usage reload/recompute.
- Backup timestamp source.
- Runtime quotas on start/restart.
- Bulk delete behavior.
- Delete modal overflow.

### Batch 5: Launch Polish And Infra Cleanup

- Community support page.
- WAL retention.
- Project/account name deprecation decision.
- Nebius H200 acceptance notes/fixes.

## Open Questions

- Should cross-bay impersonation be launch-blocking if public launch is
  single-bay only, or should the UI explicitly disable it outside same-bay? (YES: launch blocking; it's critical for support. We will definitely be able to fix this, as we've fixed many similar issues - it's just multibay correctness and design. It's also EASY to reproduce, fortunately.)
  **RESOLVED 2026-05-21:** keep it enabled; cross-bay impersonation now works
  in lite4b dogfood.
- What is the minimal acceptable Markdown collaboration behavior for public
  launch: Slate fixed, or Slate markdown collaboration temporarily disabled? (ANS: fixed -- this is a core part of the value prop of cocalc, and only recently broke.)
- Should offline editing be fully writable for public launch, or is "visible
  read-only with reconnect status" acceptable as a mitigation? (ANS: visible but read only is fine -- people can copy/paste; the point is to not prevent them from even seeing/access content they were just using)
- Should the first public release include Nebius H200 as a supported path, or
  mark GPU hosts as preview until CUDA package expectations are solved? (ANS: yes, absolutely critical. We had it working before too, and it's likely not hard. E.g., nvidia-smi is there and working, so the hard podman integration stuff is done and working. Maybe it's just a version bump or something.)
- What exact support channels should remain on the community support page? (ANS: maybe we just remove it. So far there has been no momentum with any approaches -- maybe discord was the most popular historically. Maybe you can suggest a strategy here? But for "release blocker" bug, just hiding the page would be sufficient. In practice, I think people talk privately in their own forums.)
