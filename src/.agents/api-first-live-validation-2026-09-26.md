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

### Manual-key daemon follow-up

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
existing managed-key selection.

Built the amd64 and arm64 tools bundles at
`1b781bcb0ea4b9457a10372b64527d1222e27c04`. A tools-only upgrade of My host
succeeded as operation `a649e626-f82b-4157-9341-e6183f5f1722`, without restarting
the hub or managed host components. The previously running test project retained
its old tools mount. Instead of disturbing its sessions, the fixture created
project `e0dfed24-012c-45b4-a239-454f5b2c2926` on the upgraded host. Its installed
`/opt/cocalc/bin2/cocalc-cli.js` matched the rebuilt bundle SHA-256 exactly:
`3e7ed422ba08d7af62eef784b3dde6866b8797bd2a7d125f2d9964dc4a44c00b`.

With no ambient credentials and a dedicated private daemon runtime directory,
the installed CLI passed file reads, writes, upload/read-back/delete, absent
project denial, and viewer write/exec denial. The daemon was initially absent,
started on the first file command, and retained the same PID throughout. Atomic
replacement of the full-runtime key file by a viewer key allowed reads but
denied writes. Removing that provider then denied reads with `API key file is
unavailable`, while the daemon remained running.

A separate run repeatedly read a synthetic file through the daemon. After its
first successful read signaled readiness, the human management API deleted the
key. An explicit authentication denial arrived 14,596 ms after the delete request
started, with the same daemon PID still running. This is a wall-clock development
measurement including request processing, not a commit-time bound under load.
The harness does not count transport timeouts as authorization denials.

All probe keys and files were removed and each isolated daemon was stopped.
Disposable-project hard deletion succeeded as operation
`f4293140-1af3-4580-b0ef-cea581390d2b`.
An initial daemon run failed with the long nested runtime path; a short private
`/tmp` runtime directory succeeded. Earlier revocation runs rejected the API's
actual denial wording in a harness assertion; the corrected final run passed.
These tests exercise sequential file commands through a persistent daemon, not
terminal, Jupyter, sync, preview, or proxy streams. In that deployed build,
managed connector credentials still bypass the daemon.

## Still unverified or incomplete

The subsequent credential-provider follow-up was initially undeployed: manual and
managed keys now share the same bounded, no-follow, nonblocking file reader.
The CLI build and 32 focused tests passed, including managed FIFO rejection in
a timeout-protected subprocess and a simulated post-stat file-growth test that
verifies no more than 4,097 bytes are read before rejecting an oversized key.
That reader change alone does not prove a managed turn end to end.

A further follow-up enables managed file-daemon routing by
forwarding the requesting CLI's source-project identity and provider path.
Daemon admission rereads the provider, ignoring any supplied key snapshot;
rotation or removal invalidates the old cached context. An unavailable provider
denies connector operations while preserving independent source-project access.
Requests carry resolved authentication and cannot inherit the daemon's startup
environment or saved profile. The CLI build and 45 focused tests passed,
covering auth isolation, provider snapshots, rotation/removal, source routing,
and daemon context invalidation. This still needs live validation with an actual
turn-issued managed credential; the manual-key evidence above is not a
substitute.

## Managed daemon tools deployment

Built both tools bundles from `a831c858f53699266e1f06380c2cde7a31711870`.
The CLI bundle SHA-256 is
`b8ec3306870ee086484f82a67bf4e424ce6f554662885c2688f2c283d6f978ee`.
The amd64 tools archive SHA-256 is
`80202a60b09f7d530438f247909c8263436a98477c5f0eaa08bb53af3876bbc9`;
the arm64 archive SHA-256 is
`602a178365519cc6b42442d66acce3aabc8b0ced78b48fc1417a06b41da9c9bf`.
Tools-only upgrade of My host succeeded as operation
`c3f44b34-8cf6-4336-9588-0806618a52ff`. Existing project tools mounts have not
been verified against this bundle. This is deployment evidence, not a managed
turn acceptance result.

Before the upgrade, the primary hub was confirmed stopped (connection refused,
missing prior process, and dev status reporting stopped). Its log recorded a
billing-authority lease query timeout at `2026-09-26T23:18:47.942Z`, generation
76. The standard dev start command recovered it as PID 1067362; attached bays
remained running as PIDs 956795 and 960838. HTTP then returned 200 and the upgrade
completed. No fencing or lease timeout setting was changed. This recurring
environment failure is unresolved and must not be counted as connector
revocation evidence.

## Remaining validation

### Managed daemon probe admission

Disposable source project `504cd6a5-c830-44d3-bc2f-91380266d590` ran the exact
CLI hash recorded above. Registered agent
`3d91d5a4-444a-4927-927a-66e4ced0a459`, thread
`028bc1e9-556f-4c08-ab1b-ba78ab565083`, had connector configuration
`ba5ea529-57bd-4e9a-ac60-f7405c00804d` with project listing and a read-only target
grant rooted at `.`. The initial missing-root draft was correctly rejected;
the corrected configuration saved as revision 1.

The attempted turn send was rejected before admission with
`Scoped agent sends require --rpc and --to-agent; legacy delivery is retired`.
Registered runtime destination discovery did not include this disposable agent.
No account-credential fallback or alternative delivery bypass was attempted.
Consequently this probe provides no managed-turn or daemon-runtime result.
Configuration revision 2 disabled the connector, the registered identity was
disabled, and hard project deletion succeeded as operation
`a240e6c5-b824-4645-9371-9b4e9e34e210`.

### Full-runtime terminal failure

An ordinary manual key with `file:read`, `file:write`, and `project:exec` for
`6ef7fc05-39fe-479b-989c-b2c8ceb0a766` successfully exchanged host access and
created a private probe directory. Its installed CLI, running with isolated
environment/profile and `--api-key-file`, failed `project terminal spawn` with
`disconnected`. The intended shell was bounded by `timeout 60`; the key and
probe files were removed afterward. No terminal write/history assertion ran.

Code inspection identifies a likely incompatibility to fix and retest:
`conat/socket/client.ts` subscribes to `${subject}.client.${id}`, whereas
`conat/auth/project-host-api-key-policy.ts` permits subscriptions only below
the token's private reply prefix. The terminal protocol must support confined
return traffic without granting arbitrary subscriptions to project-wide service
subjects. This is a failed phase-2 full-runtime parity check, not a completed
terminal feature or a revocation result. Reproduce with the current bundle and
explicit transport-denial evidence before attributing the entire runtime failure
to that mismatch.

A subsequent direct probe using the current locally built Conat library
confirmed the transport mismatch against the live host. With a fresh full-runtime
manual key, subscription below the token's own reply prefix succeeded, while a
terminal client-subject subscription and publication to an inbox each failed with
explicit code 403. The actual `terminalClient` handshake completed transport wait
and server discovery, entered `subscribe_start`, then its real terminal
subscription failed with 403 and spawn rejected as disconnected. The key was
deleted in cleanup. No shell was admitted by this handshake. This proves the
failure is not solely the older installed CLI bundle.

The transport requires both a confined return stream and confined responses to
reverse requests. Allowing project-wide subscriptions or arbitrary inbox
publication is not an acceptable workaround. A private design-review request
for a negotiated inbox-return protocol with service-subject reverse-response
correlation was accepted as attempt
`f63974b7-2fd0-4025-a880-6c7931e38990`; acceptance is not a review result.

The first diagnostic attempt never reached key issuance: the primary hub had
again fail-stopped on a billing lease query timeout at
`2026-09-26T23:34:30.535Z` (generation 77). That attempt returned explicit 503
with no account API subscriber. Standard dev start recovered PID 1090219;
attached bays remained running. A post-recovery database snapshot had no active
transactions/blockers, which does not identify the earlier timeout's cause.
The successful diagnostic evidence above came from a new attempt after recovery.

### Confined socket return implementation (not deployed)

The shared Conat socket implementation now negotiates an inbox-return mode via
service discovery. The broker checks the proposed concrete return inbox against
the caller's subscription authority and stamps server-owned route metadata;
services require that attestation and bind the logical socket to that route.
Reverse-request responses use correlation IDs over the existing service subject,
not publication rights to server inboxes. Outstanding reverse requests are capped
at 128 per logical socket and released on timeout or close. The existing API-key
subject policy is unchanged.

Eight new in-process broker integration tests cover forward/reverse requests,
streamed data, continued denial of broad subscriptions/inbox publication,
foreign or wildcard return routes, missing broker attestation, legacy clients,
pending-request limits/timeout/close, and lease-expiry interest withdrawal.
The socket/header set passed 40 tests; the existing authorization regression set
passed 26 tests. Conat and server TypeScript builds passed. Jest required its
existing force-exit workaround; no claim of test-process handle cleanliness is
made. This is local transport evidence, not a live terminal result. Clustered
propagation, rotated-namespace reconnect, application recovery, and independent
review remain required before rollout.

The follow-up transport suite now passes 11 tests. Added coverage places the
scoped caller and socket service on distinct brokers joined with authenticated
cluster links; forward requests, reverse requests, streamed data, and
expiry-driven remote interest withdrawal all pass. Another test reconnects a
logical socket under its unchanged authorized return route without creating a
second service socket. Raw-wire spoofing coverage verifies that client-supplied
caller metadata is discarded, the broker stamps only the authorized return
route, and a foreign route is denied. The first spoofing assertion was adjusted
to accept the wire encoding's null representation of absent metadata; it never
accepted a forged route. These tests do not establish rotated-namespace recovery
or a deployed terminal workflow. Production protocol code is unchanged from
the pinned review candidate.

The project-package terminal integration test now runs the actual terminal
service and client over an isolated broker with the existing project-host
API-key subject policy and a real `node-pty` Bash process. It verifies shell
input/output, retained history, reverse size requests, continued denial of
broad subscriptions and inbox publication, reattachment to the same process,
and explicit terminal destruction. The shell output marker is assembled by
the shell so echoed input alone cannot satisfy the assertion. The test passes,
and the project TypeScript build passes. This is application-level integration
evidence, not deployed CLI, managed-turn, rotated-credential, or outage evidence.
Production protocol code remains unchanged and deployment remains pending.

### Reply namespace reconnect follow-up (not deployed)

A real-broker regression reproduced an ordinary request timeout after reconnect:
the authenticated reply prefix changed, but the shared client retained its first
request/reply inbox. The client now replaces that inbox when the authenticated
prefix changes, closes the old subscription, and prevents superseded asynchronous
initialization from installing an old inbox. An unchanged prefix retains the
existing inbox. The regression passes for both cases, with one active inbox
subscription and continued denial of the old namespace after rotation.

The request/reconnect/socket selection passes 24 tests and the Conat TypeScript
build passes. This changes shared client production code beyond the earlier
pinned socket review candidate. It does not yet solve persistent logical-socket
return-route rotation or establish deployed CLI recovery. In-flight requests
are not automatically replayed; callers must handle their existing timeout/error
semantics without assuming that a timed-out mutation was not executed.

A follow-up confinement test presents an already-established socket with another
inbox that the caller is authorized to subscribe to. Both a connect command and
an ordinary request under that replacement route are ignored; the application
handler is not invoked, the original route and socket remain, original requests
and streamed output still work, and the replacement receives no output. All
12 socket-return tests pass. Merely authorizing a new return inbox must not
implicitly authorize redirecting an existing socket. Persistent-session recovery
across rotation is still unfinished. Private review follow-up
`29c8b706-8ef1-413b-bc31-15695dc3253f` was accepted and saved; that is not a
completed review or approval for deployment.

The real-PTY test now also disconnects the broker transport, receives a different
server-issued reply prefix on sign-in, verifies old-prefix subscription denial,
and explicitly creates a new terminal client attached to the existing session
ID. It verifies the same shell PID, retained history, and fresh shell-generated
output after reattachment. Both stable-prefix and rotated-prefix cases pass;
Conat rebuild and diff checks pass. This establishes that explicit terminal
reattachment can preserve the process without redirecting an old socket. It is
not automatic logical-socket recovery, a Jupyter/sync result, or deployed evidence.

### Daemon context budget (not deployed)

The file-command daemon now admits at most 64 cached plus in-flight contexts,
rejecting excess setup explicitly without evicting established connections.
Provider rotation releases its old slot before replacement. Failed setup clears
unused provider-index entries and releases its reservation; shutdown rejects and
closes delayed setup rather than repopulating the cache. All 23 daemon tests
pass, including pending admission, capacity reuse, rotation at capacity, provider
failure, shutdown races, and prior credential-isolation cases. CLI TypeScript
build and test compilation pass. The CLI README documents the ceiling and
one-shot/daemon-stop alternatives. This local bound does not prove aggregate
server or multibay resource budgets.

### Jupyter application transport (isolated, simulated kernel)

The actual Jupyter client/service now has an isolated-broker integration test
using the existing project-host API-key subject policy. A simulated kernel
runner requests stdin through the service socket, receives the scoped client's
answer, and emits tagged output and completion. The test checks the run ack,
single runner invocation, stdin payload, output ordering/run identity, terminal
iterator completion, and continued denial of broad client subscriptions and
inbox publication. Replay storage is a test double, not a real persistence
service. The initial test failed because its mock targeted a relative import
rather than the package import; fixing that test setup made the test pass.
All 15 selected Jupyter/inbox/socket tests and the Conat build pass. This does
not establish real-kernel execution, notebook persistence, recovery mid-run,
or live CLI/managed-agent behavior.

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
