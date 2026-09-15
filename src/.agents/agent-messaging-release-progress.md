# Agent messaging controlled release

Status: in progress, not a production readiness attestation. No production
deployment or production flag changes are authorized by this work.

## Current work direction: September 15

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
