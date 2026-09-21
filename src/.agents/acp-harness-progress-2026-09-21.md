# ACP Harness Implementation Checkpoint

Date: 2026-09-21. Branch: `feature/acp-harnesses`. Draft PR: #663, stacked on
`feature/my-agents-workspace` (#640).

## Implemented

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
  beneath surviving processes. Six mocked lifecycle tests pass; live host
  qualification remains. It is registered in the host and detached worker;
  abrupt-worker orphan reconciliation and live validation are still needed.

## Validation And Real Harnesses

Passed the AI package build, all 140 existing AI Jest tests, 23 new subprocess
tests, and workspace dependency version consistency check. No frontend changed.

Both of these pinned installations completed initialization, session creation,
streamed a response, wrote the expected file through their own real tools, and
completed a second prompt in the same session:

| Harness  | Version                                  | ACP adapter           | Provider               |
| -------- | ---------------------------------------- | --------------------- | ---------------------- |
| OpenCode | `opencode-ai@1.18.31`                    | Native `opencode acp` | Loopback fake provider |
| Pi       | `@earendil-works/pi-coding-agent@0.86.1` | `pi-acp@0.0.33`       | Loopback fake provider |

Discovery/session creation made zero inference calls in these probes. Both
advertise session loading; real restart/resume still needs qualification. The
fixture covers resume replay suppression and unsupported resume behavior.
The final two-turn probes made four fake-provider calls for OpenCode and three
for Pi, including their file-write tool loop.

There was no paid inference and no real subscription credential was supplied.
Each probe uses a new temporary HOME, explicit environment and nonsecret dummy
provider key. Pi's executable uses `env node`; the launcher must include the
directory of the installed Node executable in PATH, not just `/usr/bin`.

This proves protocol/tool compatibility without API keys. It does not prove model
quality, offline operation under blocked public egress, snapshot recovery, or the
CoCalc browser-to-worker path. Public egress was not blocked during qualification.

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
No application restart or deployment was needed for this standalone checkpoint.

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
Before exposing UI, qualify live sidecars, interrupted-chat projection,
native session resume and orphan-container cleanup. Do not enable the host flag
for general use yet.

1. Qualify the opt-in durable admission/worker path live, including interruption
   and persistence failures. Add capability discovery for the versioned RPC.
2. Implement a supervised container launcher through existing project-host
   execution. Preserve scoped run identity/agent-network grants, structured argv,
   cancellation and descendant termination. The smoke launcher is not reusable
   as a privileged host execution path.
3. Adapt normalized events to durable CoCalc chat events and expose minimal
   profile selection in the existing Agents workspace. Support model/mode controls
   from advertised capabilities; do not substitute Codex presets.
4. Qualify task QA/elicitation separately from tool permissions, attachments,
   browser reconnection, native session resume and uncertain-delivery UI. The
   current prompt interface is text-only and does not claim task QA support.
5. Verify editor convergence, snapshot schedule/restore and local inference with
   public egress blocked. Exercise authorized agent-network messaging. These
   remain required first-release gates, not implied by the passing smoke tests.

Do not advertise this checkpoint as a usable generic-harness chat release yet.
