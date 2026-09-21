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
Live qualification then passed on host bundle
`20260921T082841Z-27046431436e` (upgrade operation
`5f29c4eb-dee4-4185-a361-2f6cf13a8f94`): a fresh hanging turn survived browser
reload, and Interrupt preserved `working` followed by `Conversation interrupted.`
without a new error or resubmit prompt. No fixture turn remained running.

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

1. Broaden live qualification to persistence failures and project restart.
   OpenCode native resume after worker restart passed, as recorded above.
   Add pre-first-turn model/config capability discovery.
2. Extend the supervised launcher's live tests to resource exhaustion and forced
   descendant termination. The smoke launcher is not reusable as a privileged
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
4. Extend the qualified required-string form QA subset to failure/recovery
   cases, including stale replies after worker loss. Text prompts remain the
   only supported input; attachment types and unsupported forms fail explicitly.
5. Broaden the passing external text-write convergence check to simultaneous
   edits; verify snapshot scheduling, home-only restore and recovery protection.
   Complete browser-to-worker local inference qualification with public egress
   blocked. Extend same-project messaging to cross-project and queued-revocation
   cases. These remain release gates, not implied by the standalone smoke tests.

Do not advertise this checkpoint as a usable generic-harness chat release yet.
