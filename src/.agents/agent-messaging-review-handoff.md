# Private Full-Prototype Review Handoff

Prepared September 15, 2026. This packet is for independent review, **not merge or
production approval**. Keep findings and fixes private under SECURITY.md.

## Exact Review Target

- Repository: `sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf`, the temporary private
  fork of draft advisory `GHSA-rff5-g9ff-7qhf`.
- Head branch: `review/full-agent-messaging-20260915`.
- Private review PR: https://github.com/sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf/pull/1
- The advisory PR targets upstream `main`. At creation its base tip was
  `81198e2ad82275b2c886b20bf9e4f275a671b395`; its verified merge base is the
  comparison base below. Do not confuse the moving base tip with that fixed base.
- A convenience branch `review/full-agent-messaging-base-20260915` also pins the
  comparison base in the private fork; GitHub rejected it as an advisory PR base.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Application implementation checkpoint:
  `03a7db57cb6aa067695a0c79185c3423736dbd72`.
- Contract and documentation checkpoint:
  `d18872174cc9a0a24e90999067ed28ed81b5d889`.
- This branch adds only this review packet to that checkpoint. No implementation
  fixes, deployments, credential changes or production flag changes accompany it.
- The PR body pins the final head SHA (including this packet). Confirm that SHA,
  the comparison base and repository before reviewing. If they differ, report it; do not
  silently review a moving branch or substitute another PR.

Public PR #558 remains the earlier RPC foundation at
`4a1c89014ef6ae1f1a464c37ced960214478a330`. It is NOT this review target. Review the
full base-to-head diff here, including personal connections, names/mentions,
attachments, external sender login, UI opt-in/site controls and shared dependency
changes, not merely the delta since the earlier review.

No rebase/merge onto current main was performed to create this packet. At PR
creation, main was 108 commits beyond the shared feature base. Integration with
current main remains later qualification work, not silently included here.

## Contract And Maintainer Decisions

Read [the release contract](agent-messaging-release-contract.md) first. Its content
is pinned by `d18872174cc9a0a24e90999067ed28ed81b5d889`; the PR's copy is identical.
William owns product requirements. The complete document remains labeled draft;
his explicit restart-boundary decision and resource-policy agreement are recorded
requirements, not unresolved questions. Review against this supplied draft and
clearly label any policy ambiguity; do not claim final contract or release approval.

- Collaborators are trusted participants sharing a project OS user. This does not
  erase human-scoped API permissions or isolation from unrelated tenants.
- Removing/downgrading a collaborator does not automatically stop running work.
  To require immediate enforcement, change permissions and explicitly restart the
  project. After successful restart, former privileges must not return through old
  processes, sessions, credentials, controllers, automation or queue recovery.
  William classifies failure as P0. This is declared policy, not verified behavior.
- Test the project-facing boundaries needed for that restart promise, not just
  messaging. Prior external effects and work admitted at another project are not
  undone. A failed restart must not be presented as successful enforcement.
- Project moves stop the old container. Trace the actual lifecycle; distinguish
  copied credentials or host-side controllers from an assumed surviving agent.
- Chat provenance is best effort in mutable project storage, not a tamper-proof
  audit log. It must not become an authorization input.
- Single-attempt RPC reports accepted/rejected/unknown. Acceptance is not
  completion; no outbox, automatic retransmission, exactly-once guarantee or
  guaranteed response cadence is required.
- Bounded resource policy is agreed. Exact aggregate numerical defaults and
  retention still need measurement/documentation, not silent reviewer invention.

Use contract IDs C1-C16. D1 is lifecycle investigation, D2 is limits qualification,
and D3 is verification of the declared restart boundary. Distinguish violations,
correctness/liveness defects, residual risks within the trust model, and proposed
requirement changes. State severity, prerequisites, exact SHA/lines and evidence.

## Earlier Review And Private Fixes

The [prior private report](agent-messaging-pr558-prior-private-review.md) is included
verbatim for continuity. It reviewed head `4a1c89014ef6ae1f1a464c37ced960214478a330`
against base `f84cf8935319aa97e2ba7a2c9cf3610d1bb96295`. Reassess its findings on this
candidate and contract; neither assume them fixed nor copy their severity blindly.

There is a separate, remotely available private branch `private-review`, pinned at
`29d1941f2fe0d876f6e000a2a92038c5379ab097`. It contains earlier investigation/fixes.
It is **excluded** from this review head, not silently merged. Its common ancestor
with this candidate is `40fdca411123e1b8e26a1faa1ae4d889d29b18bb`. You may inspect
that branch as supporting material, but do not report its tests/fixes as present
in the candidate. Reconciliation remains later implementation work after review.

The local private worktree also has an untracked
`src/packages/conat/core/publish-routing-auth.test.ts`. It is excluded, not published
in this packet, and not evidence for the committed candidate. No review requires
access to that local untracked file. The review-head worktree is separate and clean.

## Code Map

Paths below are relative to `src/packages`; inspect the entire diff, not only
this navigation list.

| Area                   | Entry points                                                                                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identities/principals  | `server/agents/api.ts`, `access.ts`, `store.ts`, `identity-routing.ts`; `project-host/codex/agent-identity-lease.ts`                                                                          |
| Personal authority     | `server/agents/personal*.ts`; `util/db-schema/agent-personal.ts`                                                                                                                              |
| External login         | `server/agents/external*.ts`; `server/auth/external-agent-login*`; `http-api/pages/api/v2/auth-cli-agent*`                                                                                    |
| Routing/authentication | `server/agents/rpc.ts`, `messaging.ts`; `server/conat/socketio/auth.ts`; `conat/inter-bay/agent-rpc.ts`; `server/conat/api/project-host-token-auth.ts`                                        |
| Execution              | `lite/hub/acp/agent-rpc-service.ts`; `chat/src/send.ts`; existing ACP queues/workers, membership, startup and funding gates                                                                   |
| Attachments/resources  | `conat/agents/attachments.ts`, `attachment-reservations.ts`, `attachment-staging.ts`, `rpc-capacity.ts`, `rpc-attempts.ts`; shared Conat receive/service paths and filesystem implementations |
| Durable lifecycle      | `util/db-schema/agent-*.ts`, `table-ownership.ts`; `server/agents/personal-rehome.ts`                                                                                                         |
| UI/CLI                 | `frontend/agents`, `frontend/chat`, `frontend/account`, `frontend/public/auth`; `cli/src/bin/core` and `commands/project/chat*`                                                               |

## Evidence And Reproduction

Historical evidence is not final-candidate verification:

- [Current release progress](agent-messaging-release-progress.md).
- [Detailed recorded evidence](agent-messaging-release-evidence-20260915.md).
- [Attachment/login implementation history](agent-attachments-login-progress.md).
- [Operator commands and rollout/rollback](agent-messaging-operator-handoff.md).

The last recorded workspace/browser/CLI build used
`0b3e34f358601cbf8f0b3826714623fbcb5b1072`; receiver archive used
`e43a2ccb10a7cea2012cbdddc296cc8aad85bb41`. A native cross-bay request/reply with a
28-byte attachment passed after receiver upgrade. Earlier native/external 32 MiB
tests exist. The source tools/host and receiver were not a uniformly pinned final
fleet. Final-version external enrollment needs a new first-party human approval;
last recorded QA installations were revoked/expired. Do not revive them.

Recorded UI checks: 58 focused tests plus frontend typecheck/lint and live opt-in
persistence. Schema persistence: 14 tests each on PGlite and isolated PostgreSQL
18.4. These do not establish ownership classification, migration safety or load
behavior. The earlier review's 179 tests concern its earlier head, not this one.

This handoff changes documentation only. No application tests/builds were rerun
for packet creation. Formatting, local document references, unchanged application
source and remote revision retrieval are checked separately in the PR body.

For a fresh checkout, run `pnpm -C src install`, then build required packages
before Jest. Use `pnpm -C src build:dev` when dependency scope is unclear.
Starting checks (not an exhaustive suite, and not run anew for this packet):

```sh
pnpm -C src/packages/util exec jest db-schema/table-ownership.test.ts --runInBand
pnpm -C src/packages/conat exec jest agents/rpc-attempts.test.ts agents/rpc-capacity.test.ts agents/attachment-reservations.test.ts agents/attachment-staging.test.ts agents/attachments-integrity.test.ts core/receive-budget.test.ts core/receive-limits.test.ts --runInBand
env NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/rpc.integration.test.ts agents/personal-store.integration.test.ts agents/external-store.integration.test.ts agents/retired-delivery.test.ts conat/api/agent.kill-switch.test.ts --runInBand
pnpm -C src/packages/lite exec jest hub/acp/__tests__/agent-rpc-service.test.ts --runInBand
pnpm -C src/packages/project-host exec jest codex/agent-identity-lease.test.ts --runInBand
```

Use disposable database fixtures. Distinguish mocked adapter tests from real
distinct-account, scoped-credential, multiprocess and cross-bay boundary tests.
Live dev access is environment-specific; a remote checkout does not grant access
to the implementer's local dev site. Report inaccessible live prerequisites,
not invented passing results. Follow first-party approval flows and account-home
authentication; do not copy credentials between bays or change production flags.

## Requested Review Response

First acknowledge the PR head SHA, comparison base, contract revision and whether
you can fetch each. If inaccessible, report that blocker instead of substituting
another snapshot. Then review, keeping findings private. Do not implement fixes
yet. Report verified findings, residual risks, policy questions, test evidence and
blocked/unfinished verification separately. Recommend minimal corrections without
extracting a new service or expanding delivery guarantees.

This is a complete prototype review target, not a reconciled release candidate
containing all private fixes. Final fixes, independent follow-up review, matched
artifacts, restart-boundary verification and explicit production approval remain
required before release.
