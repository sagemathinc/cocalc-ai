# Agent Messaging RPC Foundation

Updated: 2026-09-13. Contract: [Agent Messaging As RPC](agent-messaging-rpc-spec.md).

## Scope And Architecture

This is a reviewable, opt-in foundation, not a production-ready messaging product.
A human approves an expiring directional send-only link; an agent discovers its
destination and makes one scoped RPC. The target wakes or queues normally. An
explicit reverse link permits a correlated reply. Results are accepted, rejected,
or unknown; acceptance is execution admission, not task completion.

| Choice                                    | Assessment                                                                                                                             |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Integrated, separate RPC module           | Chosen: reuse identity, human-home authentication, project-owner routing, and ACP admission. No new delivery state machine.            |
| Standalone service                        | Needs additional identity, placement, membership, and revocation integration before proving the same workflow. Not justified yet.      |
| Hybrid with direct scoped host submission | A future data-path optimization; requires an additional credential/permit lifecycle and revocation design. Keep interfaces narrow now. |

Identities live in PostgreSQL at their project's owning bay; RPC links are
authoritative at the source project owner. Target identity and placement resolve
through the target owner. Human fresh authentication happens at the account home
bay; reusable human/source credentials are not copied between bays.

Current body path: CLI -> source-owner agent RPC -> target-owner RPC -> assigned
host -> ACP admission. This deliberate pilot proxy reuses the narrow authenticated
agent subject and trusted owner/host calls instead of inventing another host
credential protocol. It is not a general-purpose project data proxy. Direct scoped
host access is a separable future optimization, not a new queue.

Only bounded in-memory attempt evidence and short-lived admission permits are
added. Chat and existing ACP keep their existing persistence. There is no messaging
outbox, delivery worker, automatic retry, or exactly-once guarantee. Missing
evidence and ambiguous timeouts return unknown.

## Retained Foundation

- Per-turn scoped identities, authenticated attribution, fresh human approval,
  revocation, exact-target scope, and recipient execution identity.
- Cross-bay and cross-host routing; source and target need not share a bay.
- RPC-only Codex settings controls, copyable thread URLs, preview, private drafts,
  bounded expiry, and explicit guidance permission. No legacy fallback.
- CLI discovery, explicit `--rpc` sends, inspection, and correlated replies via
  separately approved reverse links.
- Automatic project startup through existing Codex/start-admission code,
  respecting runtime sponsorship, slots, Automatic starts, and lifecycle rules.
  The assigned host must already be available; no other project is stopped.
- Startup consumes the RPC deadline. Recheck authorization after startup; late
  lifecycle completion cannot deliver an expired message. Inspection never starts.
- Supporting live-test fixes: home-bay host action auth, host placement and
  availability, runtime membership resolution, bootstrap process exit races,
  thread navigation, and fresh-auth refresh.

## Legacy Isolation And Rollout

The tested development history is preserved locally as
`archive/agent-messaging-tested-20260913` at `8fefc4f3d0`. The replacement branch
`feature/agent-messaging-rpc-foundation` starts from `origin/main` at `9b06a09f93`.
It replaces PR #547 rather than shipping the obsolete delivery experiment.

Legacy dispatch, claims, reconciliation, submission journals, and recovery workers
are excluded. V1 tables and read-only receipt/grant inspection remain solely for
compatibility. Legacy send/grant/admission endpoints reject without submitting
work; ACP also refuses queued V1 deliveries. Existing records/submission files
are not erased, reclassified, or replayed.

Before rollout:

1. Inventory pending/uncertain V1 work; retain records/files for human disposition.
   Do not translate old request IDs into RPC attempts.
2. Disable admission and stop old delivery/recovery workers on every involved bay
   and host. Mixed versions are not a supported cutover strategy: old processes
   can still act on legacy state.
3. Upgrade the hub/host/ACP-worker/CLI set and run normal schema sync before
   exposing the account UI. Mixed component versions are not supported.
4. Approve fresh RPC links for the pilot. V1 grants do not authorize the new path.
5. Rollback first disables admission. Do not restore old workers against pending
   records without explicit disposition. Already-admitted RPC jobs retain ordinary
   ACP lifecycle semantics; rollback is not cancellation or a replay tool.

## Curated Branch Validation

Passed on this branch: 604 focused tests across CLI, Conat, server routing/auth/
start policy, schema adoption, host/ACP admission, chat, frontend, AI runtime,
and bootstrap. CLI build/test compilation, server/project-host/frontend TypeScript
builds, and frontend lint also passed. This is not a full-repository test run.

Focused checks cover protocol/attempt caching, scoped CLI outcomes, owner routing,
deterministic host admission, deadlines, explicit retries, revocation, startup
policy, UI accessibility/private drafts, fresh-auth refresh, and thread navigation.
Retirement tests assert that old mutations fail before database access/execution.
Schema tests preserve old values and physical tables/indexes, allowing additive
nullable compatibility columns without reinterpreting pending work.

Reproduce from the repo root after installing/building workspace dependencies:

```bash
pnpm -C src/packages/cli build
pnpm -C src/packages/cli exec tsc -p tsconfig.test.json
node --test src/packages/cli/build/test/cli/src/bin/core/agent-message.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat-agents.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat.test.js
pnpm -C src/packages/conat exec jest agents/protocol.test.ts agents/rpc-attempts.test.ts inter-bay/agent-rpc.test.ts inter-bay/agent-identities.test.ts hub/api/index.test.ts --runInBand
NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/rpc.integration.test.ts agents/identity-routing.test.ts agents/retired-delivery.test.ts --runInBand
NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/database exec jest postgres/schema/agent-messaging.test.ts --runInBand
pnpm -C src/packages/lite exec jest hub/acp/__tests__/agent-rpc-service.test.ts hub/acp/__tests__/agent-delivery-authorization.test.ts --runInBand
pnpm -C src/packages/project-host exec jest codex-project.test.ts project-start-admission.test.ts codex/agent-identity-lease.test.ts hub/hosts.test.ts --runInBand
pnpm -C src/packages/frontend exec jest chat/__tests__/agent-communication.test.tsx chat/__tests__/agent-thread-url.test.ts --runInBand
pnpm -C src lint:frontend
```

## Historical Live Evidence

These qualify the retained RPC path on the original development stack, NOT a
deployment of this curated branch. Local lite1b used project-host bundle
`20260913T170628Z-4ebedf545561-dirty-1e178b38` on both hosts and matching dev bays.
Only tests/docs changed between that bundle and preserved baseline `8fefc4f3d0`.

- A: `1ce4fe78-19c7-40a8-a598-947975744cd9`, `A.chat`, host-1/bay-0.
- B: `250ac07f-6ce8-43f9-b845-0ffb10c4d041`, `B.chat`, same host/bay as A.
- recv: `66db94af-0745-4088-b922-879c58942201`, `recv.chat`, QA host
  `agent-rpc-qa-20260912`/bay-1. Fresh human-approved forward/reverse test links
  expire at 2026-09-13 19:02:29 UTC.

Observed in the browser, persisted activity, and authoritative project state:

- Cold cross-host request `9e09b748-83e0-4934-8344-59bb900bea41` and reply
  `1c0d7f69-04c7-4c93-9962-ccef38677165` accepted with correlation
  `cross-host-cold-20260913-01`; startup took about 1.9 seconds.
- Disabled Automatic starts on stopped B rejected
  `24c5d7a0-b83e-4ca8-abff-27ae1a8f095b` without chat effects/startup.
  Restoring the setting did not replay it. Inspection left stopped recv stopped.
- Concurrent cold sends `b88508af-0315-4af3-a762-76a99e8846f1` and
  `601e044b-43c9-44e2-97db-bdfa45becc44` both accepted and both turns completed,
  with one approximately 2.1-second project-start operation.
- An earlier concurrent batch accepted both requests but one later turn failed
  on a 15-second `agent.issueIdentity` timeout near a host control disconnect.
  Later warm/cold batches completed; root cause remains unresolved. No retry was
  added. Acceptance must not be presented as completion.

To repeat, approve new forward/reverse links, leave the receiver host running,
and stop only the recipient project. In a source agent turn:

```bash
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat agent rpc destinations --json
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat send --rpc --to-agent "$TARGET_AGENT_ID" --stdin --json
```

Pipe text/JSON with a unique correlation ID into send. Request exactly one reply,
then acknowledge locally without another send. Record acceptance and completion
separately. `project chat agent rpc inspect --help` describes evidence lookup.
Do not use project exec before a cold-start check.

## Limitations And Next Step

The curated branch needs a coordinated dev rollout and repeated live smoke test
after review. No production deployment is claimed. Review auth, routing, admission,
and retirement before expanding product scope. Separately investigate the observed
execution-identity reconnect timeout.

Quota exhaustion, offline hosts, slow moves/restores, and lost acknowledgments
were not deliberately induced on live user projects; relevant failure boundaries
use deterministic adapters. Same-installation multibay is supported, not cross-site
federation. Agents sharing a Unix UID are not isolated against credential theft.
No automatic replay, universal history, guaranteed completion, or fully qualified
restore behavior is promised.
