# Agent messaging controlled release

Status: in progress, not a production readiness attestation. No production
deployment or production flag changes are authorized by this work.

## Candidate activation and smoke: September 15, 19:18-19:21 UTC

Staged the verified archive under the separate dev URL
`/static/agent-release-qa-e43a2ccb10/software`; full HTTP download matched its
84,448,580 bytes and recorded SHA-256. The default software manifest was not
changed. QA host `b96028c9-7d3e-4953-a8c9-52f8a5ce52ca` initially had all four
managed components running/aligned on `20260915T052328Z-40fdca411123`.

Submitted one explicit project-host upgrade with `--align-runtime-stack` and
the staged base URL. Operation `711e8f1b-1a5d-4b30-b0e4-2708ce865940` succeeded
at `2026-09-15T19:18:29.355Z`. Normal account-home CLI inspection confirmed
project-host, conat-router, conat-persist and acp-worker all running/aligned on
`20260915T191304Z-e43a2ccb10a7`. No operation was retried.

New post-activation correlation `release-smoke-20260915-1919` passed:

- Request attempt `8a74dc85-870a-4dab-b411-3a5605a7332c`: accepted.
- Recipient received a 28-byte attachment with SHA-256
  `9c17d9c14e3bcb77e0e482803ce00c13e8b709d6fb5b3cea0e4486d31da682f3`.
- Reply attempt `c07f8d45-b38d-435c-a604-b92c0ef53a2d`: accepted; source received
  the correlated matching size/digest and acknowledged locally only.
- Both final chat records have `generating=false`; no reply loop observed.

The QA host remains on the candidate for continued testing. The source host,
project/tools artifacts and installed CLI were not upgraded in this step; this
is not a claim of identical fleet versions. No production flags, approvals or
production deployments changed. Independent review remains paused.

## Project-host candidate archive: September 15, 19:13 UTC

Clean source `e43a2ccb10a7cea2012cbdddc296cc8aad85bb41` produced build
`20260915T191304Z-e43a2ccb10a7`, package version `0.7.20`, `git_dirty=false`.
Archive: `/tmp/agent-release-host-e43a2ccb10/bundle-linux.tar.xz`.
Size: 84,448,580 bytes. SHA-256:
`8bc816a921d180aaa6f6e79aa61ae921d86001785e3cc871fe9b549c8e701a92`.

The normal project-host bundle script completed its native module/template
checks. `xz -t` and `node --check` for `bundle/index.js` and `main/index.js`
passed. This archive has not been installed or promoted on any host.

Reproduction from `src/packages/project-host/sea`:

```sh
./build-bundle.sh /tmp/agent-release-host-e43a2ccb10/bundle /tmp/agent-release-host-e43a2ccb10/bundle-linux.tar.xz --message 'Controlled release candidate packaging; no production deployment'
```

The included browser assets retain checkpoint `0b3e34f358`; comparing that SHA
to `e43a2ccb10` shows only the progress document changed. These are matching
application sources, not identical commit labels. Packaging is complete for
this dev host candidate, but its installation/activation and final fleet
qualification remain unfinished. Production and review status are unchanged.

## Clean workspace and CLI build: September 15, 19:09 UTC

Built from clean SHA `0b3e34f358601cbf8f0b3826714623fbcb5b1072`.
`pnpm build:dev` from `src` passed, including browser bundling and Python API
documentation; worktree remained clean. Browser manifest has 1,075 assets,
build date `2026-09-15T19:09:34.059Z`, and that source SHA. Its bytes served at
`https://lite1b.cocalc.ai/static/frontend-build.json` exactly match the local file.
Manifest SHA-256: `5f8940deda0e38f763a82c9247950b2f4f7c1559d6c25a9c5e81c5fc2104020d`.
The nonfatal debug-log EACCES warning persists; permissions were not changed.

Packaged CLI separately with `node sea/build-bundle.mjs
/tmp/agent-release-cli-0b3e34f358` from `src/packages/cli`; build and
`node --check /tmp/agent-release-cli-0b3e34f358/index.js` passed.
Bundle SHA-256:

- `index.js`: `58bed477999b240f5ed4e9c40daf1eba155038dc49e69d81ed8a5445f07ed142`
- `index.cjs`: `37ba5965b7042f78b128eaed205ad076153e32468efb2796ddf706feb25e4e06`
- `licenses.txt`: `48008afd381117bcf616334d10636e545f79e3a758f538fbc1e3ec9d0d44f642`

These are dev-build/package checks, not production-mode build qualification or
deployment of the CLI/host/runtime fleet. No hosts were upgraded or services
restarted in this step. Rebuilding static removed the earlier isolated canary
staging directory; the original archive in `/tmp` remains the rebuild source
if that canary must be staged again. Existing browser sessions need a reload
to use the new bundle. Final matched fleet and review remain unfinished.

## Latest live verification: September 15, 19:04-19:06 UTC

The maintainer approved both directions for `messaging-qa` and `reviewer`.
Read-only account-home inspection confirmed both active until
`2026-10-15T18:57:47.033Z`; no agent renewed or changed permissions.

One ordinary source turn performed the post-rollback cross-host/cross-bay smoke:

- Source: project `1ce4fe78-19c7-40a8-a598-947975744cd9`, agent
  `1ec8ed25-623a-4ce2-9d44-d608155196ef`, on the bay-0 source host.
- Recipient: project `66db94af-0745-4088-b922-879c58942201`, agent
  `a2a945d0-711d-460f-b208-aba824ef1e7b`, on the bay-1 QA host.
- Correlation: `release-smoke-20260915-1905`.
- Request attempt `c53db913-1c80-47ca-b207-2803047f9ff7`: accepted. Recipient
  chat has the attributed message and destination-local attachment manifest.
- Attachment: 28 bytes, SHA-256
  `7db394239f6605330dd51cba327418d1d33bde5d0ef416b928fe8425f1cb3bfc`.
  Recipient reported the same digest and size through the explicit reverse link.
- Reply attempt `f4baa78e-6359-402e-9105-eec7d1330ab2`: accepted; source chat
  contains the correlated reply and a local-only acknowledgment.
- Both agents' final chat records have `generating=false`. No retry or reply
  loop was observed. Live chat state was read via the normal project-host session,
  not filesystem chat JSON. Local QA adapter: `/tmp/agent-release-connections-read.cjs`.

The expired-approval prerequisite below is resolved. This qualifies an ordinary
post-rollback round trip on the current dev deployment, not a new cold-start,
maximum-size, external-enrollment, or final matched-fleet test. Review stays
paused; no production changes or UI polish were performed.

## Earlier prerequisite checkpoint (resolved for native smoke)

At clean checkpoint `2dc3a2dd17`, rechecked the live account-home connection
directory: the required QA pair remains expired/revoked. This prerequisite has
persisted across the recent preparation turns. Independent review also remains
paused by maintainer instruction. Autonomous release preparation is now blocked,
not complete; do not repeat unrelated tests or renew permissions silently.

Resume the ordinary smoke after explicit finite bidirectional approval for
`messaging-qa` and `reviewer` through the first-party UI. Independent review and
its resulting final source checkpoint must precede final release qualification.
Matching final artifacts/fleet verification and external enrollment smoke remain
unfinished, not passed. No production deployment or flag changes have occurred.

## Current work direction: September 15

### Real PostgreSQL schema fixture qualification

The three agent schema suites now support an opt-in disposable PostgreSQL
backend via `COCALC_AGENT_SCHEMA_PG_SOCKET`; PGlite remains the default.
Each PostgreSQL test creates and drops its own random database. The adapter
uses a local Unix socket on port 55439 and does not select application databases.

All 14 fixtures passed on PostgreSQL 18.4, including the PostgreSQL-specific
concurrent index DDL, repeated schema convergence and preserved legacy records.
Database build passed. The temporary cluster reported zero remaining fixture
databases and was stopped. The operator handoff contains reproduction commands.
No permissions, production flags, or dev-site database rows changed.

This is real PostgreSQL fixture evidence, not a full production snapshot/load
qualification or a final messaging smoke. Existing QA links still need explicit
renewal for that smoke; independent review remains paused.

### Expanded schema persistence coverage

Added external identity/installation schema fixtures and RPC-link/project-fence
coverage. Repeated sync preserves expired/revoked records, destination JSON,
object IDs and legacy rows. External index/default drift repair preserves saved
installation data. All three schema suites pass 14 tests; database build passes.
No application behavior, live database, approvals, or deployment changed.

```sh
# src/packages/database
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand postgres/schema/agent-external.test.ts postgres/schema/agent-messaging.test.ts postgres/schema/agent-personal.test.ts
pnpm tsc --build
```

This closes the missing embedded schema coverage noted below, not live PostgreSQL
migration qualification. Fresh QA permission and independent review remain
separate outstanding prerequisites.

### Operator handoff and schema checks

Added `agent-messaging-operator-handoff.md`: checkpoint/base, gate names,
default-off UI semantics, deployment order, qualified rollback evidence, and
explicit remaining checks. It does not declare the candidate ready or publish
private review material.

Read-only account-home API inspection confirmed the dedicated cross-bay QA links
are expired/revoked. The only active connection was `x -> local-helper`; this
cannot establish the required receiver-host request/reply workflow. No grant
renewal or agent execution was performed. A fresh explicit finite bidirectional
approval for `messaging-qa` and `reviewer` is the live smoke prerequisite.

Reran schema convergence fixtures. Initial execution lacked PGlite's required
VM-module flag. With it, two tests exposed a fixture configuration error:
the suites constructed PGlite without selecting `COCALC_DB=pglite`, causing
unsupported concurrent index DDL. Matched the existing index-convergence test
setup and restored the original environment after each test. No production
DDL or migration logic changed. All 11 tests now pass, as does database build.
These tests cover embedded schema convergence/preservation, not live PostgreSQL
migration under production load or all external-login tables.

Reproduce from `src/packages/database`:

```sh
NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand postgres/schema/agent-messaging.test.ts postgres/schema/agent-personal.test.ts
pnpm tsc --build
```

### Latest checkpoint: host-history routing

Application commit `57086e3d96` fixes host-scoped operation history: account-home
requests resolve the host owner and read that bay's operation log using the
existing destination access checks. Owner errors propagate rather than returning
stale local history. No messaging semantics, permissions, or UI changes.

Verification: server `pnpm tsc --build` passed; server
`pnpm exec jest --runInBand conat/api/lro.test.ts` passed 9 tests; Conat
`pnpm exec jest --runInBand inter-bay/api.test.ts` passed 8 tests.
Restarted only the three local dev hubs with the rebuilt source. The normal
account-home CLI against lite1b now returns both recorded operations as succeeded:
upgrade `331f0fa3-204c-4f2f-a9d1-2929cf4fb3af` and rollback
`090e5317-9387-4d92-8b4a-72d4242fe40d`. Neither operation was resubmitted.

Reproduce after loading the matching `dev:hub:env`:

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --profile agent-attachments-qa host deploy history b96028c9-7d3e-4953-a8c9-52f8a5ce52ca --limit 5 --json
```

Deployment order: update receiving/owning bays before callers; an older owner
does not implement the new read RPC and callers will error instead of falling
back to a stale replica. No schema migration is required. Rolling callers back
restores the previous local-history limitation; it does not replay operations.
Dev project-host artifacts remain at the previously restored baseline. No
production deployment or site flags changed.

Remaining limitations: generic `op get <UUID>` still lacks owner routing;
host-scoped history is the verified inspection path. Post-rollback messaging
still needs a new ordinary request/reply smoke test with valid approvals.
Independent review remains paused and outstanding. The next concrete step is
that messaging smoke test and final artifact/release handoff, not more UI polish.

At the maintainer's request, pause security-review/adversarial work and continue
non-security production preparation. Independent security review remains an
outstanding release gate, not a pass or a requirement removed from readiness.
Earlier sections below are chronological checkpoints, not the current status
of every requirement. Do not publish private review material with this document.

Public source checkpoint `40fdca411123e1b8e26a1faa1ae4d889d29b18bb` was clean
before this verification. Seven focused frontend suites pass 58 tests covering
the default-off preference, agent mentions, installation management, source
naming, chat controls and ordinary collaborator mentions. Frontend typecheck
and `pnpm -C src lint:frontend` pass (zero warnings/errors). These are local
component tests, not new live browser verification or an exact-fleet deployment.

Reproduce from `src/packages/frontend`:

```sh
pnpm exec jest --runInBand agents/ui-preference.test.ts account/agent-messaging-preference.test.tsx agents/agent-mentions.test.tsx agents/__tests__/external-installations.test.tsx agents/source-agent-name.test.tsx chat/__tests__/agent-communication.test.tsx editors/markdown-input/mentionable-users.test.tsx
pnpm tsc --build
```

`pnpm -C src build:dev` completed with exit 0, including Python API documentation.
This uses the workspace's incremental build logic, not a clean rebuild of every
artifact or a matching-fleet deployment. Only this progress document changed
during verification; application source remains at the checkpoint above.
No production deployment or flag changes are authorized.
Remaining non-security release work includes full build completion, matching
artifact provenance, live UI smoke testing, and qualified deployment/rollback.

### Browser build and serving verification

Explicit `pnpm run build:dev` in `src/packages/static` passed from clean commit
`a218dc7302ebc27f5dbc1654e1aa2273db13ff2c`; Rspack completed successfully.
Build date: `2026-09-15T18:00:54.170Z`. The build emitted a non-fatal debug-log
permission warning; no permission changes were made.

Both `http://localhost:9100/static/frontend-build.json` and
`https://lite1b.cocalc.ai/static/frontend-build.json` exactly match the local
manifest, including its 1,075 assets. Three emitted chunks referencing My Agents,
the messaging preference, and connection approval were fetched from the public
dev URL and compared by SHA-256 with local files; all matched. This establishes
that the dev server serves the rebuilt UI, not that an existing browser tab has
loaded it or that backend/host versions are aligned. No production changes or
service restarts were performed.

The previous CLI login handle is missing, no matching login process remains,
and the primary profile's fresh `auth status --check` reports interactive sign-in
required. Started one new first-party login request and gave its approval URL
to the maintainer. Authenticated UI smoke testing waits for that approval.
Security review remains paused as requested. The next non-security step is to
verify the opt-in and management UI in a browser using the matching bundle.

### Authenticated UI smoke: September 15, 18:04-18:08 UTC

The pending first-party login completed for the intended primary account at its
home bay. No further login request was needed. Built the browser bundle again
from clean checkpoint `312b1f2ffb8b46d21f9ea1d9fdb3a982505aa80c`
and reloaded the existing My Agents settings page. The stale-build
warning disappeared. Reload/navigation creates new browser session IDs; resolve
the active session after navigation instead of retrying commands against old IDs.

Using the actual rendered AI-settings switch, verified its initial value was off,
enabled it and waited for the save to settle, then restored off and waited for
that save to settle. No save error appeared. Reopened My Agents through its
visible management link, which loaded a new browser session. Confirmed:

- Experimental setup is hidden after the new page load.
- All seven existing named agents still have Open controls.
- Pause all and revoke all controls are present and enabled.
- External Agent Installations remains visible.
- No stale-build warning is present for the tested bundle.

No grants, installation credentials, pause/revoke actions or sends were changed.
The temporary UI preference change was restored to its original off value.
This is live browser persistence/navigation evidence, not a new end-to-end
message test or proof of all mention-picker states. Navigation between the two
settings links performs full page loads; recorded as a nonblocking usability
limitation rather than changed during this release check.

Reproduction: approve first-party CLI login at account home, list the active
browser session, open My Agents while opted out, follow AI settings, toggle
the labeled switch on and back off, then follow the My Agents management link.
Use explicit project/browser targets and re-list after each full navigation.
Next: operational deployment/rollback qualification. Independent review remains
paused and outstanding; no production rollout is authorized.

### Isolated operational canary artifact: September 15, 18:16 UTC

First-party `host deploy status` for QA receiver host
`b96028c9-7d3e-4953-a8c9-52f8a5ce52ca` reports project-host, router, persist and
ACP worker all running/aligned at `20260915T052328Z-40fdca411123`.
`host deploy rollback <host> --artifact project-host --last-known-good --dry-run`
resolves that same current version. This is a read-only target-resolution check,
not a rollback rehearsal. Do not use the unqualified default previous version.

Built an isolated new bundle without changing the served host archive:

```sh
cd src/packages/project-host/sea
./build-bundle.sh /tmp/agent-release-canary-02a5d1d824/bundle /tmp/agent-release-canary-02a5d1d824/bundle-linux.tar.xz --message 'Dev-only controlled rollout and rollback qualification; public checkpoint 02a5d1d824'
```

- Source: `02a5d1d82477b80a5b7aed321506b54cf529343b`, clean throughout build.
- Build ID: `20260915T181641Z-02a5d1d82477`; identity records `git_dirty:false`.
- Archive size: 84,510,564 bytes.
- SHA-256: `ef967276c0324b8b9924c63ab5a6985bf35d4553cda9ebdbb32ee50b8f7fbe40`.
- Build validates the tar archive, native-module presence and runner templates.
- `node --check` passes for both `bundle/index.js` and `main/index.js`.

Application package sources are unchanged from the current public host
checkpoint `40fdca411123`; later public commits are documentation only. This
canary will qualify deployment mechanics, not a functional-code migration or
the separate paused review work. It is neither published nor installed. No host,
project, flag, approval or desired deployment state was mutated in this step.

Next: preserve the existing known-good archive, stage this version via the dev
software endpoint without changing production defaults, arrange a bounded
receiver-host maintenance window, deploy once, observe the operation to terminal
state, and explicitly roll back to the known-good version. Verify all four
components afterward; do not equate an operation acknowledgment with convergence.

### Dev-only canary staging: September 15, 18:24 UTC

First-party `auth elevate --dev` succeeded for the existing interactive dev
session. No production account/session was used. The normal local software
endpoint supports one current artifact, so it was not replaced to stage this
test. Instead, copied the public-source canary archive plus its checksum and
manifest into this ignored static output prefix:

`src/packages/static/dist/agent-release-qa-02a5d1d824/software`

Explicit canary base URL:
`https://lite1b.cocalc.ai/static/agent-release-qa-02a5d1d824/software`

A streamed HTTP download of all 84,510,564 bytes matched the recorded SHA-256.
The first-party CLI recognizes the staged version as available:

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --profile agent-attachments-qa host versions --artifact project-host --base-url https://lite1b.cocalc.ai/static/agent-release-qa-02a5d1d824/software --json
```

The normal `/software/project-host/latest-linux.json` still resolves
`20260915T052328Z-40fdca411123`. No host base URL, desired deployment, runtime
version, global default or production flag changed. The static staging prefix
is temporary and a frontend rebuild deletes it; preserve the source archive in
`/tmp/agent-release-canary-02a5d1d824` and revalidate availability immediately
before use. Do not install this temporary base URL as a persistent host default.
The disruptive canary installation and explicit rollback are still outstanding.

### Successful receiver-host canary and rollback: September 15, 18:27-18:30 UTC

Submitted exactly one canary upgrade to QA receiver host
`b96028c9-7d3e-4953-a8c9-52f8a5ce52ca`, using the explicit staged version and
`--align-runtime-stack`. Operation `331f0fa3-204c-4f2f-a9d1-2929cf4fb3af`
ran 18:27:11-18:27:50 UTC and succeeded. All four components reported running
and aligned on `20260915T181641Z-02a5d1d82477`; the host-agent reported healthy,
promoted, accepted at 18:27:42 UTC.

Submitted exactly one explicit rollback with
`host deploy rollback <host> --artifact project-host --to-version 20260915T052328Z-40fdca411123`.
Operation `090e5317-9387-4d92-8b4a-72d4242fe40d` ran 18:28:41-18:29:43 UTC and
succeeded. An intermediate observation showed component drift; waited rather
than resubmitting or changing the running operation. Final observation shows
project-host, conat-router, conat-persist and acp-worker all running/aligned on
the original baseline. Host-agent reports healthy/promoted with acceptance at
18:29:27 UTC and last-known-good restored to the baseline.

Observation limitation: account-home `op get` could not find the owning-bay
operation, and `host deploy history` returned old history rather than this run.
Used read-only queries of the owning bay's `long_running_operations` table for
terminal status and timestamps, plus first-party host deployment status for
actual runtime convergence. No database state was edited and no credentials
were copied between bays. Cross-bay operation observation is an unresolved
operator usability defect, not an excuse to retry an uncertain operation.

This qualifies installation and explicit rollback mechanics for these two clean
public builds on the dev receiver host. Application source is unchanged between
them; it does not establish compatibility with arbitrary older code or schemas,
nor repeat end-to-end message delivery after rollback. No production deployment,
production flags, schema rollback, grant changes, or legacy replay occurred.
The temporary staged artifact remains available, with its original archive in
`/tmp`; no persistent host software base URL was configured by this rehearsal.

Next non-security work: resolve cross-bay operator observation, verify a normal
message workflow on the restored runtime, and consolidate the release handoff.
Independent review remains paused/outstanding, not self-certified complete.

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

- Site-off restrictive management is now implemented for personal connections
  and external installations. Reads/pause/revoke/denial remain available while
  new approvals and resume remain gated. Account-home and security checks remain
  in place. This change has not yet been deployed or verified live.
- Trace the master, RPC, personal, attachment and external-login gates through
  every entry point, including already-connected clients and in-flight work.
- Document configuration reload/restart requirements and exact admission cutoff;
  do not promise cancellation of work already accepted.
- Verify migration, mixed-version rejection, deployment ordering and rollback
  without modifying legacy pending/uncertain records.

Management checkpoint checks: server and HTTP API typechecks passed; frontend
typecheck/lint passed; 24 deterministic policy/control tests and 31 frontend
tests passed. Three PGlite integration suites / 66 tests passed, including
master/personal switches off and simulated source-to-home revocation routing.
These are not real multi-bay account boundary tests. The first PGlite invocation
failed because it omitted the required Node VM-module flag; the corrected
reproduction from `src/packages/server` is:

```sh
NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm exec jest agents/personal-store.integration.test.ts agents/external-store.integration.test.ts agents/rpc.integration.test.ts --runInBand --forceExit
pnpm exec jest agents/management.test.ts agents/personal-management.test.ts --runInBand --forceExit
```

## Security review work still required

- Initial entry-point/capability/ownership map: `agent-messaging-security-map.md`.
  Complete the source review and verify the invariants in that map.
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
Next concrete step: build/deploy these checkpoints on the dev deployment and
verify opt-out and site-off management through real authenticated accounts,
then continue the complete security and resource-bound review matrix.

## Dev verification checkpoint: 2026-09-15

Clean source build `f9ba2aad6d85d6d1bf6fbc5303a96378900d1b06` passed
`pnpm -C src build:dev`. The frontend and all three dev hubs were rebuilt/restarted
from this worktree. This is not yet an exact all-host release deployment: project
hosts/tools retain the versions recorded in the attachment/login progress file.
Build log: `/tmp/agent-messaging-release-build.log`.

Fresh browser tab at `/settings/ai`: switch was off without changing the account
preference; keyboard focus reached it; management link remained available. Scoped
axe audit: zero violations, 13 passing rules. My Agents displayed existing names,
connections and revoked installation history with setup controls hidden. External
installation audit: zero violations, five passing rules. No user preference was
toggled and no active user grant/credential was revoked by these checks.

Real cookie-backed accounts P (`27b3d681-3468-44cc-b025-305cbdba4453`) and Q
(`1fe45c93-6f59-4282-a208-598222e2bf22`) were authenticated independently at their
existing home origins, with ambient credentials disabled. P saw seven names / 26
connections; Q saw two / one. Q's attempt to override the payload account ID still
returned only Q's directory. A foreign account subject was denied by publish
authorization (wrapped by the client as code 408). Both native source and remote
receiver identity reads required collaborator access and denied Q. These are
human read-boundary tests, not scoped-agent execution or revocation-race tests.
Evidence: `/tmp/agent-messaging-release-accounts.jsonl` (classified errors only).

All five messaging flags were temporarily disabled on the three dev hubs using
an ignored config overlay. Both accounts could still inspect the same records
with `enabled:false`. External installation list and revoke APIs also succeeded
with `enabled:false`; the revoke target was only the already-revoked disposable
QA installation, not an active credential. Active-to-revoked behavior while
site-disabled still needs a separate live fixture. The test script restores the
original config on exit. Restoration completed successfully: all three hubs
restarted and both accounts again reported `enabled:true` with unchanged counts
(`/tmp/agent-messaging-release-restored-accounts.jsonl`). Direct process-env
inspection was denied by `/proc` permissions; no permission workaround was used.
Evidence: `/tmp/agent-messaging-release-disabled-accounts.jsonl`,
`/tmp/agent-messaging-release-disabled-installations.json`,
`/tmp/agent-messaging-release-disabled-revoke.json`, and the restart/restore logs.

Additional focused regression checks: 59 server socket-auth/external tests and
20 Conat receive-budget/receive-limit/inbound-admission tests passed.

Isolated fragment-assembly memory measurement (not network transport): two
subscriptions retained four 32 MiB incomplete messages each, while 200 additional
1 MiB incomplete messages per subscription were rejected. Peak process RSS was
450020 KiB (about 439 MiB), versus 91 MiB baseline and 93 MiB after closure. An
oversized continuation was dropped and a healthy message was accepted afterward.
Evidence: `/tmp/agent-messaging-receive-stress.jsonl`; disposable reproduction:
`/opt/cocalc/bin/node --expose-gc src/.local/receive-stress.cjs`.
This does NOT establish a total hub memory bound: network buffers, decoding,
completed-message queues, services and concurrent users remain to be measured.

Next: align host/tools artifacts to a clean SHA, then run scoped native/external
credential adversarial tests and active revocation/expiry races. The live UI and
management checkpoint above does not replace that remaining release gate.
