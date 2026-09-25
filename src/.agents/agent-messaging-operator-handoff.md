# Agent messaging: controlled rollout handoff

Status: private remediation and release preparation, not permission to deploy to
production. The [release contract](agent-messaging-release-contract.md) is approved
for review. Independent re-review and final matched-candidate qualification remain
outstanding. Private review material stays private. Later dated status supersedes
earlier checkpoints.

## Candidate and evidence

- Current private reviewer/deployment handoff: `c855b662e4` on
  `fix/agent-messaging-review-20260916`.
- The workspace/browser/CLI build `0b3e34f358601cbf8f0b3826714623fbcb5b1072`
  and host archive `e43a2ccb10a7cea2012cbdddc296cc8aad85bb41` are historical
  pre-remediation deployment evidence, not current candidate artifacts.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Worktree: `/home/user/scratch/agent-messaging-security-fixes`.
- Private repository: `sagemathinc/cocalc-ai-ghsa-rff5-g9ff-7qhf` only.
- The private PR must pin the final documentation head after push. No current
  remediation artifact has been deployed to production.

Dev QA update, September 16: clean build
`20260916T023414Z-fc9ca3baea3a` from private head `fc9ca3baea3a` is installed on
`agent-rpc-qa-20260912`. Project-host, router, persist, and ACP worker are aligned
and healthy. Archive SHA-256 is
`806c276cdf4a6ae49fd37ffa7d6d0572c91143ad01c876fc1f45bb2341025f2c`.
This is a dev-only private candidate, not a production default.

Later September 16 update: exact private handoff `c855b662e444` produced build
`20260916T061335Z-c855b662e444` (SHA-256
`8d48288b3926b48e8fc0fb5a37b390b66f31e64765c61ec271346b53a29552a2`). The QA
host reports project-host, router, persist, and ACP worker healthy and aligned on
that build. The upgrade watcher returned unknown, but direct deployment state
proved promotion; no duplicate operation was submitted.

| Requirement                   | Evidence                                                                                    | Remaining qualification                              |
| ----------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Default-off experimental UI   | 58 focused frontend tests, frontend typecheck/lint, live switch persistence on September 15 | Broader production usage after explicit opt-in       |
| Management while opted out    | Live My Agents page retained existing Open, pause/revoke and installation controls          | Independent review remains separate                  |
| Native bounded attachments    | Earlier dev cross-host/bay recipient verified 32 MiB size and digest                        | Repeat ordinary request/reply on final candidate     |
| External sending              | Earlier separately enrolled CLI sent 32 MiB to native recipient                             | Final-version enrollment/send smoke                  |
| Deployment/rollback mechanics | Receiver-host canary and explicit baseline rollback both succeeded                          | Not proof that arbitrary code/schema downgrades work |
| Cross-bay deployment history  | Normal account-home CLI returned both operation records after `57086e3d96`                  | Unscoped `op get <UUID>` still reads locally         |
| Exact fleet provenance        | Browser and host manifests/digests recorded in progress document                            | Fleet intentionally not yet one final release build  |

## Operator controls

Schema persistence checks cover legacy/personal tables, RPC links/project
fences and external identities/installations: 14 tests pass with
`NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand postgres/schema/agent-external.test.ts postgres/schema/agent-messaging.test.ts postgres/schema/agent-personal.test.ts`
from `src/packages/database`. The default uses PGlite. The same 14 fixtures also
pass on an isolated PostgreSQL 18.4 cluster, exercising concurrent index DDL.
This qualifies these fixtures, not migration under production load or against a
copy of the complete production database.

For real PostgreSQL, start a disposable local cluster with a Unix socket on port
55439 and set `COCALC_AGENT_SCHEMA_PG_SOCKET` to its socket directory. The fixture
connects as the current OS user, creates a random database for each test, and
drops only that database on teardown. It never selects an existing application
database. Example (run from `src/packages/database`):

```sh
qa=$(mktemp -d /tmp/agent-schema-pg-XXXXXX)
/usr/lib/postgresql/18/bin/initdb -D "$qa/data" --auth-local=trust --auth-host=reject --no-locale --encoding=UTF8
/usr/lib/postgresql/18/bin/pg_ctl -D "$qa/data" -l "$qa/server.log" -o "-k $qa -p 55439 -h '' -c shared_buffers=32MB" -w start
trap '/usr/lib/postgresql/18/bin/pg_ctl -D "$qa/data" -m fast -w stop' EXIT
COCALC_AGENT_SCHEMA_PG_SOCKET="$qa" NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand postgres/schema/agent-external.test.ts postgres/schema/agent-messaging.test.ts postgres/schema/agent-personal.test.ts
```

September 15 verification used PostgreSQL 18.4, found zero leftover fixture
databases after testing, and stopped the disposable cluster. No dev-site or
production database was changed.

Agent messaging, personal connections, bounded attachments, and external sender
enrollment are normal CoCalc services. They do not have process-environment
rollout switches. Deploy matching hub and host components before exposing the
experimental account UI.

Initial aggregate controls in the remediation candidate are deliberately
conservative:

- Shared PostgreSQL admission: 1,000 active permits and 1,000 preparations per
  bay, 8/4 per account, and 4/2 per destination project.
- Bounded Conat subscriptions in one process share 512 MiB of retained raw binary
  fragments. This is not exact decoded-RSS accounting.
- Durable creation caps and scheduled retention are documented in
  `agent-messaging-release-progress.md`. Maintenance is restrictive cleanup only;
  it never replays or reinterprets pending/uncertain work.

Apply admission and resource controls consistently to account-home and
project-owning bays. Pause/revoke operations are authorization controls, not an
instantaneous cluster-wide cancellation mechanism.

Account AI settings uses `other_settings.experimental_agent_messaging === true`.
Missing/false hides naming, agent mention suggestions and connection setup.
It does not revoke permissions, cancel work, or disable CLI messaging. Existing
chat content and the My Agents management route must remain accessible. Do not
bulk-enable this preference for existing users.

Pausing or revoking permissions does not retract already accepted work. A timeout
is not rejection. Inspect the original attempt instead of resending. Do not replay
legacy pending or uncertain records. Restrictive management must remain available;
do not remove its UI route during rollout.

## Deployment sequence (requires approval)

1. Finish the outstanding review and ordinary final-candidate smoke tests; pin
   a clean source SHA. Build all deployable artifacts from that SHA and record
   their manifests, hashes, and previous known-good versions.
2. Keep the account UI opt-in default-off. Apply the repository's normal
   declarative schema synchronization on each owning bay.
   Preserve existing rows and keep backups; do not run destructive down-migrations.
3. Install receiving-side services before callers. In particular, the new
   host-history RPC must exist on host-owning bays before account-home callers
   use it. Old receivers may reject new requests; no compatibility fallback should
   silently drop attachments or choose a different delivery mechanism.
4. Roll out matching project-host/runtime, project/tools and browser artifacts;
   verify observed versions rather than assuming a successful upload is activation.
5. William and Blaec opt in individually. Perform a fresh named-agent
   request/reply with a bounded attachment across hosts/bays, recording attempt
   IDs, acceptance, recipient digest and correlated reply separately.

## Dev rollback evidence and procedure

Test host: `agent-rpc-qa-20260912`, ID
`b96028c9-7d3e-4953-a8c9-52f8a5ce52ca`, owning bay 1.
Canary `20260915T181641Z-02a5d1d82477` was installed and then explicitly rolled
back to `20260915T052328Z-40fdca411123`. Project-host, router, persist and ACP
worker returned to the recorded baseline and were observed running/aligned.

Inspect without repeating either mutation (load matching dev hub environment):

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --profile agent-attachments-qa host deploy history b96028c9-7d3e-4953-a8c9-52f8a5ce52ca --limit 5 --json
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --profile agent-attachments-qa host deploy status b96028c9-7d3e-4953-a8c9-52f8a5ce52ca --json
```

For a future approved rollback, first pause affected account communication or
revoke the relevant connections, inspect in-flight work, then use an explicit
recorded artifact version. Do not blindly select the previous artifact: an earlier
dirty build failed its health check. Keep database state and approvals intact.
Recheck service versions and ordinary messaging before resuming communication.
This procedure is not a claim that the full final-candidate rollback has been
exercised.

## Current prerequisites and next step

Update September 16: the receiver QA host now runs private remediation build
`20260916T061335Z-c855b662e444` across all four managed components. The host agent
promoted it healthy at `2026-09-16T06:16:22.694Z`. The earlier rollback, restart,
and native round-trip paragraphs are historical evidence, not the current artifact
version.

Restart operation `4e95ab3b-0b1c-4bcb-9004-732a58f372b7` then passed a live
running-plus-queued ACP fence probe. Neither pre-restart marker appeared after the
old 180-second deadline; a new post-restart turn completed. The detailed limits of
that probe are in `agent-messaging-release-progress.md`.

Post-activation request `8a74dc85-870a-4dab-b411-3a5605a7332c` and reply
`c07f8d45-b38d-435c-a604-b92c0ef53a2d` were accepted. The reviewer returned the
matching 28-byte attachment digest, and the source acknowledged locally without
a reply loop. Both turns finished. Do not request another native approval merely
because the earlier evidence archive records expired links.

Next: complete independent re-review of the pinned private head, then qualify the
remaining membership-change/recovery-child restart cases, matched fleet, and final
external enrollment/send flow. No production rollout is authorized.

Current status: `agent-messaging-release-progress.md`. Detailed evidence:
`agent-messaging-release-evidence-20260915.md` and
`agent-attachments-login-progress.md`.
