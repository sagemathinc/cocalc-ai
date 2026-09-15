# Bounded Attachments And External Sender Login

Updated September 15, 2026. Worktree `/home/user/scratch/agent-mentions`, branch
`feature/agent-mentions`.

## Status

**Native attachment transport is implemented and tested locally, not deployed.
External agent login is not implemented.** Existing messaging deployment is
unchanged. No live attachment test has been performed yet.

There is no identified external blocker to continuing implementation. The old
browser fresh-auth renewal test does not block this work. The remaining items
below are unfinished engineering, not requests for user action.

## Implemented And Tested

- Destination admission: four concurrent operations per host, two per project,
  shared across per-call service facades. Overload rejects without waiting.
  Pending startup retains its slot after caller timeout until actual work settles.
- Structured startup/admission failure codes, including disabled automatic starts,
  sponsor slots, unavailable startup, overload, deadlines, and ambiguous execution
  acknowledgment. No capacity-wait scheduler or automatic message retry.
- Opt-in Conat raw-fragment byte/count bounds before concatenation and decoding,
  plus bounded receive queues. The agent metadata subscription uses 128 KiB per
  message, 4 MiB incomplete reassembly, 32 incomplete messages and a 32-message
  queue when binary attachments are disabled. With the separate attachment flag,
  ingress accepts 33 MiB messages, 132 MiB incomplete reassembly, four partial
  messages, four queued requests and four active handlers. These wire bounds are
  not a whole-process RSS guarantee.
- Repeatable scoped CLI `--attach` for same-project live file references, checked
  again by the receiver before chat insertion and bound into attempt conflict
  detection. Cross-project attachments use metadata preparation followed by one
  binary submission; no text-only or broad human-credential fallback.
- Snapshot validation and source reads: 32 MiB total, 16 regular files, bounded
  UTF-8 basenames, exact metadata and SHA-256 checks. Reads remain bounded if a
  file grows. Symlinks, devices, directories and base64 substitutes are rejected.
  Payloads use native `Uint8Array`/`Buffer`.

Connected through the scoped CLI, account-home/project-owner routing and shared
project-host receiver:

- `AgentAttachmentReservations`: metadata-only preparation/startup with a maximum
  30-second lifetime, binding to source/target/principal/run/link/attempt/body/
  manifest, single claim, cancellation, and authorization rechecks around staging.
  It uses a supplied shared `AgentRpcCapacity`. Expiry cannot release resources
  still doing I/O or authorize late execution. Lost acknowledgments retain files
  for possibly accepted work; nothing automatically resubmits.
- `stageAgentAttachments`: writes via a supplied sandboxed destination project FS
  into random `/tmp/cocalc-agent-attachments-<uuid>` directories. Numbered child
  directories preserve duplicate basenames. A byte-free manifest records actual
  local paths. No archive extraction. Partial writes are cleaned up; cleanup
  failures are visible. The helper itself never starts a project or agent.

The recipient validates its thread and normal startup policy before returning
readiness, then checks startup/authorization again before writing files. The bay
and host retain metadata-only, expiring reservations, not a messaging outbox.
Submission consumes the reservation; startup can finish after timeout but cannot
submit a late message. Authorization permits never contain file bytes.

Retention deliberately uses the existing finite project scratch quota and project
restart cleanup, not a separate managed budget or retention scheduler. Failed
staging is removed; files for possibly accepted work remain. A host restart is not
a project scratch reset: files may survive it, but in-memory preparations do not.
Accepted attachments are ephemeral, not a durable archive; queued work that loses
its files on project restart must not assume those files are still available.
The prompt supplies actual local paths and tells the recipient to copy files into
the project home when it needs durable retention. No 24-hour cleanup is promised.

Enable `COCALC_AGENT_MESSAGING_ATTACHMENTS_ENABLED=1` on participating hubs and
hosts only after deploying the new code. Text-only messaging retains its existing
flags. General host-control ingress permits 65 MiB messages to preserve existing
64 MiB copy archives, with bounded partial reassembly and queueing.

## Reproduction

Latest focused results: 94 Conat tests, 30 receiver-service tests, 64 server tests
and 11 CLI tests passed. Package TypeScript builds passed during wiring; final
candidate builds are being checked again. These are local checks, not live-site
proof.

Run from this worktree:

```sh
pnpm -C src/packages/conat exec tsc --build
pnpm -C src/packages/conat exec jest agents/attachment-reservations.test.ts agents/attachment-staging.test.ts agents/attachments.test.ts agents/attachments-integrity.test.ts agents/rpc-capacity.test.ts agents/rpc-attempts.test.ts core/receive-budget.test.ts core/receive-limits.test.ts --runInBand
pnpm -C src/packages/lite exec jest hub/acp/__tests__/agent-rpc-service.test.ts --runInBand
env NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/rpc.integration.test.ts agents/personal-store.integration.test.ts agents/personal-rehome.integration.test.ts agents/retired-delivery.test.ts --runInBand
pnpm -C src/packages/cli exec tsc -p tsconfig.test.json
node --test src/packages/cli/build/test/cli/src/bin/core/agent-attachments.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat.test.js
```

Staging tests write actual temporary files using a test filesystem adapter.
Combined tests cover prepare/start, file staging, execution acknowledgment and
lost acknowledgment. A separate real Conat test routes a native 32 MiB binary
payload through home/source/target bay services, checks full SHA-256 integrity,
rejects a changed body, and rejects reuse of consumed readiness. Its host
execution adapter is mocked; it does not prove deployed routing or real agents.
Negative tests include quota failure, partial/manifest writes, duplicate names,
directory collisions, invalid digests, revocation, startup/I/O expiry, conflicting
principals/content, and concurrent claims.

No frontend changes have been made in this increment.

## Next Concrete Steps

1. Finish candidate validation and commit the complete native attachment path.
2. Build host/project/tools bundles, upgrade the two QA hosts and ACP workers,
   restart hubs with the attachment flag, and verify deployed versions.
3. Demonstrate real cross-host/cross-bay attachments, stopped-target startup,
   denied startup, and same-project references. Preserve user drafts and grants.
4. Implement external sender enrollment after the native attachment path works.

## External Login: Not Implemented

Use distinct stable external identities and installation credentials, not fake
project IDs or native-thread impersonation. Reuse first-party browser login and
fresh-auth approval, with account-home ownership and expiring/revocable send-only
authority. Native identity/run/endpoint and personal-name/grant checks currently
assume a project-backed source; extend those checks deliberately, not by bypass.
Remote credentials must not become ambient authority for other humans' turns.

Two independent enrollments can connect native agents on two CoCalc sites; each
destination wakes its own native recipient. No new receiver daemon or general
federation is necessary. Arbitrary-computer receiving and federation stay deferred.
