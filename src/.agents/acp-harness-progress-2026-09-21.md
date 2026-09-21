# ACP Harness Implementation Checkpoint

Date: 2026-09-21. Branch: `feature/acp-harnesses`. Draft PR: #663, stacked on
`feature/my-agents-workspace` (#640).

## Implemented

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
Live qualification of that presentation fix is still pending at this checkpoint.

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

The UI remains experimental: dynamic model/mode controls, rich generic tool
rendering, incoming network requests, task QA and images are not qualified.
Some shared completion notifications still use Codex wording. A feature flag on
the host remains required; discovery/old-host UX needs further work.

## Validation And Real Harnesses

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

Discovery/session creation made zero inference calls in these probes. Both
advertise session loading; Pi additionally passed live durable restart/resume
as recorded above, while OpenCode restart/resume remains unqualified. The
fixture covers resume replay suppression and unsupported resume behavior.
The final two-turn probes made four fake-provider calls for OpenCode and three
for Pi, including their file-write tool loop.

There was no paid inference and no real subscription credential was supplied.
Each probe uses a new temporary HOME, explicit environment and nonsecret dummy
provider key. Pi's executable uses `env node`; the launcher must include the
directory of the installed Node executable in PATH, not just `/usr/bin`.

This proves protocol/tool compatibility without API keys. It does not prove model
quality or offline operation under blocked public egress. Later snapshot and
browser-to-worker checks are recorded separately above. Public egress was not
blocked during qualification.

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
the previous profile is retained. Codex funding/options, automation and inbound
agent-network delivery are rejected for this experimental path, not silently
ignored. Recovery never automatically resubmits an uncertain generic turn.

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

1. Broaden live qualification to persistence failures and OpenCode native resume.
   Add capability discovery for the versioned RPC.
2. Extend the supervised launcher's live tests to resource exhaustion and forced
   descendant termination. The smoke launcher is not reusable as a privileged
   host execution path. Direct Podman removal of the retained Pi sidecar failed
   with "given PID did not die within timeout", even with a five-second grace
   period. The launcher now reuses project-runner's existing container-process
   kill/retry workaround for this specific timeout, targeting only its generated
   sidecar. Unit tests pass; live qualification of that fallback remains a release
   gate. Do not mistake fixture cancellation for proof of forced real-harness
   termination.
3. Extend the implemented profile creation/summary UI with useful generic tool
   rendering and model/mode controls from advertised capabilities; do not
   substitute Codex presets. Correct remaining Codex-only notification wording.
4. Qualify task QA/elicitation separately from tool permissions, attachments,
   browser reconnection, native session resume and uncertain-delivery UI. The
   current prompt interface is text-only and does not claim task QA support.
5. Verify editor convergence, automatic snapshot scheduling, home-only restore and local inference with
   public egress blocked. Exercise authorized agent-network messaging. These
   remain required first-release gates, not implied by the passing smoke tests.

Do not advertise this checkpoint as a usable generic-harness chat release yet.
