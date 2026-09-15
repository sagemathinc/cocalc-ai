# Agent messaging controlled release

Status: in progress, not a production readiness attestation. No production
deployment or production flag changes are authorized by this work.

## Review baseline

- Worktree: `/home/user/scratch/agent-mentions`, `feature/agent-mentions`.
- Initial clean implementation SHA: `12fbf288b9`.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Initial comparison covers 245 files, including shared Conat, auth, filesystem,
  execution and host changes. The security review must cover the complete diff.
- Historical evidence: `agent-attachments-login-progress.md`. Its live results
  are checkpoints, not fresh verification of this release candidate.
- Final clean review SHA and deployed artifact manifest: not yet pinned.

## Current verified work

The account AI preference `other_settings.experimental_agent_messaging` is
default off (only literal `true` enables it, including Immutable store values).
It hides naming, agent suggestions and new connection approval entry points.
It does not alter backend authority, stored approvals, external credentials,
ordinary collaborator mentions or existing message content. My Agents remains
available for management. The preference description explicitly explains this.

Focused frontend verification on 2026-09-15: six suites / 55 tests passed,
including keyboard operation, persistence failure, no preference write on mount,
and no grant/revocation side effects when opted out. Frontend lint passed.
Frontend typecheck also passed after the test changes.
No live deployment of these changes yet.

Reproduce from `src/packages/frontend`:

```sh
pnpm exec jest account/agent-messaging-preference.test.tsx agents/agent-mentions.test.tsx agents/source-agent-name.test.tsx agents/ui-preference.test.ts chat/__tests__/agent-communication.test.tsx editors/markdown-input/mentionable-users.test.tsx --runInBand --forceExit
pnpm exec tsc --build
```

From repository root: `pnpm -C src lint:frontend`.

## Operational work still required

- Separate restrictive management from feature enablement. Current site-off
  paths can hide records or prevent revocation; retain authenticated home-bay
  inspection and pause/revoke while continuing to reject new authority/admission.
- Trace the master, RPC, personal, attachment and external-login gates through
  every entry point, including already-connected clients and in-flight work.
- Document configuration reload/restart requirements and exact admission cutoff;
  do not promise cancellation of work already accepted.
- Verify migration, mixed-version rejection, deployment ordering and rollback
  without modifying legacy pending/uncertain records.

## Security review work still required

- Build an entry-point/capability/ownership map for the entire comparison diff.
- Verify two real accounts and scoped identities across bays: impersonation,
  destination authorization, non-messaging APIs, suspension, membership removal,
  steering, connected-token revocation and expiry at each admission stage.
- Measure process RSS and bounded resource behavior under malformed binary data,
  fragments, concurrent installations/senders, abandoned preparations, disk
  exhaustion and filesystem races. Per-request limits are not a process bound.
- Verify execution principal and quota/start gates at real runtime boundaries.
- Record test provenance: deterministic adapter, database integration, real
  transport, real scoped identity, browser approval, or actual model execution.
- State explicitly that collaborators sharing a project OS user are not isolated
  from each other's files or process credentials by human-scoped messaging.

No suspected vulnerability has been established in this release pass so far.
Any such finding must follow `SECURITY.md`: private advisory and temporary private
fork, no public findings or fixes before coordinated disclosure/deployment.
This sentence is not evidence that the unreviewed code is safe.

## Blockers versus unfinished work

No external blocker established. Security review, adversarial verification,
dev deployment and release handoff remain unfinished work, not completed gates.
Next concrete step: finish the UI checkpoint, then test and implement site-off
restrictive management without weakening account-home ownership/authentication.
