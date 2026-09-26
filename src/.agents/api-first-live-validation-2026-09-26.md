# API-first live validation, 2026-09-26

Initial implementation tested: `8856762c4c7327c2318e019013f23f4e3142bec7`.
The approval retention follow-up below tests
`eab240252f2d2f8a15e3291733e49995115f3fb5`.
Environment: the three-bay local development stack behind lite2b.cocalc.ai.
This is development evidence, not production approval or completion of phases 1-4.

## Build and rollout

- `pnpm dev:hub:build` passed, including the workspace build, project-host and
  project bundles, CLI bundle, and amd64/arm64 tools bundles.
- `pnpm dev:hub:restart` completed for bay-0 (9100), bay-1 (13114), and bay-2
  (13214). The primary bay was already stopped before this rollout.
- `pnpm dev:hosts:upgrade` reported success for all three dev hosts and verified
  managed component alignment. Targets were project-host, project, tools, and
  bootstrap-environment.
- Host upgrade operation IDs: `a64901fa-1c34-463e-9f5e-0bcd298c21ac`,
  `fee82a5d-39c3-401d-a1f6-58574f907268`, and
  `f1364f65-3af9-4612-925c-467d96f25193`.

## Verified live

### Follow-up build and installed CLI probe

Ran `./scripts/dev/upgrade-all.sh` at
`d9d5a6805ce914efffec4784b67630928f8b3056`. The full workspace build, production
frontend, project-host/project bundles, and amd64/arm64 tools bundles passed.
All three dev hubs restarted. The host-upgrade waiter subsequently timed out,
but all three original operations later reached `succeeded`, verified directly
in the authoritative development database. No replacement upgrades were submitted.

The existing operation IDs are:

- My host: `73549159-b317-40cf-9f1b-d57b837fe3db`.
- host-2: `41fd06d9-7c5d-4a07-9e51-f2abfc3f3416`.
- host3: `4fc6e82b-267e-47a5-9eb0-1917b68e3e35`.

My host's bootstrap status reported the project-host bundle
`20260926T221155Z-d9d5a6805ce9`, project bundle `1790460749814`, and tools bundle
`1790460811099` installed and aligned. Deployment status also reported the new
current version for its managed components. Terminal operation timestamps were
22:34:32 UTC for My host (attempt 2), 22:33:47 for host-2 (attempt 2), and
22:34:04 for host3 (attempt 1). These observations do not prove every running
project adopted the new bundles.

At 22:25:43 UTC the primary hub fail-stopped after a billing-authority lease
query timed out. Its endpoint refused connections; the two attached bays stayed
running. `pnpm -s dev:hub:start` recovered the primary without restarting those
bays. The recovered primary failed again at 22:35:11 UTC with the same timeout,
after the upgrade operations had succeeded. A second recovery started only the
stopped primary; the attached bays remained running. The cause of the timeout
remains unresolved; successful upgrades do not establish hub stability.

A six-minute read-only PostgreSQL observer spanning the latest primary recovery
finished without detecting another outage after the hub became reachable. It
sampled two brief lease-row lock waits (20 and 50 ms query ages); the blocking
sessions were waiting on WAL I/O. These samples do not establish the cause of the
2.5-second query timeouts. The observer deduplicates repeated wait signatures,
so its two reports are not a count of every wait or a maximum-latency measure.
No lease timeout, fencing behavior, or billing records were changed.

Before that hub shutdown, an isolated probe ran the installed CLI at
`/opt/cocalc/bin/node /opt/cocalc/bin2/cocalc-cli.js` inside the test project.
Ordinary temporary manual keys were supplied using `--api-key-file`, an unused
profile, `--disable-env-auth-defaults`, and an environment without CoCalc
credentials. Daemon use was disabled. The final probe exited zero and verified:

- Project listing, exact-project directory listing, and file reading.
- Upload/read-back/delete of a temporary file with a full-runtime key.
- Project execution of a harmless marker command.
- File-access denial for a project absent from the key's grant.
- Reading with a file-read-only key that lacked account-wide list permission.
- Read-only upload rejection and backend permission denial for execution.

The fixture used a uniquely named private directory, private credential files,
and synthetic text. It removed its files and deleted both keys. Earlier probe
attempts failed harness assertions while interpreting error output: JSON errors
were on stderr, and write/exec denials used different messages. Those attempts
also cleaned up their resources; they are not additional implementation failures.

This establishes the listed installed-CLI workflows, not the entire ordinary
CLI command matrix, daemon isolation, exact installed bundle revision, managed
turn issuance, directory-root restrictions, or long-lived interactive sessions.
The same isolated probe was subsequently rerun successfully after all three
upgrade operations succeeded and the second primary-hub recovery completed.
Both temporary keys and the fixture directory were cleaned up. This is a
post-upgrade pass for the enumerated commands, not full deployment acceptance.

### Directory-restricted viewer through installed CLI and direct API

At source head `92454b7a242503ff3306d1f9fa91f32a13a67cc2`, the deployed
`d9d5a6805ce9` development stack passed a separate directory-policy probe.
A human-authenticated ordinary key-management request created a disposable
five-minute key with only `file:read` for one exact project and one literal
directory root. A separate temporary full-runtime fixture key prepared synthetic
files in a uniquely named private directory; no existing user files were read.

The installed CLI in the target project ran without ambient CoCalc credentials,
with a private key file, an unused profile, and daemon use disabled. The same
key then exchanged a fresh host token for direct viewer filesystem RPC calls
from the test harness, independently of the CLI command handlers.

Both paths verified:

- A regular file inside the allowed root was readable with the expected content.
- A sibling directory sharing the root's name prefix was denied by viewer policy.
- A `..` path into that sibling and a symlink escaping into it were denied.
- Opening a FIFO was rejected with `regular file required`, without blocking.
- Reading an 8 MiB plus one byte file was rejected with `file exceeds read limit`.

The direct viewer service also rejected `writeFile` as an undefined method.
The complete final harness exited zero and removed both keys and its fixture
directory. Earlier harness attempts stopped on this workspace's older CLI
lacking `--scope-file`, an invalid synthetic profile name, or a mismatched
write-denial assertion; they cleaned up and are not authorization failures.
Key creation therefore used the ordinary management API, not that older CLI's
scope-file option; file-operation tests used the target project's installed CLI.

This is not evidence for overlapping roots, rename races, device/socket nodes,
archive/download/history/search/preview paths, managed-key parity, or persistent
CLI daemon sessions. Those remain separate acceptance cases.

### Established Hub sockets

A disposable, three-minute manual key with `account:read` authenticated directly
against each bay. Each connection received a distinct reply prefix, could
subscribe within its own prefix, and was denied the account-wide inbox.
Connections remained open after a 17-second healthy reauthorization interval.
Deleting the key at account home disconnected all three established sockets:

| Entry port | Milliseconds from delete request start to disconnect |
| ---------- | ---------------------------------------------------: |
| 9100       |                                                27826 |
| 13114      |                                                13375 |
| 13214      |                                                13376 |

All were below the 30-second test deadline. This measurement includes deletion
request processing; it does not establish a 25-second bound from authoritative
commit time or behavior under load. No outage or migration was injected.

The first probe incorrectly used bearer authentication for an ordinary API key;
it failed and cleaned up its key. The successful probe used the API-key cookie,
matching the CLI transport contract.

### Approval across bays

Through both non-home entry ports (13114 and 13214), disposable scoped keys:

- Submitted a separately scoped API-key revocation request.
- Received the same result when retrying the request ID.
- Exposed the pending request to the human account's review API.
- Could not approve their own request.
- Were acted on successfully by the human-authorized decision API.
- Returned the same result for a repeated decision; the target key was deleted.

The fixture cleaned up its remaining keys. This checks backend approval and
routing, not the rendered approval interface or its accessibility.

### Scoped project access

Using an ordinary short-lived key delivered through a private credential file,
the compiled CLI command handlers and SDK passed:

- Project listing and resolution by title.
- Read-only project-host directory listing (19 entries; names were not logged).
- Denial of an out-of-scope project.
- Denial after key deletion.
- Denial when the credential file was removed.
- No fallback to the primary agent credential (the fixture throws on fallback).

The first attempt after only the hub restart timed out fetching the host's
viewer policy. After all host upgrades completed, the same fixture passed.
This is not proof that running project processes or all installed CLI daemons
have reloaded their tools; the fixture uses the compiled CLI modules. The user's
earlier successful fresh-agent-turn test is separate evidence for that workflow.

### Full-runtime filesystem and child expiry

A disposable three-minute manual key granted file read/write and runtime access
to the test project. Its exchanged host token successfully wrote, read, and
deleted a uniquely named temporary file through the ordinary filesystem service.
No existing files were changed or their contents logged.

Continuous directory requests exposed a client availability bug: after the host
disconnected the expired token, publication waited indefinitely for sign-in,
ignoring the supplied request timeout. The first harness exited prematurely;
a corrected harness stayed alive and observed the disconnected request still
pending after four seconds despite a two-second timeout. These were not expiry
passes. All fixture keys from those attempts were subsequently deleted.

The client now applies the publication timeout to sign-in waiting and releases
the pending reply listener when publication fails. With the rebuilt Conat client
against the same live hosts, the final probe observed:

- Temporary file round trip passed.
- 89 directory requests succeeded; the last response preceded child expiry by
  64 ms. Continuous traffic did not retain authority past expiry.
- The next request returned a sign-in timeout after disconnection. A separate
  request on the disconnected client returned its configured two-second timeout
  in 2,001 ms.
- A fresh exchange using the still-valid parent restored directory access.
- Deleting the parent prevented another exchange. The fixture key was removed.

Ten focused client tests and the Conat TypeScript build passed. This fix was
live-tested using compiled workspace client modules, not newly deployed CLI
bundles. It is not a proof of end-to-end timeout budgeting across every request
phase, full CLI parity, automatic token renewal, or terminal/Jupyter/sync stream
revocation. Those remain separate validation requirements.

### Membership loss and restoration

Two disposable projects were created through the ordinary API, without starting
their runtimes. The first stayed on bay-0. The second was rehomed to bay-1 while
the account and its keys remained on bay-0 (rehome operation
`33352ed1-4172-40d5-8c6e-d5a72f08c458` completed successfully).

For each project, the fixture changed only its requesting account's membership
in the owning database, exercising the installed membership-loss trigger. It
called `projects.getProjectCreated` with the scoped key over HTTP through all
three bays after each transition:

| State                                          | Result through every bay |
| ---------------------------------------------- | ------------------------ |
| Original key, original membership              | Allowed                  |
| Membership removed                             | Denied                   |
| Membership restored, original key              | Denied                   |
| Revocation maintenance settled, original key   | Denied                   |
| New human-issued key after maintenance settled | Allowed                  |

Both owning databases settled the pending barrier with a string-valued issuance
cutoff. The bay-1 case exercised the project-owner to account-home watermark
lookup. Membership was restored, all fixture keys were deleted, and both project
hard-delete operations completed successfully. Fixture project IDs were
`96f5a1ae-3a57-4682-9b00-8f33cb378472` and
`874e4d59-0697-4062-8166-7ce5293b6d0b`.

This proves ordinary HTTP project admission and a fresh-key grant after loss;
it does not prove editing an existing key to regrant, managed source-turn
invalidation, or revocation of an established project stream. Membership was
mutated directly on disposable fixtures, so collaborator UI behavior was not
tested. The first harness invocation failed to resolve its `pg` dependency
before creating any resources; it was corrected to resolve from the database
workspace.

### Approval rate and scheduled retention

Built the changed backend with `pnpm exec tsc --build` in `packages/server`,
then restarted all three dev hubs at `eab240252f`. No additional host or tools
upgrade was required for these backend-only changes.

A disposable requester and target key created three approvals through the
ordinary HTTP request path entering bay-1, with authoritative storage on bay-0.
The fixture then seeded 60 recent rejected records belonging to its requester
to exercise the admission boundary without generating review notifications:

- A new request was denied with the creation-rate error.
- A retry of an existing request returned the identical stored review.
- The seeded records were removed before testing retention.

The fixture aged one of its real approvals to 31 days past expiry and another
to one day past expiry, leaving the third unexpired. Without making further
approval requests while polling, it observed the old record removed after
33,041 ms, while the recent and unexpired records remained. Its own records and
keys were removed on exit. No existing user approvals were modified.

This exercises live scheduled cleanup and a seeded account-wide rate boundary,
not sustained-load throughput, multi-worker contention, or concurrent account
rehome during deletion. PGlite tests separately cover the 10,000-record ceiling,
500-record cleanup batch, and non-home cleanup denial.

## Still unverified or incomplete

### Manual-key daemon follow-up (not deployed)

The CLI now permits manual `--api-key-file` file commands to use its daemon.
Each daemon command rereads the provider before looking up a cached context;
unchanged credentials reuse the connection, while rotation or an unreadable
provider invalidates the old cached connection. Delayed setup using an older
credential cannot repopulate that provider's cache after a newer admission.
The provider resolves to a bounded snapshot and cannot inherit profile cookies,
bearers, or hub passwords. It requires a private regular file, rejects symlinks,
and bounds the actual read even if the file grows after inspection.

The CLI TypeScript build and 30 focused tests passed for provider handling,
daemon context reuse/invalidation/races, auth profiles, daemon transport, and
existing managed-key selection. This code has not been deployed or exercised
through the installed CLI daemon. Managed connector credentials still bypass
the daemon until source-project routing can be propagated explicitly; this is
not completion of the persistent-client requirement.

- Managed source-turn invalidation, membership loss during established project
  sessions, and human-approved regrant by editing an existing key.
- Home outage, account migration, migration with active keys/sessions, stale
  directory faults, and clustered RPC-interest withdrawal. The empty-project
  rehome above does not establish those behaviors.
- Full-runtime CLI command parity, long-running sync/Jupyter/terminal sessions,
  cancellation/crash races, and the entire manual/managed acceptance matrix.
- Historical database upgrades beyond this dev stack's successful startup.
- Shared editor theme/mobile/keyboard checks and resource-limit behavior under
  sustained load or concurrent migration.

Existing unrelated billing maintenance logged a missing billing account during
startup. No billing records were changed to address that message.
