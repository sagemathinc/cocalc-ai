# Bounded Attachments And External Sender Login

Updated September 15, 2026. Worktree `/home/user/scratch/agent-mentions`, branch
`feature/agent-mentions`.

## Status

**Partial implementation, not deployed. Cross-project attachment sends and
external agent login are not available yet.** Existing messaging deployment is
unchanged. No new live attachment test has been performed.

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
  queue. This is not yet a binary-upload path or a whole-process RSS guarantee.
- Repeatable scoped CLI `--attach` for same-project live file references, checked
  again by the receiver before chat insertion and bound into attempt conflict
  detection. Cross-project attachments explicitly reject; no text-only or broad
  human-credential fallback.
- Snapshot validation and source reads: 32 MiB total, 16 regular files, bounded
  UTF-8 basenames, exact metadata and SHA-256 checks. Reads remain bounded if a
  file grows. Symlinks, devices, directories and base64 substitutes are rejected.
  Payloads use native `Uint8Array`/`Buffer`.

Additional internal components are tested but **not connected to production RPC**:

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

The staging helper relies on the supplied filesystem's scratch quota. The earlier
proposed 256 MiB managed budget and 24-hour cleanup policy are **not implemented**.
Retention, orphan cleanup, and host-restart behavior must be settled before
enabling binary sends; a project scratch reset is not the same as a host restart.

## Reproduction

Latest focused results: 83 Conat tests, 22 receiver-service tests and 11 CLI tests
passed. Conat TypeScript build passed. These are local checks, not live-site proof.

Run from this worktree:

```sh
pnpm -C src/packages/conat exec tsc --build
pnpm -C src/packages/conat exec jest agents/attachment-reservations.test.ts agents/attachment-staging.test.ts agents/attachments.test.ts agents/attachments-integrity.test.ts agents/rpc-capacity.test.ts agents/rpc-attempts.test.ts core/receive-budget.test.ts core/receive-limits.test.ts --runInBand
pnpm -C src/packages/lite exec jest hub/acp/__tests__/agent-rpc-service.test.ts --runInBand
pnpm -C src/packages/cli exec tsc -p tsconfig.test.json
node --test src/packages/cli/build/test/cli/src/bin/core/agent-attachments.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat.test.js
```

Staging tests write actual temporary files using a test filesystem adapter.
Combined tests cover prepare/start, file staging, execution acknowledgment and
lost acknowledgment. These do not verify deployed Conat routing or real agents.
Negative tests include quota failure, partial/manifest writes, duplicate names,
directory collisions, invalid digests, revocation, startup/I/O expiry, conflicting
principals/content, and concurrent claims.

Earlier in this implementation turn, 54 server RPC/personal-store/retired-delivery
regressions and CLI/Lite/server package builds passed. No frontend changes have
been made in this increment.

## Next Concrete Steps

1. Wire metadata preparation/cancellation and one binary submission through the
   scoped CLI and project-owner routing. Keep bytes out of JSON authorization
   permits, databases and logs; bind the exact manifest instead.
2. Share a host reservation registry and capacity with text sends. Do not create
   a registry per RPC facade. Validate the thread and startup before readiness.
3. Bound raw ingress, decoded queues and active relays on all participating hubs
   before enabling 32 MiB payloads. Preserve existing copy behavior on general
   host-control services. No new east-west network or human credential transfer.
4. Connect staging to chat preparation, define bounded cleanup/restart behavior,
   then test routed failures and lost acknowledgments. Deploy only the complete
   opt-in path and verify real cross-host/cross-bay and stopped-target sends.
5. Implement external sender enrollment after the native attachment path works.

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
