# ACP Harness Implementation Checkpoint

Date: 2026-09-21. Branch: `feature/acp-harnesses`. Draft PR: #663, stacked on
`feature/my-agents-workspace` (#640).

## Broad Regression Checkpoint

### Cleanup Failure Classification

Follow-up regressions found that the unconditional attention cleanup in
`evaluate`'s `finally` could replace the preserved delivery error, and could fail
after the success summary was already emitted. Attention now finalizes inside
the guarded evaluation before the summary; failed evaluation goes through one
disposal path instead of repeating cleanup in `finally`. Disposal attempts
attention cleanup even when process cleanup fails. The final block only clears
local busy/context state. Three real-subprocess regressions cover these cases,
including refusal to reuse an adapter whose finalization failed. The subprocess
suite now passes 65 tests; 140 native AI tests, two durable harness-attention
tests and project-host TypeScript also pass. This is injected attention-store
failure coverage, not a live database-outage test.

A failing real-subprocess regression demonstrated that a launcher `stop()`
rejection replaced the primary `outcome_unknown` error with an unclassified
cleanup error. The startup and evaluation failure paths now retain the original
HarnessError classification and safe message while explicitly warning that
runtime cleanup could not be confirmed and the harness may still be running.
Cleanup implementation details are not forwarded to the user. A failed adapter
remains closed and cannot silently relaunch the turn.

Three regressions inject cleanup rejection after actual fixture shutdown:
uncertain prompt delivery, startup protocol mismatch, and rejection from a
retained session. All preserve their original classification, emit no successful
summary for the failed turn, and launch/stop only once. All 62 subprocess tests,
140 native AI Jest tests and the project-host TypeScript build pass. This tests
the error-reporting contract; it does not qualify the rare live Podman removal
fallback or prove that a genuinely failed container stop terminated descendants.

### Narrow Settings Qualification

At deployed source `efe501070d`, exercised agent-3 at a 320 by 800 CSS-pixel
viewport in signed-in Chrome, separately in light and dark themes. The mobile
Agents layout initially displays its list; keyboard-selecting agent-3 opens the
chat. Opened ACP settings by keyboard, expanded the runtime details, focused the
discovery control, and opened the advertised Model selector without committing
a different value or starting discovery/inference.

Both themes measured a 320-pixel page scroll width and a 304-pixel dialog with
304-pixel scroll width. No dialog descendants overflowed horizontally. The
140-pixel model popup stayed inside the viewport. Escape dismissed the popup
without dismissing the dialog; the following Escape closed the dialog and
restored focus to its trigger. Screenshots verified actual light/dark rendering.
The temporary probe was `/tmp/acp-narrow-ui.cjs`; no settings or chat submissions
were changed. This supplements the earlier actual 200-percent zoom check; it
does not establish accessibility of the entire Agents workspace, every possible
harness label, or all artifact split-pane layouts.

A fresh typed snapshot listing also found automatic snapshots at 12:52:46,
13:51:00, 14:08:43 and 14:30:51 UTC. This confirms continued automatic operation,
not a strict 15-minute recovery bound: host upgrades reset scheduling, and the
listing is retention-filtered. No scheduler safeguards were bypassed. PR #640
remains open, and #663 remains a draft based on `feature/my-agents-workspace`.

### Current-Turn Context And Live Artifact Publication

Commit `1e00bfe70d` adds current-turn project/chat/thread/message metadata to
ordinary generic harness prompts without modifying the stored user prompt or
native Codex path. Retained-process tests verify different producing timestamps
on successive turns, and slash commands/missing context remain unchanged.
The subprocess suite passes 59 tests, native AI suites pass 140 tests, and the
project-host TypeScript build passes. This extends the earlier 818-test broad
baseline below; that entire baseline was not rerun for this small addition.

Deployment: project-host `20260921T141424Z-1e00bfe70d23`, SHA-256
`0e61d1946998baf5ef4377ce2b0f06d6570a608ba9786a84dab0f3b2eff791f2`, upgrade
`04bae6b2-dfd6-4445-b0c7-9cefe93172bc`. Tools `1789999853395`, SHA-256
`87217a5411b4f144d55430c8f14ec151b1440b0a08ebaf9a07ef0caa9854920b`,
upgrade `a341489c-ac6d-473a-8fb7-0e4edd39af97`. The tools bundle was upgraded
separately because the old installed CLI lacked artifact publication.

On disposable agent-3, a temporary ACP wrapper used only its inherited scoped
identity and explicit current-turn context to publish
`/home/user/acp-artifact-qualification.md`. Publication returned `ok: true`,
artifact `artifact-6f17392198c47f1b389f787d`, attached to producing message
`79fae9af-502f-4e62-8596-09246b8b3faa`. No account credentials, raw chat edits or
paid inference were used.

The first wrapper incorrectly asserted a top-level response field instead of
`data.artifact_id`, so the producing turn reports an error despite successful
publication. A read-only follow-up also initially asserted the wrong nested
shape. Neither error was an application publication failure, and publication
was not repeated. After correcting the test assertion to
`data.artifact.artifact_id`, scoped readback turn
`26151d98-9ecd-41c1-81df-0b6b79778383` completed successfully. A full browser
reload retained the card; keyboard activation opened the artifact workbench
and rendered the saved file's exact marker `artifact-20260921`.

The temporary wrapper was replaced with the ordinary fixture afterward; the
single-attempt receipt and published file remain for inspection. This qualifies
explicit fixture-driven artifact publication/readback/reopen, not automatic
artifact generation, broad real-model behavior or full workbench parity.

Adapter persistence-failure coverage now injects storage errors at initial status,
initial controls, streamed text, final controls, stop metadata and final summary.
Each boundary runs against both a new subprocess and a retained subprocess after
a successful turn. All 12 cases reject, stop the subprocess before returning,
persist no successful summary, make no further stream calls after failure, and
refuse subsequent reuse without launching another process. Repeated disposal is
idempotent. The real-subprocess harness suite now passes 49 tests and the AI
TypeScript build passes. These are controlled adapter/sink failures, not proof of
live database outages, disk exhaustion or project loss.

Additional peer-execution regression coverage persists a generic RPC request
through SQLite, decodes the admitted request, and invokes the actual execution
entry point with a revoked membership or unavailable authorization service.
Both cases reject before harness launch or streamed output, preserving the
stored principal and authorization envelope. The detached-worker, delivery-
authorization and RPC-service suites pass 101 tests, and project-host typechecking
passes. This is execution-boundary coverage, not live cross-project delivery or
a live membership-revocation scenario.

### Live Queued Network Revocation

The execution-boundary tests now also have a same-project live counterpart on
deployed artifact `20260921T123635Z-f3ef948ae811`. A temporary two-member network
(`7472f124-2f00-40d9-9d3d-218687fe2804`) connected disposable fixture agents 4
and 3. Agent 3's deliberately hanging operation
`b1141098-be34-4460-83c1-2930a9af6c51` kept its conversation occupied. Agent 4
used its scoped runtime identity, checked destinations, and sent exactly one
message. CLI attempt `dd4eb4ee-9e9c-4578-8f7d-d73bebf6a1e3` returned accepted;
the recipient operation `e99f6b0f-46e1-401d-badc-2017e39fb4fb` was independently
observed queued with no start timestamp.

After the network was closed through the UI, the running fixture was explicitly
interrupted. The queued operation reached execution authorization and ended in
error with `network_closed`, not a harness response. This distinguishes accepted
delivery/queueing from execution authority: running work is not automatically
canceled, but queued work is checked again before it starts. Settings copy and
confirmation messages now describe that distinction instead of promising that
all accepted work continues.

The fixture used an exclusive on-disk attempt marker to prevent duplicate sends.
The original fixture was restored, the temporary network was closed, and normal
project restart `69b4c57d-9976-4f04-91c5-adeb45f21be9` completed successfully.
Independent inspection then found no queued/running jobs or ACP sidecars for
the disposable project. No other project's configuration or real credentials
were changed. Live cross-project routing remains a separate qualification gate.

### Cross-Project Qualification Setup

A second disposable project, `e9534540-b7f5-4dbf-a20c-f2df3cb53012`
("ACP cross-project recipient qualification"), was created on the existing
qualification host; no new host was allocated. Its agent-10 uses the same
installed deterministic ACP controls fixture through the normal custom-profile
UI. Baseline operation `515daa0e-2ceb-4cac-8776-e5b1377493ee` completed and
rendered `fast/code`, establishing that the recipient's own container/runtime
works independently of the source project.

Creating a queued network between agent-4 and agent-10 reached the normal
cross-project fresh-authentication requirement. The browser session needed
renewal. The supported `auth elevate --dev` CLI attempt also failed because the
current shell has neither an existing cookie nor local hub-password access.
No credentials/cookies were synthesized and no alternative authorization route
was used. The pending UI setup was canceled; the directory remained at zero
active networks. No peer send was attempted (the exclusive send marker was
absent), so there is no ambiguous delivery to retry.

The source fixture was restored and the second project was stopped normally
(`opened`). Both disposable projects had no queued/running jobs afterward.
Agent-10 remains available for resuming this test once fresh authentication is
available. This is setup and recipient-baseline evidence, not a passed
cross-project delivery test or a blocker for unrelated qualification work.

At source commit `4f0f063038405cf6a2161156c1dfb9a7d3230de7`, the following
checks completed successfully (2026-09-21):

- `pnpm test --runInBand` in `src/packages/ai`: 12 suites, 140 tests. Includes
  native app-server, session/store, goals, attention and agent SDK tests.
- `pnpm exec jest --runInBand` in `src/packages/lite`: all 48 configured ACP
  suites, 441 tests. Includes credential admission, automation, queueing,
  attention, steering, detached workers and generic discovery/runtime tests.
- `node --test acp/__tests__/harness-client.test.cjs` in `src/packages/ai`:
  37 subprocess protocol/lifecycle tests. This suite is separate from Jest.
- `pnpm exec jest --runInBand --testPathPatterns='(codex|acp).*test'` in
  `src/packages/project-host`: 14 suites, 98 tests covering native credentials,
  launch/funding helpers, ACP workers and generic launch/reaping.
- `pnpm -C src version-check`: workspace dependency consistency passed.

These 716 tests strengthen the native/generic regression baseline, but do not
prove all live release gates below. No paid inference or real credentials were
used. The final frontend bundle was separately rechecked at 320/768/1366 CSS
pixels in light and dark themes, including keyboard dialog opening, Escape and
focus restoration, without the development stale-build overlay.

## Durable Local Inference With Project Public Egress Blocked

On deployed `ba08aa4eb7`, operation
`c5cb204e-6ecf-4212-a9ed-037e35e1716e` completed in the existing Pi/local-Qwen
conversation and rendered "Nine plus nine is eighteen." Browser reload retained
the completed answer. This was a new runtime process using the provisioned local
model and existing durable native session, not a replayed fixture answer.

For the duration of the test, an operator-created `inet acp_qualification` nft
output chain in project namespace `net:[4026532463]` default-dropped egress except
loopback and `10.206.0.1:9102` (the existing CoCalc host transport). The namespace
was verified distinct from the host before mutation. Public IPv4 curl timed out;
public IPv6 curl failed. The IPv6 failure alone does not establish filtering
because that network lacks a public IPv6 route; the inet output policy covers
both families. The drop counter recorded 87 packets / 5120 bytes during testing.
Those packets were not attributed to particular processes or telemetry.

Sidecar `acp-1892b11a-6c63-4a92-988d-01dcddc0bc79-381822b6-cfd8-4b44-a78f-dc69a70bda19`
shared the exact filtered project namespace. No cloud inference, provider login,
catalog download or real subscription was needed for this turn. The test helper
had a bounded cleanup timer; it was deliberately signaled after qualification,
exited successfully, and an independent nft listing confirmed the temporary
table was gone. No host firewall or other project namespace was modified.

This closes the project-egress-blocked browser/local-inference demonstration,
not the broader audit of an entirely air-gapped CoCalc host/control plane.
Network-policy product support remains a follow-up, not a new implicit feature.

## Current Regression Check

Post-finalization pass at `bea72c6136`: AI 140, Lite ACP 446 (48 suites),
project-host Codex/ACP/snapshot helpers 119 (17 suites), subprocess harness 65,
and focused frontend 56 (6 suites): 826 selected regressions passed. The Lite
command added `--testPathPatterns='acp/.*test'`; host and frontend scopes are
the same as below. Frontend lint and dependency consistency also passed.
Project-host TypeScript, backend bundle and frontend development build passed
at this head. The full monorepo development build remains the earlier baseline
below, not a newly repeated full build.

The deployed backend is `20260921T144846Z-bea72c613615` (SHA-256
`d64879fb93cd2842723778e870708cd0229c5480ef12eda13b98f9047b7576dd`), upgrade
`170d404f-2abb-4aa6-a754-2d97843cee55` succeeded. A single browser fixture QA
exchange completed as `d361dff0-196e-4218-8cfb-c53c3930ef57` in
`fixture-session`, with no error. A separate read-only reopen confirmed the
latest accepted `local` answer in history. No prompt was repeated after the
first reload returned before history rendering finished. These are normal-path
live checks; injected cleanup/storage failures remain test evidence only.

At `8fdc24ebaf` on 2026-09-21, a fresh full development build and a broader
regression pass completed successfully:

- `pnpm -C src build:dev`: passed, including generated translations, frontend
  TypeScript/bundling and backend packages; no tracked files changed. The
  existing optional debug-file logging EACCES warning remained nonfatal.
- AI `pnpm test --runInBand`: 12 suites, 140 tests.
- Lite `pnpm exec jest --runInBand`: all 48 configured ACP suites, 446 tests.
- Project-host `pnpm exec jest --runInBand
--testPathPatterns='(codex|acp|snapshot-(rootfs-restore|home-swap|home-rootfs)).*test'`:
  17 suites, 119 tests.
- AI `node --test acp/__tests__/harness-client.test.cjs`: 57 real subprocess tests.
- Frontend focused Jest: harness-profile, harness-tool, acp-api,
  composer-delivery, composer-resize-handle and agent-networks: 6 suites, 56 tests.
- `pnpm -C src lint:frontend`: zero errors/warnings and Tooltip import check passed.
- `pnpm -C src version-check` and `git diff --check`: passed.

The 818 tests above are the selected current regression run, not all repository
tests and not additional live release qualification. Remaining gates below still
apply. No paid inference or real credential changes were needed.

## Implemented

- Non-success prompt stop reasons now have explicit subprocess coverage for
  `max_tokens`, `max_turn_requests` and `refusal`, each with and without partial
  output. Tests assert exact stop events, preserved partial text, no success
  summary, process disposal and no implicit retry. Together with existing
  end-turn and cancellation checks, all 57 real-SDK subprocess tests pass;
  AI TypeScript passes. No production behavior change was needed.

  A live token-limit case after disposable-project restart
  `763bcdd9-5b84-49a5-8789-8b3bc142e014` also passed. Operation
  `6c83b9b3-d802-4c85-8c47-3c8132c86381` ended in `error` with
  `ACP harness failed: ACP prompt stopped: max_tokens`; its partial output and
  error remained visible after reload. SQLite showed no recovery child. A new,
  deliberately submitted fixture turn `6b1696bd-2181-4620-bceb-7f551d5457c2`
  completed and survived reload in the same conversation, using its existing
  native session ID. No queued/running jobs remained. Only the token-limit case
  was checked through the live browser; request-limit/refusal cases used the
  real subprocess adapter tests. No provider calls were made.

- Opt-out/re-enable now has live evidence on the existing qualification host.
  With no queued/running jobs anywhere on that host, the operator set
  `COCALC_ACP_HARNESSES=0` and restarted the host service. The running process's
  selected environment field confirmed the disabled value. Browser model
  discovery rejected with `ACP harness execution is not enabled on this host`
  and created no sidecar. A separately submitted test turn received the same
  error before admission: SQLite's latest two jobs remained the earlier quiet
  and stderr operations, with no new generic or native fallback job. Existing
  replies were still readable after reload.

  The original opt-in was restored and the host service restarted; the new
  process confirmed `COCALC_ACP_HARNESSES=1`. A deliberately submitted fixture
  turn completed as `d1166bc9-ba83-4599-ac42-2efc7a4f920f`, survived reload, and
  had no recovery parent. The rejected request was not automatically executed.
  All 15 admission/discovery tests and Lite TypeScript pass, including a new
  SQLite regression that preserves readable/cancellable queued records while
  generic preparation rejects and native preparation remains unchanged.
  This is idle-host disable/re-enable qualification, not evidence for cancelling
  an active old runtime across mixed-version deployment. No paid inference or
  real credential changes were involved; ACP remains enabled for operator tests.

- Quiet execution and high-volume stderr now have subprocess and live evidence.
  The real-SDK suite passes 51 tests, including a quiet prompt longer than its
  configured 1500ms setup deadline, idle-session reuse after that deadline, and
  8 MiB of stderr drained without entering events or poisoning a follow-up.
  AI TypeScript passes. These are bounded test durations, not hours-long soak or
  memory-exhaustion qualification.

  The updated no-model fixture also passed through the browser in disposable
  agent-3. Stderr operation `9db6c607-37cb-41ad-821c-97b12cfde357` completed with
  only `Diagnostics drained.` in its reply. Quiet operation
  `8f137dcd-1475-4b3f-87c8-d0585a4e07cc` waited 35 seconds before emitting output,
  exceeding the normal 30-second setup deadline, and completed in 37012ms of
  worker execution. Both replies survived reload; both jobs are completed with
  no recovery parent, and the project has no queued/running jobs afterward.
  Sidecar `acp-1892b11a-6c63-4a92-988d-01dcddc0bc79-82a17ad4-3e2a-4df2-a1dc-8db6e52eb414`
  was created at 13:48:03 UTC for the stderr turn and retained for the quiet turn
  admitted at 13:48:37 UTC. No provider calls or real credentials were involved.
  An earlier fresh-tab agent lookup timed out before submission; the successful
  run used the existing fixture tab after rebuilding/reloading. The empty Slate
  editor's placeholder was excluded from the test helper's draft check.

- ACP settings passed an actual Chrome 200% browser-zoom check, not just a
  smaller viewport or CSS transform. Chrome's appearance setting changed from
  100% to 200%; CDP reported `zoom: 2`, layout/visual width changed from 1120 to
  560 CSS pixels and device-pixel ratio doubled. In both light and dark themes,
  the settled settings dialog had no horizontal page overflow, the discovery
  control was visible and keyboard-focusable, and Escape restored focus to the
  toolbar button. Native full-surface screenshots showed the advertised Model
  and Thinking controls with vertical scrolling available. The initial run was
  discarded because the dev stale-build overlay and entry animation obscured
  the result; the recorded rerun followed a frontend rebuild at `2df8e2fb61`.
  Chrome zoom was restored and temporary tabs closed. No discovery or inference
  was invoked. This is the settings-dialog check, not an audit of all Agents UI.

- Rootfs-only snapshot restore now prepares a reflink copy beside the live
  rootfs and swaps sibling directories rather than moving an ordinary directory
  across Btrfs subvolumes. Failed installation restores the preserved original;
  failed rollback retains that original and reports its location instead of
  deleting it in unconditional cleanup. Home contents are not replaced.
  Eight focused rootfs tests cover success, copy/preserve/install failure,
  failed rollback, missing rootfs on either side, and identical-path rejection.
  The combined rootfs/home preparation/swap suites pass 21 tests and project-host
  TypeScript passes.

  Compiled helper SHA-256
  `a8960f5a4806567437aaddaada598fd78690964b3c305cf54a8d609f78d498fa`
  also passed on disposable real Btrfs subvolumes using the host's existing
  protected storage wrapper: injected install failure rolled back, successful
  replacement left home/snapshot markers intact, and a missing snapshot rootfs
  removed only the live rootfs. All temporary subvolumes were removed. This is
  protected-helper qualification, not evidence for crash recovery between rename
  operations.

  The deployed project-level rootfs-only restore subsequently passed on artifact
  `20260921T133155Z-4dfc53b94363` (bundle SHA-256
  `70494339def5c636a1f25309d044453913c00d29a3395580f39a69b045e29212`,
  host upgrade `799bb83f-6d63-4207-be94-9ed21f55d163`). In disposable project
  `1892b11a-6c63-4a92-988d-01dcddc0bc79`, snapshot
  `acp-rootfs-only-20260921-qualify` captured separate home/rootfs markers.
  Both were changed, then typed CLI restore with `--mode rootfs` succeeded as
  operation `386de0f0-5269-4b25-bd8e-12fc4becc895`. The rootfs marker reverted to
  `acp-rootfs-only-before-20260921`; home retained
  `acp-rootfs-only-home-after-20260921`. Snapshot listing confirmed the automatic
  `acp-rootfs-only-20260921-safety` snapshot, and project status was running.
  The four rootfs/home/project-API suites passed 81 tests (the existing Jest
  open-handle warning remains). This qualifies the normal orchestration path,
  not abrupt loss during the swap or every rollback/cleanup failure.

- Generic ACP composers no longer display native Codex goals or ChatGPT payment
  setup banners. The previous shared goal/agent flag also controlled naming and
  mention UI, so those conditions are now separate: agent naming, mentions and
  delivery selection remain available. Regression tests retain native goal and
  payment controls while hiding them for a generic runtime, even if stale native
  goal metadata is present. All 34 composer/delivery/native-goal tests, frontend
  TypeScript and lint pass. This is UI capability separation, not new support for
  generic goals or managed credentials.

- ACP composer follow-ups now queue rather than attempt unsupported live
  guidance. Live reproduction found that Shift+Enter during a running generic
  turn produced "Guidance not sent" even though the composer also offered Queue.
  The primary action and keyboard submission now use the normal queue path for
  generic runtimes; native Codex keeps its steering behavior. Queued ACP rows no
  longer expose Steer, and submission/waiting labels identify an ACP agent rather
  than Codex. Runtime identity comes from the persisted message when available,
  falling back to thread metadata for pending human messages.

  Both composer/status suites pass 41 tests, including native steering and
  generic keyboard/button queue dispatch; frontend TypeScript and lint pass.
  On lite4b, a follow-up behind hanging operation
  `38d0d293-a98c-4ed2-acfa-4c3e137c0ccc` rendered queued with Edit/Cancel and no
  Steer action. Keyboard Enter on Cancel changed it to not-sent before execution.
  The running fixture was then explicitly interrupted. An earlier fixture turn
  completed normally and was not counted as a running-turn qualification.

- Project stop now pauses new discovery before draining existing probes and
  holds that pause through both worker fences and primary container removal.
  Previously the drain took a snapshot while the discovery entry point remained
  open, allowing a later probe to miss the sweep. Regression coverage verifies
  rejection before and after drain completion, project isolation, nested/idempotent
  release, and release after stop failure. Seven discovery and 60 project API
  tests pass, plus the project-host TypeScript build. The project API test process
  still reports its existing open-handle warning. This closes the local discovery
  admission window; it is not evidence for all cross-process execution/stop races.

  Live qualification deployed `ba08aa4eb7` as
  `20260921T121004Z-ba08aa4eb7a6` (SHA-256
  `f5845c4e1b0eeb99eb804c8be4b4d1af65ec096b135f59b29311e16cdbdafd81`),
  upgrade `93b62d09-44c9-4165-a629-eeb83d425283`. In the disposable project,
  agent-9's initialization-stalling fixture held discovery open. Restart
  `0cb0199b-6a83-481f-a274-4c71ef1ca702` rejected a second browser discovery
  from agent-6 with the explicit project-stopping error, then completed with no
  remaining ACP sidecars. A deliberate Pi catalog discovery after restart
  succeeded. No chat turn was created: the newest durable job remained completed
  operation `c2880b14-8ddf-430d-b807-37e515af3e23`. The first browser attempt was
  blocked before discovery by the stale-build overlay; rebuilding the frontend
  removed that testing obstruction.

- Compact chat toolbars now open harness controls in an **ACP harness settings**
  dialog. The previous inline panel was clipped by adjacent composer controls
  on narrow screens. Keyboard opening, Escape dismissal and focus restoration
  have a focused regression test. Frontend TypeScript, lint and all six profile
  tests pass. Live checks cover 320, 768 and 1366 CSS-pixel widths in light/dark
  themes; actual browser zoom and broader accessibility remain separate gates.

- Experimental custom ACP creation in the existing Agents workspace, with
  accessible labeled executable/argument/version fields. Generic threads show a
  runtime summary instead of Codex payment/model controls. Profiles and native
  sessions have separate chat metadata; browser and CLI sends do not inherit
  Codex credentials/configuration. Admission rejects clients that omit or
  mismatch the configured generic runtime. Admitted profile snapshots remain
  independent of later shared configuration changes.

- Strict, versioned project-managed launch profiles and a separate generic runtime
  configuration type, now accepted by the durable request path only when the
  project host explicitly sets `COCALC_ACP_HARNESSES=1` and registers its launcher.
- An isolated ACP v1 client with initialization, capability discovery, new/load
  session, streaming, sequential prompts, cancellation and disposal. Its launcher
  is injected: there is deliberately no fallback to spawning on the host.
- A separately aliased, exactly pinned SDK 1.4.0. Native Codex and the legacy
  SDK 0.5.1 path are unchanged. The client has its own package export.
- Bounded JSON-RPC framing and event buffering, serialized asynchronous event
  consumption, redacted protocol failures, no automatic resend after ambiguous
  delivery, and cancellation timeout escalation through the launcher.
- Full-access permission handling selects `allow_once` for the active session;
  unsupported choices, stale sessions and cancellation do not grant permission.
  No host filesystem/terminal or authentication callbacks are advertised.
- A real subprocess fixture and 19 protocol/lifecycle regression tests.
- A conversation-bound `HarnessAgent` adapter implementing the durable service's
  existing `AcpAgent` interface. It emits status, streamed text, preserved generic
  updates/permissions, explicit stop reason and summary without fabricated usage.
  Four additional subprocess tests cover reuse, binding/unsupported options,
  uncertain delivery and cancellation. Opt-in durable execution selects this
  adapter, not Codex, and writes events through the existing chat writer.
- A disposable-project smoke tool with a loopback fake OpenAI-compatible provider.
  It scripts a real harness file-write tool call and streamed response. This is
  development tooling, not the production launcher or an inference service.
- A project-host sidecar launcher using structured Podman arguments, the existing
  project resource pool, rootfs lease, home/scratch and read-only CoCalc mounts.
  It joins the main project's network namespace rather than creating unrestricted
  networking. Removal terminates the sidecar's PID namespace without stopping the
  main project. It now requires an admitted conversation, reuses the existing
  scoped CLI/agent identity lease and mounts the project's live secrets directory
  read-only. It strips stale image credential fields and revokes its lease even
  when container removal fails. Failed removal can be retried without unmounting
  beneath surviving processes. Eight mocked lifecycle tests pass, as do the live
  qualification checks below. It is registered in the host and detached worker;
  a host-side reconciler now removes sidecars whose owning worker has died,
  using PID, boot ID and process start time (not PID alone). Unknown inspection
  failures preserve the container. Six focused reaper tests pass. Live worker-kill
  testing confirmed the host removes abandoned sidecars, including a real Pi
  sidecar, without stopping the primary project container.

## Live Durable Checkpoint

The full development build and project-host bundle succeeded. The test host
was upgraded to `20260921T072535Z-58ebe40c0a5a` using the ordinary host-upgrade
operation, which reported success. Its local opt-in is enabled. No paid inference
or real subscription changes were involved.

A deterministic fixture in the disposable project completed two turns through
the versioned RPC, durable queue, detached worker, production sidecar launcher
and chat writer. Persisted responses were `Hello world 1` and `Hello world 2`,
confirming native process reuse. A third, deliberately hanging turn continued
after the requesting client disconnected; an explicit interrupt subsequently
produced a persisted `cancelled` ACP stop reason and removed the sidecar.
Cancellation currently also produces an error event; its UI presentation needs
improvement before release. The durable RPC returns admission status, not the
entire execution stream; completion was verified through persisted chat activity.

The fixture chat is
`/home/user/acp-qualification/durable.chat`, thread
`7bdc439d-4c62-49b6-8974-2af70e5f64f2`.

The subsequent bundle `20260921T073804Z-039792cfaeb2` also passed a worker-kill
test: the hanging job became `interrupted`, with no recovery count or automatic
resubmission, and the host logged removal of its abandoned sidecar.

Pi then completed an initial turn, a retained-runtime follow-up, and an explicit
native-session resume after killing its worker and waiting for sidecar cleanup.
All three summaries were persisted with the same native session ID. These ran
through the production durable queue and container launcher, not the standalone
smoke launcher. A loopback fake provider in the project made this possible
without any external model key. Its process had a 15-minute lifetime and a
12-call cap; the wrapper used an isolated test HOME and explicit PATH containing
both Node and the installed Pi binaries. The initial PATH omission failed
clearly during session setup and did not fall back to another harness.

The Pi chat is `/home/user/acp-qualification/pi.chat`, thread
`9ef46e73-826c-4902-b888-3f24c1d13b7a`. These old probe chats do not contain the
new saved runtime profile. Use them as read-only test evidence, not as a
generic-harness composer; the GUI qualification below creates a fresh thread.

The latest deployed host bundle is `20260921T075347Z-60b71b9912c7`. On it, another
explicit Pi resume succeeded and a deliberately mismatched native session was
rejected without inference. Service disposal removed the retained Pi sidecar;
no ACP containers remained afterward. Direct manual Podman removal had exposed
its known stop-timeout issue earlier, so the launcher also reuses project-runner's
existing process-kill/retry workaround for that specific failure. The fallback
has unit coverage but was not exercised by this successful live service disposal.
Project-runner's 34 Podman tests and 14 launcher/reaper tests pass.

Snapshot inspection found existing automatic snapshots at 06:38 and 07:08 UTC.
The configured defaults use a 15-minute sweep and frequent interval, but repeated
host restarts and maintenance scheduling mean this observation does not establish
an actual 15-minute recovery guarantee. See the later restore qualification below.

## Browser And Restore Qualification

Commit `e8989db727` passed the full development build, frontend lint, 75 focused
frontend tests (including keyboard profile editing and generic submission), seven
chat send tests and 161 durable/worker tests. The host upgrade to
`20260921T081759Z-e8989db7276e` succeeded (operation
`78f050fd-a8aa-42d3-b723-f32392d52dea`).

Using the signed-in Chrome session, created `agent-2` in the disposable project
through the new custom ACP controls. The profile runs `/opt/cocalc/bin/node` with
`/home/user/acp-qualification/fixture.cjs` as its sole argument. No Codex payment
or model controls appeared. The first turn persisted `Hello world 1`; a full
browser reload followed by a second submission produced `Hello world 2`, proving
that the GUI retained its profile and resumed the same harness process. A hanging
turn remained visibly running after another reload and was stopped through the
visible Interrupt button. Cancellation initially rendered as an error; commit
`2704643143` maps a provider-confirmed cancelled stop to interrupted while
preserving partial output (97 chat-writer tests and host typecheck passed).
Live qualification then passed on host bundle
`20260921T082841Z-27046431436e` (upgrade operation
`5f29c4eb-dee4-4185-a361-2f6cf13a8f94`): a fresh hanging turn survived browser
reload, and Interrupt preserved `working` followed by `Conversation interrupted.`
without a new error or resubmit prompt. No fixture turn remained running.

### Partial Restore Diagnosis

The home-swap boundary now also rolls back if installation or volume metadata
recording throws before returning the preserved-home path. It moves a failed
replacement back to staging without deleting either tree, restores the original
home, and refreshes volume metadata even when the first move fails. If rollback
also fails, a typed error retains both failures and the preserved-home location.
Thirteen preparation/swap tests pass, including real temporary-directory content
checks, plus project-host typechecking. The compiled module from `7aab8202a2`
(SHA-256 `a92531cea366652ed5043197d1ae28094356465e9c156dcddc7f051a36d00d5b`)
also passed a live disposable Btrfs fixture on the project host. Its command
adapter invoked the real protected storage wrapper as `cocalc-host`; only the
volume-metadata callback was replaced with a deliberate first-call failure.
The original home and replacement subvolumes were restored to their expected
locations, the original metadata callback was retried, and both fixture
subvolumes were deleted afterward. This is not an injected failure through the
entire restore API or process-crash qualification between moves.

The follow-up was deployed as `20260921T123635Z-f3ef948ae811`, SHA-256
`9156e252cb66583a81b8b8b3d05f58f8fe6d421f399c482fec21da5ef384954a`.
Upgrade `97b543f0-73aa-4018-88bd-db8c1aa8d336` succeeded after delayed convergence.
Service-account `ctl status` confirmed the host running, and the typed snapshot
listing returned successfully afterward. No real project restore failure was
injected for this follow-up.

Home-only restore is now fixed and live-qualified by `48bbf9f4d2`. It prepares
the disposable snapshot clone with an anchored reflink copy of the current
rootfs before swapping homes, leaving the original home/rootfs intact for the
existing rollback path. Rootfs-only restore was unqualified at this checkpoint;
the later implementation and deployed qualification are recorded above.
Five preparation regressions, 76 combined snapshot/project-API tests and the
project-host TypeScript build passed; the existing Jest open-handle warning was
observed before the test process exited successfully.

Deployed artifact `20260921T122709Z-48bbf9f4d252`, SHA-256
`70f63925e4b740496ef4391bf64599f7f292f598c138e2bf026b81471a48c657`, upgrade
`d861201f-dcc0-412c-9425-7758f0c5eb0d`. Snapshot
`acp-home-restore-20260921-qualify` captured distinct home/rootfs marker contents;
both markers were changed afterward. Typed home-only restore operation
`f4bced7c-7f5b-44a4-9b3e-0dc5809c79e0` succeeded, including safety snapshot
`acp-home-restore-20260921-safety`. The home marker reverted to its pre-snapshot
value, the rootfs marker retained its newer value, and the project container
restarted. This proves the successful home-only case and preparation-failure
invariants, not every existing home-swap/rollback failure path.

The later live probe reproduced the home-only restore failure without touching
the working project: create a disposable Btrfs subvolume under
`.snapshot-restore-staging`, create an ordinary `rootfs/sentinel` directory in
it, and invoke the protected storage wrapper's `mv` to its parent staging tree.
The helper returned exit 2 with `[Errno 18] Invalid cross-device link`. The
existing protected `copy-tree-reflink` operation succeeded on the same source and
destination. The disposable subvolume and both directories were then removed.

This identifies a cross-subvolume directory rename, not a need to weaken the
helper's anchored path restrictions. `file-server.ts:replaceTreeByMove` is used
by both partial restore modes; simply replacing its rename with copy/delete is
not sufficient transactional recovery. A follow-up fix should prepare a complete
replacement with the existing anchored copy primitive before changing the live
rootfs, preserve the old tree through installation, and test failure at every
copy/swap/rollback step. In particular, the existing outer cleanup must not remove
the only preserved rootfs after an intermediate failure. No helper bypass or
production partial-restore mutation was attempted during this diagnosis.

The typed snapshot listing after these checks contained automatic snapshots at
08:45:39 and 11:57:15 UTC plus the manual safety snapshot. Retention prunes the
listing, so it is not a complete execution timeline. The scheduler defaults to
a 15-minute initial delay and 15-minute sweep; repeated host upgrades restart
that delay. A strict 15-minute recovery-point guarantee remains unverified.

Snapshot `acp-qualification-20260921-0823` captured a marker file which was then
deleted. Home-only restore failed before replacement: the protected storage
helper reported EXDEV while moving the preserved rootfs into the staging root.
Do not bypass that helper or claim home-only restore works. Full restore of both
home and rootfs subsequently succeeded, operation
`7e5d1fc9-7c89-426d-9540-02460d82312b`, with safety snapshot
`acp-pre-full-restore-20260921-0825`. After completion, a fresh project exec read
the exact original marker content. Harness files remained present. This qualifies
that manual full-project restore scenario, not guaranteed 15-minute scheduling,
home-only restore, editor convergence, or every interruption case.

At that checkpoint, rich generic tool rendering and incoming network requests
were not qualified; subsequent checks below cover those paths. Task QA and images
remain unqualified, and the UI is still experimental.
Some shared completion notifications still use Codex wording. A feature flag on
the host remains required; discovery/old-host UX needs further work.

## Harness Configuration Controls

Generic threads now render bounded, harness-advertised select controls (including
model choices), preferring ACP config options over legacy session modes. Settings
are saved with the thread and defensively copied into the admitted request. A
queued turn retains its submitted selection. The adapter validates each choice
against the live session catalog and applies it before prompting, reusing the
same process. Returned configuration must confirm the selected value. Unknown
choices fail explicitly rather than falling back to a model or native Codex.

The UI states that changes affect the next submitted turn, not running or queued
turns; harness modes do not change container isolation. Controls are reported as
advisory chat metadata, not authority or executable UI. Stale metadata from a
different profile is ignored. Stable ACP select options and legacy modes are
supported; boolean options and private model-selection extensions are not.

The first turn still uses project configuration. Pre-prompt discovery and choices
in the new-agent form remain a follow-up. Protocol coverage now includes 27 real
subprocess tests, with model changes on a retained adapter. Admission tests cover
settings snapshots through SQLite, writer tests cover catalog persistence only
for generic runtimes, and the frontend selector has keyboard coverage. A shutdown
race exposed by failed output persistence was also corrected: all connection
promises are observed even when the runtime has already failed.

The refreshed standalone smoke passed against both pinned installations: Pi
advertised `model` (one fake-provider model) and `thought_level` (six choices);
OpenCode advertised `model` (one choice) and `mode` (two choices). Both catalogs
normalized successfully and both harnesses repeated the file-write/follow-up
check with three/four local fake-provider calls respectively. This is catalog
discovery evidence, not qualification of every individual control value.

Commit `08081ddb28` passed the full development build, frontend lint, all 140
existing AI tests, 27 subprocess tests, 62 focused frontend tests, three control
normalization tests and 149 writer/admission/worker tests. Host upgrade operation
`847b0a8b-de49-4b37-b139-162f50b42ea6` deployed bundle
`20260921T085034Z-08081ddb28ad`. Browser-created `agent-3` in the disposable
project uses the deterministic fixture with `--config-options`: its first turn
returned `fast/code`, the Model selector changed to Deep using the keyboard,
the selection survived a full reload, and the next turn returned `deep/code`.

## Validation And Real Harnesses

### Generic Tool Activity

Commit `a156b59fe0` adds compact tool rows to the existing activity log. Updates
merge by tool-call ID; omitted fields retain their prior values and supplied
content replaces prior content. Display output is bounded and rendered literally,
not interpreted as HTML. Missing status stays unknown; turn completion does not
invent tool completion. Non-text content is descriptive only, and reported edits
are not presented as verified filesystem diffs.

Frontend typecheck, lint and 22 focused activity/tool tests passed, along with
28 real-subprocess ACP tests. Browser-created `agent-4` in the disposable project
ran the fixture's `tools` scenario through the deployed backend. Opening its
activity drawer displayed one completed Inspect fixture row; keyboard Enter
expanded it and showed `Fixture tool output verified.`. The initial browser
probe targeted a hidden cached view; selecting the visible activity chip resolved
that test issue without resubmitting the turn. Generic drawer/status/export labels
now distinguish ACP from native Codex; the generic avatar remains a follow-up.

The initial backend checkpoint passed the AI package build, all 140 existing AI
Jest tests, 23 new subprocess tests, and workspace dependency version consistency
check. Later frontend validation is recorded above.

Both of these pinned installations completed initialization, session creation,
streamed a response, wrote the expected file through their own real tools, and
completed a second prompt in the same session:

| Harness  | Version                                  | ACP adapter           | Provider               |
| -------- | ---------------------------------------- | --------------------- | ---------------------- |
| OpenCode | `opencode-ai@1.18.31`                    | Native `opencode acp` | Loopback fake provider |
| Pi       | `@earendil-works/pi-coding-agent@0.86.1` | `pi-acp@0.0.33`       | Loopback fake provider |

### OpenCode Durable Browser Qualification

On the existing deployed backend, browser-created `agent-5` in the disposable
project ran OpenCode 1.18.31 through a project-local wrapper and a bounded
loopback fake provider (20-call cap, 15-minute lifetime, isolated durable HOME).
Initial and follow-up turns completed. After confirming no active jobs, killed
the idle worker and observed all its ACP sidecars disappear. A browser reload
and explicit follow-up then completed on a new worker using the same native
session `ses_f3cc9d93fffesPDL6P4juO3rZg`.

The thread is `a13c45c8-20cb-4027-9420-0655869c245b`, stored at
`/home/user/.local/share/cocalc/agents/e7d28687-b9f3-4bc1-9d72-8713ab4384e1.chat`.
Completed operations were `ea80148c-2e6d-408a-9fed-138f2bc83a75`,
`6ee52997-daef-4448-a0a3-28baaafe639b`, and
`8bfc5287-0ae7-4e11-a313-2821aae17509`. The latter moved from worker
`b6aaca9c-3bda-43dd-ac63-766bdbe323fa` to
`9fcb6ad7-059e-4ab8-8664-1afff17f7743`; no recovery count was introduced.
This qualifies explicit native resume, not automatic retry or offline operation.

Discovery/session creation made zero inference calls in these probes. Both
advertise session loading and have passed live durable worker-restart/resume
as recorded above. The
fixture covers resume replay suppression and unsupported resume behavior.
The final two-turn probes made four fake-provider calls for OpenCode and three
for Pi, including their file-write tool loop.

There was no paid inference and no real subscription credential was supplied.
Each probe uses a new temporary HOME, explicit environment and nonsecret dummy
provider key. Pi's executable uses `env node`; the launcher must include the
directory of the installed Node executable in PATH, not just `/usr/bin`.

This proves protocol/tool compatibility without API keys. It does not prove model
quality. Later snapshot and browser-to-worker checks are recorded separately
above. Public egress was not blocked during those durable browser checks; the
separate offline probe below has a narrower, explicit network boundary.

### Offline Protocol Qualification

Both pinned harnesses also passed in disposable Podman containers using
`--network=none`, read-only rootfs and project mounts, fresh writable tmpfs,
and no CoCalc credentials or project-secret mount. Their provider was the same
deterministic loopback simulator, not a real inference model. The existing live
project network was not modified.

The smoke tool's `--require-loopback-only` flag verifies Linux, absence of
non-loopback interface addresses and IPv4 routes, and an external TCP connect
failing with `ENETUNREACH` before starting the harness. It does not configure
isolation itself. Running it in the ordinary networked development environment
correctly failed before harness launch. Both isolated runs reported
`networkBoundary: loopback-only-verified`, completed a real file-write tool call
and same-session follow-up, and used three simulated provider calls for Pi and
four for OpenCode. Discovery made no inference calls.

The host's installed Node executable has `cap_net_bind_service=ep`; dropping
every capability prevented exec with EPERM. The successful probe kept only
NET_BIND_SERVICE, with no-new-privileges, no external network and no privileged
container mode. Neither probe container remained after completion.

This qualifies offline ACP/provider protocol and tool use for these installed
versions, not a finished egress-policy feature, absence of attempted telemetry,
the durable browser path under restricted networking, or actual local-model
inference. Those distinctions remain important for the on-prem release gate.

### Queued Agent-Network Integration

Generic harness recipients now use the existing queued RPC delivery path. The
service snapshots the recipient profile and settings, preserves peer attribution,
and bypasses Codex payment configuration. Duplicate delivery of the same attempt
does not admit another turn. Execution still calls the existing network authority
checker before launching the harness; revoked membership rejects queued work.

After a queue wait, a request without a native session can acquire the session
created by an earlier turn, but retains its admitted settings. An already-bound
native session remains pinned. A changed runtime profile rejects execution rather
than using a session from another harness. Immediate guidance, legacy deliveries,
automations and automatic uncertain-turn recovery remain unsupported.

Validation: 104 focused tests across harness admission, RPC delivery, execution
authorization, queued messages and detached workers passed, plus the project-host
TypeScript build.

Live qualification then passed on host bundle
`20260921T091811Z-8cc56397712d`, upgrade operation
`d3452847-0b8c-4362-9ca6-19283d89d4d9`. Created a disposable queued network
containing only fixture agents `agent-3` and `agent-4`. The source harness used
its own injected identity with the supplied CLI for whoami, destination discovery
and one personal send. No account-credential fallback was used. Network
`cade61cd-8842-4411-8762-ea3e111f053e` admitted attempt
`12c3a171-471e-4d86-803f-5f4d0fcf0e23`. Recipient execution
`ae084ecf-2e78-42dc-b028-00e0e3dea7b3` completed with its own Deep setting,
`fixture-session`, ACP runtime profile and network authorization in durable state.
The browser displayed the peer attribution and completed `Hello world 1` answer.

Closed the test network afterward (zero active networks) and restored the plain
fixture executable. The temporary source wrapper only allowed a single explicit
probe prompt, and never retried a send. This proves one same-project queued
network delivery, not cross-project delivery, queued revocation races or live
guidance. Those broader behaviors must not be inferred from this check.

### Live Text Editor Convergence

Opened `/home/user/acp-editor-probe.txt` in the disposable project's CoCalc text
editor with a known baseline, then submitted an explicit write prompt in a
separate browser tab to fixture `agent-2`. A temporary project-local wrapper
wrote the file directly through Node's filesystem API, without any CoCalc text
callback or fabricated file-change notification. The editor showed the baseline
with Saved status while admission was pending, then received the changed text
without a reload. The backend live text API returned the same changed content.
The transient save indicator settled to Saved. A subsequent full page reload
retained the changed content and Saved status.

Durable operation `fc548980-d82b-4ea6-b830-a08e58c82ef9` completed on thread
`19f0de39-d3be-4bce-8f74-67ec5bdffa37`, native session `fixture-session`.
Restored the plain fixture file after the test. This verifies normal external
text writes through the actual ACP container and existing project watchers,
not simultaneous unsaved human edits, binary artifacts or live notebooks.

Automatic snapshot observation remains incomplete: listings through 09:34 UTC
showed automatic snapshots at 08:45:39 and 09:06:52, alongside the earlier safety
snapshot. Repeated host upgrades during qualification reset the scheduler's
15-minute initial delay. Do not advertise a hard 15-minute recovery bound from
these observations or replace the existing memory-pressure safeguards just to
make the test pass.

### Task Question Client Checkpoint

The pinned SDK includes released `elicitation/create` form requests. Added a
bounded adapter to existing attention-question shapes for one to three required
string fields, including exact enum choices and Unicode length constraints.
Unsupported schema constraints, optional fields, non-string forms, URL/auth
elicitation and non-session requests fail explicitly rather than being ignored.
The rendered prompt warns against entering secrets; this is not an authentication
or approval mechanism.

The ACP client advertises form elicitation only when given an internal question
handler. It requires an active matching session, permits one outstanding question,
aborts on cancellation/disposal/turn end, ignores late answers and redacts handler
failures. The subprocess fixture exercises successful response translation,
wrong-session requests, unavailable handlers and cancellation with a late reply.
The AI package build and 34 subprocess tests pass.

The initial client-only checkpoint did not supply that handler in production.
The subsequent durable wiring now supplies the existing attention handler from
the execution service. Each evaluation uses a new execution ID bound to its
account, chat and native session; answers are validated before resolving the
stored request. Cancellation and runtime/turn shutdown close unanswered records.
The existing internal `codex_sync_question` storage discriminator is reused for
compatibility, with ACP-specific summary/resolution text; no separate question
queue, grant system or authentication flow is introduced.

Validation includes 37 subprocess tests and 29 focused attention-storage,
delivery and harness-admission tests, plus the project-host TypeScript build.
Live qualification passed on bundle `20260921T095242Z-b8226960e3c2`, deployed by
operation `983ae1ec-8137-40ee-af92-a1405dccddb6`. Fixture `agent-2` asked a blocking
form question, stayed waiting through a full browser reload, and received the
selected `local` answer through the normal QA UI. Durable job
`3ec97a6d-4c0d-44f6-bc0f-40e9f946acd6` completed; attention record
`ca5f827c-16b1-4881-8e53-7f837b61c855` became answered. The harness printed the
exact ACP accept response. The answered card disappears from the main thread;
an initial probe incorrectly waited for it to remain visible, but read-only
durable-state inspection and the rendered final response confirmed completion.

A second question was interrupted through the UI. Job
`feb98567-48f7-4850-9d40-8053b6d0712e` became interrupted and attention record
`0a6f1060-0a90-41e8-92f4-22aeeb193173` became stale. No pending question or running
fixture turn remained. Follow-up UI changes use the runtime summary and show
resolution text, not a misleading paused message, for closed questions.

This qualifies the supported form subset with a deterministic ACP executable,
not every harness-specific question extension or schema. URL/auth elicitation,
optional and non-string fields remain explicitly unsupported.

## Actual Local Inference Checkpoint

The new `ai/acp/__tests__/harness-local-model-smoke.ts` runs the real ACP client
against Pi and a locally provisioned llama.cpp server. Unlike the fake-provider
probe, this performs actual CPU model inference. It refuses a network namespace
with any non-loopback interface or IPv4 route, uses a fresh temporary HOME with
only local provider configuration, and never downloads a model or package.

Tested pins:

- `pi-acp@0.0.33` with `@earendil-works/pi-coding-agent@0.86.1`.
- llama.cpp `b11068`, official `llama-b11068-bin-ubuntu-x64.tar.gz`, SHA256
  `626f4a8d217bfec1870708f94bf1e3f9e30fc306ef1ed931acd9726703b6f1e6`.
- Official `Qwen/Qwen2.5-0.5B-Instruct-GGUF`, revision
  `9217f5db79a29953eb74d5343926648285ec7e67`, file
  `qwen2.5-0.5b-instruct-q4_k_m.gguf`, SHA256
  `74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db`.
  Model repository declares Apache-2.0. Download size is 491,400,032 bytes.
- Ubuntu 24.04 container digest
  `sha256:008173c23f95b170204355c12626cb5a965d779a7e1283b09e9cffbb1bf33ca3`;
  server needs `libgomp1` (tested Ubuntu `14.2.0-4ubuntu2~24.04.1`).

Provisioning occurred explicitly while online, with both upstream checksums
verified before execution. Inference used rootless Podman `--network=none`,
read-only root/image/packages/model, writable temporary HOME, `--cap-drop=ALL`
and `no-new-privileges`. A copy of Node without the production executable's file
capability avoids requiring NET_BIND_SERVICE in this isolated test. The test
receives no CoCalc identity or provider credentials; its API key is a dummy
placeholder accepted by the loopback server. No public provider fallback exists.

Result: Pi returned `2 plus 2 equals 4.` with ACP `end_turn`. llama.cpp reported
1,489 prompt tokens, nine generated tokens, 8.93 seconds total evaluation on
three CPU threads. The test asserts nonempty generated text, not an intelligence
or coding benchmark. The container and both processes were removed afterward.
Running the probe in the ordinary networked dev environment fails before any
process launch. The AI TypeScript build and all 37 harness subprocess tests pass.

Bundle the new probe with esbuild (`--bundle --platform=node`), then invoke it
inside the explicitly network-disabled disposable container:

```sh
node local-model-smoke.cjs /absolute/path/to/pi-acp /absolute/path/to/llama-server /absolute/path/to/model.gguf
```

Provision compatible Node/server shared libraries and the pinned Pi packages
first; their directories and the model may be read-only. The probe starts its
own server on loopback port 18995, bounds the prompt to 128 generated tokens,
and terminates its child processes after at most 180 seconds. Also impose an
outer container timeout. This is a qualification tool, not the production
project-host launcher or a general installation flow.

This closes the standalone real-local-inference evidence gap. It does not yet
qualify browser-to-worker local inference, arbitrary customer models, tool-use
quality, or an entire air-gapped CoCalc deployment. The test does not modify real
subscriptions or spend paid inference tokens.

Sources: [llama.cpp release](https://github.com/ggml-org/llama.cpp/releases/tag/b11068),
[pinned model repository](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/tree/9217f5db79a29953eb74d5343926648285ec7e67).

## Durable Local Model And Runtime Identity Checkpoint

The normal Agents UI created `agent-6` (Pi local Qwen) in the disposable project.
Its operator-provisioned wrapper starts the pinned local llama.cpp model service
and Pi adapter inside the supervised project sidecar. It uses a separate Pi HOME
and local-only provider configuration, not real subscriptions or account keys.
The persisted conversation is
`/home/user/.local/share/cocalc/agents/7ed6dd0f-fb79-44e4-b425-0b8a65780915.chat`,
thread `7e459cde-2ace-4f20-b705-8212e2650157`.

Initial operation `3d066c38-0b41-4420-b959-e5b9d036b916` completed with the rendered
model-generated answer `Two plus two is four.` After full browser reload,
follow-up `3ba4717a-3f80-47e8-b3e6-e993ab1aa098` completed using native session
`01a0c373-055c-72d0-98c2-b4adfb21919d`. llama.cpp reused its prompt cache for the
follow-up. This qualifies actual local inference through the durable UI path,
but the project network still permits public egress. Attempting an unprivileged
nested network namespace was rejected by the existing container policy; no
container policy was weakened to work around that. Keep this distinct from the
separate, successful standalone `--network=none` evidence.

Live inspection also caught an identity presentation gap: the session registry
stored runtime kind but individual chat replies did not. The writer now records
`acp_runtime_kind` on placeholder, full and metadata-only updates, including
queued failure replies. Generic reply avatars and activity labels use that
field; they no longer infer an OpenAI vendor from the shared legacy sender ID.
Network-attributed sender avatars are likewise neutral. Native Codex and human
avatars remain unchanged. Old experimental messages lacking this metadata are
not rewritten or relabeled speculatively.

An [operator guide](../../docs/acp-harnesses.md) documents setup, full-project
trust, project-managed credentials, offline provisioning, supported capability
limits and rollback. It is explicitly experimental, not release certification.

Bundle `20260921T102116Z-902a576589d7` deployed through operation
`694f0c5f-ccaa-4502-bab2-38d95f5c4a18`. After the old worker exited, the normal
reaper removed its retained local-model sidecar. A deliberate new UI turn,
`dd5f3ef0-064a-4725-9e58-680d84985fd2`, loaded the same native session and
completed with `Five plus five is ten.` The newly persisted reply renders a
neutral robot avatar with accessible name `ACP agent`, including after reload.
This is explicit resume of a completed conversation, not an automatic replay of
an uncertain turn. Earlier experimental replies without runtime metadata retain
their old rendering.

An additional registry inspection found terminal job mirroring was overwriting
the writer's generic kind with `codex`. Follow-up fixes derive kind from the
admitted request for both direct and job mirrors; sparse updates preserve the
existing kind instead of applying the INSERT-only native default. A real SQLite
regression exercises queue, claim, terminal mirror and sparse publication.
The registry/writer run passes 107 tests, chat helpers pass six, avatar/author
tests pass eight, and frontend/project-host TypeScript plus frontend lint pass.

The follow-up bundle `20260921T102709Z-3150fb6a0466` deployed successfully via
`be40bb87-eb20-4215-b406-b1875d02554b`. After normal old-worker/sidecar cleanup,
another explicit local-model turn `7d5302f9-02a9-4bce-9a51-5bf2a01874c6` resumed
the conversation and completed. Read-only SQLite checks confirmed registry kind
`acp` both while running and after completion. The disposable `agent-6` remains
configured for local CPU inference; its retained model server is intentional
runtime state, not an untracked host service.

## Forced Cancellation And Durable Outcome Checkpoint

The disposable `agent-7` runs the checked-in `acp-descendant.cjs` fixture. Its
ACP parent ignores cancel and its detached child ignores SIGTERM while writing
a heartbeat every 200 ms. A 300-second safety exit limits abandoned tests; it is
not counted as cleanup evidence. The test uses no provider or subscription.

The first live interrupt removed the sidecar and both captured host processes,
but falsely presented a confirmed interruption. Commit `266a14f368` separates
the cancel request from the prompt's confirmed cancellation in the chat writer.
The next probe exposed a second layer: the interrupt transport prematurely
terminalized the durable job. Commit `981e775bc3` leaves both direct and durable
generic cancellation finalization to the worker; native behavior is unchanged.

Live operation `1a085a08-de77-47fd-8ece-a67b1a6c7009` on artifact
`20260921T104638Z-981e775bc3a2` showed `Stopping...` while the job remained
`running`. After the cancellation timeout the job became `error`, with an
explicit uncertain-delivery/completion warning and no automatic resubmission.
Parent PID `3380468` and detached child `3380487` both disappeared. Heartbeat
count stopped at 279, well before the 300-second safety exit. The generated
sidecar was `acp-1892b11a-6c63-4a92-988d-01dcddc0bc79-cc6d9f02-cfa6-41db-b1db-313333b5ec5b`.
This qualifies ordinary forced sidecar/descendant cleanup, not the rare Podman
stop-timeout fallback or external side-effect rollback.
The warning remained visible after a browser reload and project restart;
the fixture thread still had exactly its three deliberately submitted jobs.

Validation: 149 chat-writer/detached-worker tests, 121 native ACP tests, and the
project-host TypeScript build passed. The earlier client checkpoint passed all
37 harness subprocess tests. Upgrade operation
`03f8a8b6-9045-444f-9e90-3dcdc2cdb605` succeeded; artifact SHA-256
`b7377b346be0e0d5f1a47764fe40d908081d67f7045fcfcfd71afc05309b9fe7`.

## Project Restart With A Retained Local Model

Restarting the disposable project after a completed Pi turn reproduced a real
lifecycle failure: Podman could not remove the primary project container because
the retained ACP sidecar depended on its network namespace. The project-host
stop path previously fenced ACP work only after container removal.

Commit `5cace5e6a1` adds the existing project ACP fence before `runner.stop` and
retains the post-stop sweep for late completion/queue races. It adds ordering
and failure regressions rather than bypassing the lifecycle API or forcibly
removing containers by hand. All 60 project API tests and project-host typecheck
passed; Jest retained its existing open-handle warning. The 14 focused frontend
tests, frontend lint and dependency consistency check also passed.

Deployed artifact `20260921T105243Z-5cace5e6a115` (SHA-256
`0d7240bb542240e41099beb34b2a4392ff3b5eb5b225c916ff6c815bef084fc5`), upgrade
`24d5bee4-f543-467d-ae12-bef2a5d33ccd`. First restored the partly stopped test
project with ordinary restart `585d3c42-27f3-4e16-93f5-ddf17d3fab1f`. A new local
inference turn `190d7b58-2803-4d34-8dc1-7dc9e93cf958` completed and retained
sidecar `acp-1892b11a-6c63-4a92-988d-01dcddc0bc79-1b0f8184-1293-4740-94bd-84e143e40e89`.
Restart `b1ae798e-4d7e-462d-b3c6-5fa93f53f6fa` then succeeded with that sidecar
present. Container inventory confirmed its removal. An explicit browser
follow-up `8b399cb2-8801-4c5a-a07d-a836d5c8506a` completed after restart, keeping
native Pi session `01a0c373-055c-72d0-98c2-b4adfb21919d` and registry kind `acp`.

This covers normal project restart between completed turns. Abrupt project loss
during a delivered prompt, resource exhaustion, and failure of the cleanup
fallback still require separate qualification. The test project remains
network-enabled; this does not expand the separate offline inference claim.

## Active Restart And Lost Question Responder

Active-prompt restart exposed a second distinction from native Codex: fencing a
delivered generic prompt cannot certify cancellation. Commit `4662e3d7f4` makes
the registry fence mark running generic prompts `error`, while queued requests
remain canceled and native/command behavior is unchanged. The exact fence reason
is retained to prevent automatic recovery. Late worker completion cannot overwrite
the fence. Queue/detached-worker validation passed 97 tests and project-host
TypeScript passed.

Deployed artifact `20260921T110244Z-4662e3d7f488`, SHA-256
`76d66afbab75e2687a9e46a52121795d6ef062ae81a7ab40e5cf4943ac7ae45f`, upgrade
`01a8bed4-02c8-4de8-afd0-5e525af7dbe4`. Live operation
`c5e6f792-2677-4a94-a8eb-37e3f1b1479e` visibly streamed `working` before project
restart `35a69cad-d585-4c01-b990-d1551864cb37`. Restart succeeded, removed its
sidecar, left the job `error` with the restart fence reason, and preserved the
uncertainty warning after browser reload. No new turn was automatically created.
This qualifies an orderly restart during a prompt, not arbitrary abrupt loss.

A separate hard-worker-loss probe found that a pending question stayed actionable
after its responder died. Startup reconciliation ran when the service API was
initialized, but not when only its detached worker was replaced. Commit
`51a91a611e` reconciles pending synchronous attention after detached-worker startup
recovery and the periodic orphan sweep. Preservation requires a running lease
and a live owner, not merely a live process. Existing notification and ownership
paths are reused. Commit `dcce9c0be9` additionally tests rejection of late answers
to questions made stale this way. The attention/detached-worker checkpoint passed
75 tests and project-host TypeScript; the follow-up passed 53 detached-worker
tests (overlapping suites, not additive).

Deployed artifact `20260921T111100Z-51a91a611ea2`, SHA-256
`8c105b5a6aed74b576819bbd0050229484ca243451426f5ae8073f9c598b3d3d`, upgrade
`6a9f858a-b1d5-49bc-9313-6d2a1f8968f0`. Static UI was rebuilt at `dcce9c0be9`.
Live retest operation `3303043f-f0e0-479d-81ec-9270c55d936c` was waiting on
attention `364e254e-cc88-4571-be2b-d0507ca8e460`. After verifying that this was the
host's only running job and checking worker PID/start time, deliberately killed
only that worker once. Its supervisor replaced it without restarting the hub.
The already-open UI removed Send response; the durable record became `stale`
with no response ID. No recovery child was created, the old worker disappeared,
and container inventory contained no ACP sidecar. No running jobs remained.

One preceding submission failed before launch with `Scoped ACP CLI credentials
unavailable` because host token issuance timed out. It did not fall back to other
credentials or launch a harness; the subsequent deliberate submission succeeded.
This transient failure was observed, not silently retried or treated as a model
failure.

The remaining unknown-outcome classification gap at that checkpoint was fixed in
`49c4f9323f`: orphaned generic prompts now finalize the job and lease as `error`,
preserve partial output, and put an explicit unknown-outcome/no-resend warning in
chat history, including when no output arrived before worker loss. Native Codex
recovery is unchanged. Shared repair retains this classification when chat
storage is unavailable and retries projection without duplicating the warning.
All 155 chat-writer/detached-worker tests and the project-host TypeScript build
passed, including partial, empty and unavailable chat cases.

Deployed artifact `20260921T112616Z-49c4f9323f48`, SHA-256
`8a22234f40f1105488cf917d117427ba14e8341d155b582e0ac0e5dc9c38569e`, upgrade
`cf5092c3-d952-44b5-b120-091df5895e68`. Retest operation
`5bde7397-8b2b-4b7b-9973-a128132dedd3` waited on question
`6413b31d-c504-4370-ac49-7cb2f6db0094`. The guarded one-time worker kill was
followed by automatic worker replacement, an explicit unknown-outcome warning
in the already-open browser, job `error`, question `stale` with no response, and
zero recovery children. The warning survived browser reload. The old process
and its sidecar disappeared. These results do not qualify all async QA,
abrupt-project-loss or persistence-failure behavior.

## Options Before The First Turn

Commit `e83386f69e` adds explicit discovery through the existing principal-bound
project control channel. The server reads the thread's configured profile rather
than accepting executable details from the discovery request. A temporary ACP
session initializes, opens, applies selected settings and returns bounded
advertised controls, then cleans up. It never prompts or loads/replaces the
conversation's native session. Duplicate discovery is rejected, total concurrent
discovery is capped, and project stop waits for local discovery cleanup before
fencing turn workers. Old hosts reject the new action rather than silently
running a prompt. Discovery still launches project code with full project access;
it is explicit, not automatic metadata fetching.

The ACP new-agent form now offers **Create and configure first**, registering the
agent without sending a turn and preserving any typed prompt as a draft. The
conversation exposes **Load model and mode options**, keyboard-operable with
loading/error announcements. Controls remain advisory and are validated again at
execution. Discovery UI state is keyed to project/chat/thread, and subsequent
turn-reported controls supersede stale discovery results.

Validation: 12 discovery/admission tests, 12 frontend tests, 21 Conat tests,
60 project API tests and 48 worker-manager tests passed. Frontend lint and both
frontend and project-host TypeScript builds passed. Project API Jest retains its
existing open-handle warning.

Deployed backend `20260921T114045Z-e83386f69e4a`, SHA-256
`7994ac05ec7409c2158100004a755de418c76cdea4b6bd7ffd7c62b7192bad96`, upgrade
`c860cbfe-104b-47e6-9f72-67642554d347`. Live keyboard testing created `agent-8`
without running a turn, preserving draft `settings`. Discovery exposed Fast/Deep
options; the job table was unchanged and the temporary sidecar was gone before
submission. Selecting Deep and explicitly submitting the draft produced
`deep/code`. Operation `c2880b14-8ddf-430d-b807-37e515af3e23` completed with
admitted model `deep`; thread `c4a520da-1c2a-4c82-8174-c0b3b2952bed` had exactly
one job. This proves the deterministic first-turn path, not every real harness's
catalog behavior or all concurrent restart/discovery cases.

Follow-up qualification on the same backend also passed real-harness discovery:
Pi 0.86.1 / pi-acp 0.0.33 exposed the configured local Qwen Model and Thinking
controls in `agent-6`; OpenCode 1.18.31 exposed its loopback fixture Model and
Session Mode controls in `agent-5`. Both used temporary sessions, created no chat
job, and removed their discovery sidecars. These were the explicitly configured
local/fake providers, not paid services or a claim about every provider catalog.

Concurrent restart check: `agent-9` was created without a prompt using the
deterministic fixture's `--hang` initialization mode. While its discovery sidecar
`acp-1892b11a-6c63-4a92-988d-01dcddc0bc79-1d183e49-b27e-4c04-a35f-b5437c1230b6`
was running, requested project restart
`d14d0642-5696-4a5b-9200-a3f21d2e711b`. The UI reported the bounded setup timeout;
restart then succeeded and container inventory contained no ACP sidecars. The
latest job remained `c2880b14-8ddf-430d-b807-37e515af3e23`, with zero running
jobs. This covers draining an already-started discovery through its timeout, not
all possible admission/stop races or process-removal failures.

## Reproduce

Local protocol tests (includes package build):

```sh
pnpm -C src/packages/ai test:harness
```

Bundle `src/packages/ai/acp/__tests__/harness-provider-smoke.ts` using the installed
esbuild with `--bundle --platform=node`, transfer the bundle to a disposable
project, and run one of:

```sh
node smoke.cjs /absolute/path/to/node_modules/.bin/opencode
node smoke.cjs /absolute/path/to/node_modules/.bin/pi-acp pi
```

For the offline check, run the same bundled tool inside a separately provisioned
Linux container with `--network=none`, the pinned packages available read-only,
and writable scratch space. Append `--require-loopback-only` to either command.
The probe creates its own loopback provider; no network proxy, API key or real
model service is needed. Merely setting that flag in a networked container must
fail rather than claim offline qualification.

Install the exact package versions above first. Installation is explicit; the
client never installs packages. Set `COCALC_ACP_SMOKE_DEBUG=1` only for this fake
provider tool to capture bounded child output while diagnosing setup.

The disposable project on the existing lite4b-backed host is
`1892b11a-6c63-4a92-988d-01dcddc0bc79` (ACP harness disposable qualification).
Pinned packages are in `/home/user/acp-qualification`. No new host was allocated.
No application restart or deployment was needed for the standalone checkpoint;
the subsequent durable checkpoint above upgraded and restarted the test host.

## Next Integration Slice

The admission checkpoint adds four tests (including a real SQLite profile
round-trip and proof that Codex payment resolution is bypassed), two explicit
worker-recovery regressions and host registration. The chat writer records
`agent_kind=acp`. Profile changes currently require a fresh conversation while
the previous profile is retained. Codex funding/options, automation and immediate
agent-network guidance are rejected for this experimental path, not silently
ignored. Queued network delivery has passed the same-project live check recorded
above. Recovery never automatically resubmits an uncertain generic turn.

Validation: 106 chat-writer/admission/queued-message tests, 47 detached-worker
tests and 11 project-host worker/launcher tests passed, plus the project-host
TypeScript build. This is not yet browser-to-container end-to-end validation.
The client now routes harness requests exclusively to `harness-v1`; old hosts
have no compatible execution listener. The native endpoint rejects runtime
selectors, and the harness endpoint requires ACP v1 while retaining the same
account/project subject binding. There is no native fallback on failure.
Protocol/client tests cover this behavior, and project-host authorization tests
cover matching and mismatched identities on the new subject.
Continue qualifying interrupted-chat projection and broaden real-harness
coverage beyond the live checks above. Do not enable the host flag for general
use yet; the current UI is an experimental operator-testing surface.

1. Broaden live qualification to persistence failures and abrupt project loss
   during a delivered prompt. Normal project restart with retained Pi and
   OpenCode native resume after worker restart passed, as recorded above.
   Real Pi/OpenCode discovery and restart during stalled discovery also pass;
   broaden to other provider catalogs and admission/stop races as needed.
2. Extend the supervised launcher's live tests to resource exhaustion and forced
   descendant termination beyond the passing forced-cancellation fixture above.
   The smoke launcher is not reusable as a privileged
   host execution path. Direct Podman removal of the retained Pi sidecar failed
   with "given PID did not die within timeout", even with a five-second grace
   period. The launcher now reuses project-runner's existing container-process
   kill/retry workaround for this specific timeout, targeting only its generated
   sidecar. Unit tests pass; live qualification of that fallback remains a release
   gate. Do not mistake fixture cancellation for proof of forced real-harness
   termination.
3. Broaden accessibility and layout qualification of implemented generic tool
   rendering and advertised model/mode controls. Correct remaining Codex-only
   branding; do not substitute Codex presets.
4. Extend the qualified required-string form QA subset to broader failure/recovery
   cases. Worker-loss invalidation now has live evidence and late-answer regression
   coverage above; async and cross-project cases remain. Text prompts remain the
   only supported input; attachment types and unsupported forms fail explicitly.
5. Broaden the passing external text-write convergence check to simultaneous
   edits; verify snapshot scheduling, broader restore failure handling and
   recovery protection. Home-only and rootfs-only success are qualified above.
   Extend the project-egress-blocked inference check to broader on-prem control-
   plane deployment qualification. Extend same-project messaging to cross-project
   delivery once fresh authentication is available; queued revocation now has
   live evidence above. Remaining gates are not implied by standalone smoke tests.

Do not advertise this checkpoint as a usable generic-harness chat release yet.
