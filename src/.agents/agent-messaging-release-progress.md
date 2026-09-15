# Agent messaging controlled release

Updated September 15, 2026. Status: **dev candidate verified in part; not yet
qualified for production**. No production deployment or flag changes performed.
Security/adversarial review remains paused at maintainer request; no claim of
independent approval is made. Private material remains outside this document.

Autonomous preparation is blocked on the remaining human/review prerequisites,
not on native messaging. The first-party external installation list was checked:
all three QA installations are revoked and expired. A new external enrollment
must use its normal human approval flow. No credential was revived or replaced.

## Source and artifacts

- Worktree: `/home/user/scratch/agent-mentions`, branch `feature/agent-mentions`.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Workspace/browser/CLI build: `0b3e34f358601cbf8f0b3826714623fbcb5b1072`.
- Host archive: `e43a2ccb10a7cea2012cbdddc296cc8aad85bb41`; only progress
  documentation differs from the workspace build above.
- Receiver candidate: `20260915T191304Z-e43a2ccb10a7`, installed on QA host
  `b96028c9-7d3e-4953-a8c9-52f8a5ce52ca` (bay 1).
- Source host/project/tools/installed CLI were not upgraded in the last step.
  Do not claim an identically versioned fleet or a final reviewed SHA.

## Verified outcomes

- Default-off UI: 58 focused tests, frontend typecheck/lint, and live preference
  persistence. Opting out hides setup but retains management and readable chats.
- Full dev workspace build, browser bundle and standalone CLI bundle passed;
  served browser manifest matched local bytes and the pinned source revision.
- Schema persistence: the same 14 tests pass on PGlite and isolated PostgreSQL
  18.4, including concurrent index DDL and preservation of legacy records.
  No application databases were mutated; disposable test databases were removed.
- Earlier 32 MiB native/external attachment tests and stopped-project startup
  are recorded evidence, not newly repeated against the latest receiver archive.
- Receiver upgrade `711e8f1b-1a5d-4b30-b0e4-2708ce865940` succeeded. Project-host,
  router, persist and ACP worker were all observed running/aligned on candidate.
- Post-upgrade cross-bay round trip passed: request
  `8a74dc85-870a-4dab-b411-3a5605a7332c`, reply
  `c07f8d45-b38d-435c-a604-b92c0ef53a2d`; both accepted, both turns finished.
  Recipient verified the 28-byte attachment's digest, source acknowledged locally,
  and no reply loop was observed. The fresh QA approval prerequisite is resolved.
- An earlier clean canary install and explicit baseline rollback succeeded.
  Host history now routes to the owning bay; generic UUID-only `op get` does not.

## Remaining work and blockers

- Independent review remains external/paused, not passed. Do not publish private
  findings or fixes as part of ordinary release preparation.
- Final reviewed source/artifact pinning, fleet activation and production-mode
  qualification remain unfinished. Current dev evidence is not a substitute.
- Final-version external enrollment/send smoke is unfinished; enrollment needs
  explicit first-party human approval, not reused/revived credentials.
- Schema fixtures do not establish behavior under production load or a migration
  of a complete production database snapshot.
- UI polish is intentionally deferred. Existing UX is sufficient for the tested
  workflow but remains awkward; no new visual redesign is required for this pass.

Next: settle the final review/release checkpoint, then align only the intended
test fleet and rerun final-version checks. No further native connection renewal
is currently needed. Do not rebuild artifacts solely because this log changes.

## Reproduction and evidence

- `agent-messaging-operator-handoff.md`: flag names, deployment ordering,
  database fixture commands, rollback procedure and current checkpoints.
- `agent-messaging-release-evidence-20260915.md`: preserved detailed build,
  deployment, receipt, hash and browser evidence, including resolved blockers.
- `agent-attachments-login-progress.md`: earlier bounded attachment and external
  sender implementation/test history.

Read-only host check after loading the matching dev hub environment:

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --profile agent-attachments-qa host deploy status b96028c9-7d3e-4953-a8c9-52f8a5ce52ca --json
```
