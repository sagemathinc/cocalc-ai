# Agent messaging: controlled rollout handoff

Status: release preparation, not permission to deploy to production. Independent
review is paused at maintainer request and remains outstanding. This document
contains operational evidence only; private review material stays private.

## Candidate and evidence

- Current application checkpoint: `57086e3d96` (host-history routing fix).
- Clean documentation checkpoint: `fa42c1dafa7b702ce8c362b6280e6efb949fedaf`.
- Comparison base: `9b06a09f93fb5e9ada9b49555390ebfc1b97dbe7`.
- Worktree: `/home/user/scratch/agent-mentions`, branch `feature/agent-mentions`.
- These are preparation checkpoints, not a final independently reviewed SHA.

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

These are process environment flags, not the account UI preference. Only the
literal value `1` enables each flag; leave unset for a new, disabled deployment.
Changing service environment requires a controlled service reload/restart.

| Flag                                         | Purpose                                   |
| -------------------------------------------- | ----------------------------------------- |
| `COCALC_AGENT_MESSAGING_ENABLED`             | Master messaging service/identity gate    |
| `COCALC_AGENT_MESSAGING_RPC_ENABLED`         | Single-attempt RPC path                   |
| `COCALC_AGENT_PERSONAL_MESSAGING_ENABLED`    | Human-scoped names/connections            |
| `COCALC_AGENT_MESSAGING_ATTACHMENTS_ENABLED` | Binary attachment path and receive limits |
| `COCALC_AGENT_EXTERNAL_LOGIN_ENABLED`        | External sender enrollment/service        |

Apply intended controls consistently to account-home and project-owning bays;
the project-host identity lease also uses the master flag. Do not treat changing
one bay as an instantaneous cluster-wide kill switch. Subscription setup reads
some flags at startup. Record the effective process configuration after reload.

Account AI settings uses `other_settings.experimental_agent_messaging === true`.
Missing/false hides naming, agent mention suggestions and connection setup.
It does not revoke permissions, cancel work, or disable CLI messaging. Existing
chat content and the My Agents management route must remain accessible. Do not
bulk-enable this preference for existing users.

Disabling admissions does not retract already accepted work. A timeout is not
rejection. Inspect the original attempt instead of resending. Do not replay legacy
pending or uncertain records. Pausing/revoking permissions is distinct from
stopping an already running agent turn. Restrictive management must remain
available; do not remove its UI route during rollout.

## Deployment sequence (requires approval)

1. Finish the outstanding review and ordinary final-candidate smoke tests; pin
   a clean source SHA. Build all deployable artifacts from that SHA and record
   their manifests, hashes, and previous known-good versions.
2. Keep messaging site flags unset/off and account UI opt-in default-off. Apply
   the repository's normal declarative schema synchronization on each owning bay.
   Preserve existing rows and keep backups; do not run destructive down-migrations.
3. Install receiving-side services before callers. In particular, the new
   host-history RPC must exist on host-owning bays before account-home callers
   use it. Old receivers may reject new requests; no compatibility fallback should
   silently drop attachments or choose a different delivery mechanism.
4. Roll out matching project-host/runtime, project/tools and browser artifacts;
   verify observed versions rather than assuming a successful upload is activation.
5. Only after explicit approval, enable the desired site gates for a limited
   rollout. William and Blaec opt in individually. Perform a fresh named-agent
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

For a future approved rollback, first disable new admissions consistently, inspect
in-flight work, then use an explicit recorded artifact version. Do not blindly
select the previous artifact: an earlier dirty build failed its health check.
Keep database state and approvals intact. Recheck service versions and ordinary
messaging before reopening gates. This procedure is not a claim that the full
final-candidate rollback has been exercised.

## Current prerequisites and next step

Update September 15, 19:06 UTC: the maintainer renewed the QA pair in both
directions, and the post-rollback native cross-bay round trip passed. Request
`c53db913-1c80-47ca-b207-2803047f9ff7` and reply
`f4baa78e-6359-402e-9105-eec7d1330ab2` were accepted. The reviewer returned the
same 28-byte attachment digest, and the source acknowledged locally without a
reply loop. Both turns finished. See the progress document for exact evidence.
The historical expired-link checkpoint below no longer blocks native smoke.
Final matched-artifact qualification, external enrollment smoke and independent
review remain separate unfinished work.

Read-only account-home inspection on September 15 found all dedicated
`messaging-qa`/`reviewer` and `builder`/`reviewer` QA connections expired or revoked.
Only `x -> local-helper` remained active, which is not the required receiver-host
request/reply pair. No permissions were renewed and no work was started.

The next live test needs a new explicit, finite, bidirectional QA approval in the
normal first-party UI for `messaging-qa` and `reviewer`. Then start one source turn
that sends once with a unique correlation ID and a small attachment, asks for one
reply, and forbids retries/reply loops. Record both attempts and verify the file
digest at the recipient. Do not substitute the unrelated active connection.

Detailed chronological evidence: `agent-messaging-release-progress.md` and
`agent-attachments-login-progress.md`. Neither replaces final-candidate testing.
