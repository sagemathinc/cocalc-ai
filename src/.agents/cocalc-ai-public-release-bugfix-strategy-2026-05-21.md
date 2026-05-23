# CoCalc.ai Public Release Bug-Fixing Strategy

Last updated: 2026-05-22

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
  requiring a page refresh. **Fixed 2026-05-22** for the reproduced project-host
  stop/start editor path; continue dogfooding chat/flyout variants.
- Cross-bay impersonation works. **Fixed 2026-05-21** via central
  impersonation grant routing plus shared-domain bay identity cookies.
- Impersonation state is persistently obvious after refresh. **Fixed
  2026-05-21** via home-bay auth bootstrap.
- Sign-in redirects to `/projects` after success. **Fixed 2026-05-22.**
- Passkey sign-in UI does not confuse "select passkey method" with "use
  passkey now". **Fixed 2026-05-22.**
- Codex/agent entry points either start a turn or show a clear actionable auth
  or runtime error.
- Project list/lifecycle state does not remain stale after start/stop. **Fixed
  2026-05-22**; likely resolved by recent Conat socket/reconnect fixes and not
  observed in several days.
- Storage/backup timestamps and reload buttons do not knowingly lie.
- Security/status visibility issues are resolved. **Fixed 2026-05-22** by
  deleting the public status page/footer link and unregistering the public
  `/stats` endpoint.

## Triage Buckets

### Solved During This Push

| Item                                                 | Area              | Status | Resolution                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------- | ----------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cross-bay impersonation stopped working              | auth / multibay   | fixed  | Grants are routed through a central seed-bay directory and token-only URLs. Grant redemption on the subject home bay now sets shared-domain `account_id` and `home_bay_id` cookies before redirecting back to the site origin.                                                                             |
| Impersonation banner disappears after refresh        | auth / admin UX   | fixed  | The app now bootstraps auth state from the authoritative stored/home control-plane origin, so active impersonation sessions are read from the home bay and the banner persists after refresh. The impersonation grant URL also shows a non-consuming support confirmation page before session replacement. |
| Markdown Slate collaborative editing loses content   | editor / sync     | fixed  | Added Playwright coverage for full Slate and block-mode editors where a local unsaved edit is merged with a remote update before the local debounce fires. The merged value is now forced back to the shared markdown from the current editor, so the local contribution is not only visible locally.      |
| Agent button creates message but no Codex turn       | chat / codex      | fixed  | `forceCodex: true` navigator/agent submissions now default to the standard Codex model when no explicit `codexConfig.model` is provided, so Jupyter/editor agent buttons launch ACP instead of writing an inert user message.                                                                              |
| Agent button expired-auth path unclear               | chat / codex      | fixed  | Pre-ack Codex auth failures now leave the user message retryable, write one concise auth-expired reply, show a credentials action, and label the retry control `Submit again`. The Codex credentials panel now strongly recommends ChatGPT/Codex subscription auth while keeping API keys as fallback.     |
| Offline editor switches to loading/read-only         | editor / sync     | fixed  | SyncDoc and editor state now treat routed project-host disconnects as recoverable transport loss instead of fatal document close. Existing editor content stays mounted and editable while reconnecting.                                                                                                   |
| Project-host restart breaks open editors             | conat / sync      | fixed  | Same-address routed project-host reconnects preserve the Conat client and SyncDoc table state instead of rebuilding editor state. Repeated reconnect failures refresh auth/browser-session state in place. Verified with live `host1` stop/start dogfood.                                                  |
| Node 26 fails on project hosts without libatomic     | host bootstrap    | fixed  | Added `libatomic1` to project-host bootstrap/install paths and verified Node 26 on `host1`. This was a release blocker because project-host daemons could fail before any frontend recovery logic mattered.                                                                                                |
| Codex live chat log drops chunks                     | chat / codex      | fixed  | Fixed the efficient `acp_live_preview_stream` instead of bypassing it. The preview stream now carries lifecycle status, actual agent `message` events, summaries, and errors, but no `thinking` payloads or synthetic activity ticks that can split progressive agent output.                              |
| Sign-in success leaves user on sign-in page          | auth / routing    | fixed  | Default public and legacy auth completion now redirects to `/projects`; explicit safe redirect targets are still preserved for flows that need them.                                                                                                                                                       |
| Passkey selector looks like primary action           | auth UI           | fixed  | Second-factor method selection now renders as a small chooser group (`Passkey` / `Code`) while the primary submit button remains the actual passkey action.                                                                                                                                                |
| Passkey password-save/autofill confusion             | auth UI           | fixed  | Showing the account email in the passkey modal solved the observed Chrome password-save/autofill confusion and gives useful context during passkey auth.                                                                                                                                                   |
| SSO domain check row jumps during sign-in/up         | auth UI           | fixed  | The sign-in-method policy check now uses reserved inline status space under the email field instead of adding/removing a full alert row while typing.                                                                                                                                                      |
| Project table stale after start                      | projects / sync   | fixed  | No longer observed after the recent Conat socket/reconnect fixes. Treat as fixed by side effect, with dogfood monitoring rather than additional speculative work.                                                                                                                                          |
| Tiny "Loading" forever after backend upgrade         | chat / sync       | fixed  | Fixed by commit `a003b54d95`, which typed recoverable SyncDoc tables explicitly and avoided treating recoverable backend reconnect state as a permanent loading state.                                                                                                                                     |
| Hide status security issue                           | public / security | fixed  | Deleted the public `/support/status` route, removed the footer/support index links to it, removed the frontend `/stats` fetch path, and stopped registering the public `/stats` Express route. Realtime monitoring/load information should not be public.                                                  |
| Chat scroll often near top                           | chat / UX         | fixed  | Added chat-specific viewport anchors keyed by message date plus pixel offset, independent of Virtuoso snapshots. The chat now captures the top visible message while reading and reasserts that anchor across remounts, visibility changes, message list changes, image loads, and item resizes.           |
| Agent view missing thread menu/config                | chat UI           | fixed  | Extracted the normal chat thread `...` menu into a reusable component and mounted it in inline agent chat. The agent flyout/home agent now expose appearance, behavior, export/import/fork, clear, pin/archive, and delete actions through the same handler stack as full chat.                            |
| Backup timestamp source consistency                  | backups / hosts   | fixed  | Scheduled/automatic rustic backups now report the actual created backup snapshot time through `hosts.recordProjectBackup`, keeping `projects.last_backup` aligned with backup indexes and host backup health/needs-backup accounting.                                                                      |
| Bulk delete hits queued/running project delete limit | projects / delete | fixed  | Browser bulk leave/delete now submits projects sequentially. When a hard delete is queued, the browser waits until that project delete LRO leaves queued/running state before submitting the next hard delete, preserving backend limits and making close-tab cancellation natural.                        |
| Project quota/memory should apply at start/restart   | projects / quotas | fixed  | Start/restart now uses current membership/default quotas by sharing the same membership/sponsor-aware `run_quota` path used by project starts. Stopped projects' stored `run_quota` is updated during admin quota changes, and host restart recomputes before re-starting projects.                        |

### P0: Release Blockers

No known P0 release blockers remain in this tracker.

### P1: Launch-Critical UX And Correctness

These are important for first impression and support load. Fix as many as
possible after P0s are under control.

| Item                                                 | Area                 | Risk                          | First investigation                                                                               |
| ---------------------------------------------------- | -------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Backup time in storage overview appears random       | backups / storage UI | Users cannot trust backups    | Confirm latest backup source field; ensure overview and tooltip use same authoritative timestamp. |
| Bulk delete hits queued/running project delete limit | projects / workers   | User cannot clean up projects | Serialize user bulk delete one-at-a-time or raise limit with backpressure; show progress.         |
| Delete files modal breaks with many files            | file UI              | Simple operation looks broken | Use scrollable file list and concise summary after first N files.                                 |
| Community support page stale                         | support / content    | Launch support confusion      | Remove dead Discord/Google Group/GitHub Discussions references; verify Zendesk path.              |

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
- Sign-in redirect to `/projects`. **Fixed 2026-05-22.**
- Passkey selector/action distinction. **Fixed 2026-05-22.**
- Browser autocomplete/passkey password-save behavior. **Fixed 2026-05-22.**
- SSO domain-check layout stability. **Fixed 2026-05-22.**

Acceptance:

- Manual cross-bay impersonation smoke test passes. **Done for
  `wstein+1@gmail.com`, home bay `bay-1`.**
- Refresh while impersonating still shows obvious banner. **Done for
  cross-bay lite4b dogfood.**
- Sign-in lands on `/projects`. **Done 2026-05-22.**
- Passkey method choice and passkey submit are visually distinct. **Done
  2026-05-22.**
- Chrome no longer offers to save a password after passkey auth. **Done
  2026-05-22.**
- SSO check does not shift the form vertically. **Done 2026-05-22.**

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
- Offline editor should remain visible/editable. **Fixed 2026-05-22** for the
  reproduced project-host daemon stop/start path.
- Browser FS client recovery after hub/project-host restart. **Fixed
  2026-05-22** for open editor SyncDocs; continue to watch chat/flyout listing
  recovery as separate components.
- Tiny loading forever after backend upgrades. **Fixed 2026-05-22** by
  `a003b54d95`.
- Project list stale lifecycle state. **Fixed 2026-05-22** by recent Conat
  reconnect/socket fixes; continue dogfooding.

Acceptance:

- Two-browser concurrent Markdown editing test does not delete content.
- Simulated offline keeps editor content visible and editable.
- Restarting project-host recovers open editors without browser refresh. **Done
  2026-05-22** in live `host1` testing.
- Project start/stop UI converges to real state. **Done 2026-05-22** by
  dogfood observation after recent reconnect fixes.
- Stuck loading state has a timeout/recovery path and diagnostics. **Done
  2026-05-22** for the backend-upgrade loading repro.

Notes:

- The SyncDoc design rule is now explicit: a SyncDoc close means intentional
  disposal or unrecoverable identity/permission failure, not ordinary network,
  host, or Conat transport reconnect. Recoverable tables are typed explicitly
  instead of detected by loose `any` checks.
- A one-off Slate content-doubling observation after reconnect was not
  reproduced after clean daemon stop/start. Treat future doubling as a separate
  Slate internal/external state-sync bug, not as part of the transport recovery
  fix.

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
  **Fixed 2026-05-21** with retryable `not-sent` state and clearer credentials
  guidance.
- Live chat log drops output chunks. **Fixed 2026-05-22** by making the
  efficient preview stream agent-output-only and removing non-message boundaries
  from that stream.
- Chat scroll position starts near top. **Fixed 2026-05-22** with explicit
  viewport anchors rather than raw Virtuoso snapshot restoration.
- Agent view missing thread menu/config. **Fixed 2026-05-22** by sharing the
  normal chat thread menu with the agent inline chat surfaces.

Acceptance:

- Agent button either starts a turn or renders actionable failure. **Done
  2026-05-21** for no-explicit-model submissions and expired-auth failures.
- Expired Codex auth path links to payment/credentials configuration. **Done
  2026-05-21.**
- Chat-rendered activity and activity drawer show the same agent-message chunks.
  **Done 2026-05-22** for live preview rendering.
- Chat opens anchored to recent messages unless user explicitly scrolled. **Done
  2026-05-22** for virtualized chat remount/restore behavior.
- Agent view has the same thread menu/config affordance as normal chat. **Done
  2026-05-22.**

### D. Storage, Backups, Quotas, And Deletes

Primary files/packages to inspect:

- `src/packages/frontend/project/settings`
- `src/packages/frontend/projects`
- `src/packages/conat/hub/api/projects.ts`
- `src/packages/project-host`
- `src/packages/server`

Scope:

- Backup timestamp randomness.
- Project runtime quotas at start/restart.
- Bulk project delete queue limit.
- File delete modal overflow.
- WAL retention.

Acceptance:

- Disk usage UI distinguishes cached values from recompute jobs. **Done
  2026-05-23.**
- Backup overview and host health use the same authoritative latest backup
  timestamp. **Done 2026-05-22** by fixing scheduled backup reporting at the
  source instead of papering over stale `projects.last_backup` in the UI.
- Start/restart uses current membership/default quotas. **Done 2026-05-22**
  by making quota recomputation share the same membership/sponsor-aware
  `run_quota` path used by project starts, and by updating stopped projects'
  stored `run_quota` during admin quota changes instead of leaving stale rows.
  Host restart operations also recompute before re-starting projects.
- Bulk delete completes sequentially with progress or clear queuing. **Done
  2026-05-22.**
- File delete modal remains readable for large selections. **Done 2026-05-22**
  with a bounded, wrapping selected-file list and explicit overflow count.
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
   test. **Done 2026-05-22** for open editor SyncDocs.
5. Fix sign-in redirect to `/projects` and passkey method/action confusion.
6. Fix Codex agent-button silent failure path, especially expired auth. **Done
   2026-05-21.**
7. Fix the Codex live-log dropped-output rendering bug or add instrumentation
   that proves where output is filtered.
8. Fix disk usage reload wording or recompute semantics. **Done
   2026-05-23.**

## Next Release Picks

Recommended next work order as of 2026-05-23:

1. Finish bulk project delete progress/status polish so multi-project cleanup
   remains understandable after the confirmation modal closes.

Good fallback tasks if the above stalls:

- Hide or replace the stale community support page before public traffic.
- Investigate the tiny chat "Loading" forever state if it recurs during
  backend upgrade dogfood; it may share enough with the SyncDoc reconnect work
  to be quick, but needs a fresh reproduction.

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

- Markdown Slate collaborative editing fix. **Done 2026-05-21.**
- Offline editor visibility. **Done 2026-05-22.**
- FS client restart recovery for open editors. **Done 2026-05-22.**
- Project table stale-state convergence.

### Batch 3: Codex/Chat Reliability

- Agent button no-explicit-model launch failure. **Done 2026-05-21.**
- Agent button expired-auth/preflight guidance. **Done 2026-05-21.**
- Live log dropped chunks. **Done 2026-05-22.**
- Scroll anchoring. **Done 2026-05-22.**
- Agent view thread menu. **Done 2026-05-22.**
- Backup timestamp source. **Done 2026-05-22.**
- Bulk delete behavior. **Done 2026-05-22.**
- Disk usage reload/recompute. **Done 2026-05-23.**

### Batch 4: Storage And Quota Honesty

- Runtime quotas on start/restart.
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
