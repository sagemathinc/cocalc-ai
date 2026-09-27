# API-first live validation, 2026-09-26

Initial implementation tested: `8856762c4c7327c2318e019013f23f4e3142bec7`.
The approval retention follow-up below tests
`eab240252f2d2f8a15e3291733e49995115f3fb5`.
Environment: the three-bay local development stack behind lite2b.cocalc.ai.
This is development evidence, not production approval or completion of phases 1-4.

## Dismissing obsolete approval requests, 2026-09-27

Human rejection no longer requires the requesting and target API keys to remain
at their reviewed revisions or even exist. Dismissal grants no key authority;
account-home ownership, transaction fencing, fresh human authentication, and
the exact stored review remain required. Execution still validates both keys
against current authority before changing anything.

The focused PGlite suites for action authority, storage, and routing pass all
30 tests. New cases cover changed/deleted requester and target keys, blocked
execution, idempotent rejection, unchanged key rows, and no directory tombstone
on rejection. Wrong owner, missing fresh authentication, and modified review
remain rejected. The server TypeScript build passes. These are backend tests;
the stale-request rejection flow has not yet been deployed or exercised in the
rendered UI at that point.

### Deployed browser follow-up

Built the server at `1f627470a46827546fe7cebd3eba08434cb5ef93` and restarted
the local three-bay hub stack through `dev:hub:restart`; all three bays started
successfully. No project-host or project-runtime restart was required. The
real Chromium UI probe, using the existing dev-elevated human session, opened
a disposable revocation request and then renamed its target through the ordinary
key-management API. Approval displayed `target API key changed since review`
and preserved the target. Keyboard rejection then returned to the request list;
authoritative reads confirmed no pending fixture request and the target still
present. The test subsequently deleted its target and requester keys.

The same run repeated the all-projects/manual-key create, edit, reload, and
delete round trip (fixture key 138), plus ordinary keyboard rejection. A separate
fresh API connection confirmed zero remaining `api-ui-roundtrip-` fixture keys.
The probe exited successfully. This verifies deployed stale-target dismissal,
not interactive MFA, stale requester behavior in the browser, or the full managed
turn acceptance matrix; stale requester cases remain covered by backend tests.

## Managed renewal expiry under database contention, 2026-09-27

The opt-in `cocalc-connector-turn.postgres.test.ts` suite now exercises renewal
blocked on either its turn row or key row until that resource expires. Each
fixture shortens only its isolated-schema synthetic resource lifetime, observes
a real PostgreSQL lock waiter, waits past the database expiry, then releases the
lock. Renewal rejects, does not publish directory state, does not allocate a new
key or turn, and leaves the expired resource expired. The suite's random schema
is dropped during cleanup; no live account or key rows are modified.

All six real-PostgreSQL tests pass, including existing concurrent issuance,
per-account burst admission, and both renewal/finalization lock orderings. The
server TypeScript build passes. Trusted worker, live turn, membership, encryption,
and directory transports are doubles in this suite. This establishes actual SQL
expiry/locking behavior, not a genuine ACP crash or the managed CLI matrix.

Agent Network discovery still does not expose the disposable managed-fixture
agent. No account-credential fallback or alternative send was attempted.

## Shared UI round trips and approval decisions, 2026-09-27

Source checkout: `6e86d673c772e15dfa61f3cc228c5c565f663929`. The served frontend
was built at `8dd6f53d8204`; `git diff 8dd6f53d8204 HEAD -- src/packages/frontend`
was empty. Its debug build-warning banner was dismissed through its normal
button after verifying that source boundary. These checks used a disposable
Playwright Chromium context against the actual local hub, not mocked components.

A freshly issued browser sign-in cookie correctly reached the `Confirm security
action` dialog when creating a key; no key was created. Positive CRUD and
approval tests used the existing cookie-backed dev-elevated CLI session in the
isolated browser context. This is not evidence of completing interactive MFA or
password step-up through the rendered dialog. Secrets were not logged, captured
in screenshots, or saved by the browser test.

- Created manual fixture key 134 through API Keys settings with `project:list`,
  one read-only project grant, roots `assignments` and `feedback`, and a one-hour
  expiry. Authoritative API state matched the requested scope and expiry; reload
  and Edit reproduced the values. Narrowing to `feedback` advanced revision to 2,
  survived another reload, and deletion through the UI removed the key.
- Repeated the round trip with key 135 and the all-projects read-only default
  plus that narrower explicit project override. The saved default and override
  matched the canonical API scope and remained selected after reload. This tests
  UI persistence, not access to every project or dynamic membership changes.
- A disposable key scoped only to `api-key:revoke:request` submitted requests
  through the real HTTP API for a second disposable manual key. The rendered
  review displayed the exact target lookup ID and name. Keyboard rejection
  preserved the target; a new request followed by keyboard approval removed it.
  Authoritative key and pending-request reads confirmed those outcomes. No
  unrelated request was selected or decided.
- Cleanup removed the requester key and all remaining fixture keys. A separate
  ordinary CLI listing confirmed zero names beginning `api-ui-roundtrip-`.

Dark-mode checks exercised both the manual-key editor and the existing connector
dialog at 1280px, 320px, and 1280px again. The rendered root reported dark theme;
neither dialog overflowed horizontally, both footers were reachable, and all
four focused axe rules (`color-contrast`, `label`, `aria-valid-attr-value`,
`button-name`) reported zero violations. The manual project draft survived
resizing. Connector keyboard toggle, Escape dismissal, and trigger-focus
restoration passed. Both 320px screenshots were visually inspected. There were
no captured page errors. Appearance was restored to `system` and verified after
reload; no connector settings were saved.

The scratch probes are `/tmp/api-first-ui-roundtrip.cjs` and
`/tmp/api-first-ui-probe.cjs`; screenshots are under `src/.local/api-first-ui/`.
These results narrow the earlier UI gaps below. Native 200% browser zoom,
interactive step-up, stale-review UI races, broader theme/state coverage, and
the full managed-turn matrix remain unverified.

## Write-outcome recovery foundation, 2026-09-27

The existing edit-journal service deduplicates collaborative-history commits,
while ordinary filesystem writes previously had no operation receipt. The conditional
patch helper is not proof that an earlier request executed. Recovery therefore
needs an explicit outcome contract rather than automatic full-write replay.

Added a process-local `MutationReceipts` primitive with server-generated
reservations, server-supplied scope and payload fingerprints, shared in-flight
results, bounded total/per-scope entries, expiry, and completed-result eviction.
Unknown IDs (including restart/expiry/eviction) cannot be recreated by execution.
Running work retains its admission slot until it settles, even after callers
disconnect or TTL elapses. Outcomes are void/error, not retained file contents.
This is at-most-once execution within one surviving receipt store, not durable
exactly-once delivery across crashes.

Ten focused tests cover concurrent/lost-ack retries, scope and payload changes,
failed execution, expiry, restart, eviction, malformed fingerprints, and retained
capacity for hung work. Together with request/inbox/admission coverage, all 24
tests passed; the Conat TypeScript build passed.

The writable filesystem service now exposes reservation, execution, and status
RPCs under its existing direct-host authorization. Scope and payload fingerprints
are server-derived. Limits are 256 retained receipts per service, 32 per authority
and subject, and 120 seconds of retention; active mutations keep their slot until
they settle. Read-only filesystem services expose none of these methods.

The ordinary filesystem client uses receipts for scoped host-key writes. Each
RPC attempt is capped at 10 seconds (or a smaller caller timeout), with at most
three attempts and bounded sign-in waits after connection loss or timeout.
Lost reservation acknowledgments may leave unused expiring slots, not writes.
After reservation, retries always use the same ID. Changed authority, unknown
outcomes, authorization failures, and other application errors stop recovery;
there is no fallback to an unreceipted write. Ordinary non-key filesystem calls
retain their prior behavior. The isolated host deployment and installed live
editing evidence are recorded below; this is not a production deployment.

The Conat router now adds an opaque mutation-authority binding to authenticated
caller metadata for project-host API-key principals. It binds account, key,
scope revision, project, placement revision, capabilities, viewer policy, and
service subjects. A healthy lease's changing reply namespace is excluded.
This is a deduplication identity, not an authorization grant; every future
receipt request must still pass normal service authorization. Receipts remain
local to the process that admitted them, so a host change cannot resurrect an
old receipt.

Focused binding tests cover changed authorization dimensions and healthy reply
rotation. Real broker publications verify that a client's forged caller slot
is replaced for scoped keys and removed for ordinary principals.
All 34 receipt, authority-binding, and broker caller/revocation tests pass;
the Conat TypeScript build passes.

Twelve new real-broker filesystem tests cover receipt reuse from a renewed
connection, successful writes with a simulated lost acknowledgment, lost
reservation replies, unknown outcomes, authority changes, concurrent duplicate
requests, changed payloads, revoked transport access, reservation capacity,
missing authenticated metadata, and retained failed outcomes. Filesystem storage is
mocked in these tests; they do not substitute for installed live probes.
All 18 filesystem suites passed (140 tests before the last three focused cases);
the final receipt suite passes all 12 cases. Conat, CLI, and project-host
TypeScript builds passed during integration.

### Installed receipt-recovery validation

Source: `4d70ab9e1fc8e98392e111a704fe7d9a47de403a`. Rebuilt the main review
checkout's project-host bundle and tools. Host3 upgrade operation
`ae260c9c-2371-4bbf-8b05-714b974d32b5` succeeded with managed runtime alignment:
host build `20260927T080100Z-4d70ab9e1fc8`, tools `1790496014152`.
Only host3 was upgraded. The dedicated validation project was restarted to
refresh its tool mount; its installed CLI SHA-256 matched the local build:
`29d8a8839c2d4bfb739aa94898ce0e28e48c31b38af04d688033dc04490b9af9`.

The first attempt made 71 acknowledged writes over 48,184ms before the primary
dev hub fail-stopped on a billing-authority lease query timeout. The text session
reported authorization failure. This is not a controlled outage test and does
not count as a successful healthy/revocation run. Key 129 was deleted, the test
project restarted, and its fixture directory independently verified removed.
No billing safety checks were weakened.

The replacement manual-key run reached 130 acknowledged synchronized writes
over 112,631ms before key deletion, crossing multiple 25-second host leases.
It acknowledged 133 writes total. The last acknowledgment was 9,450ms after
deletion returned, and the session interrupted at 10,171ms during `save-history`
with authorization failure. Two independent live-document reads, five seconds
apart, both returned `sync-revocation-write-133`; an unacknowledged final edit can
appear in the live document. These are live-document reads, not a claim that
the final unacknowledged edit was saved to disk.

The run's editing/revocation assertions passed, but cleanup restart failed and
the harness exited nonzero. The project was observed in `opened` state; a
separate start operation `8a6f0958-4aca-4b86-90c1-61b43bc6964e` succeeded.
Fixture `.api-probe-171f0cd9-4ca1-4f11-b74f-dff35197fea0` was independently
verified absent afterward.

A faster run (1ms requested delay, target 600 writes) remained healthy through
484 acknowledged writes, but exhausted the harness's 100 trace polls before
the target. Progress at 438 writes measured 156,366ms. It did not reach its
planned explicit-deletion phase, so it is not a passing revocation run. Cleanup
completed and deleted key 131. The scratch harness now uses an explicit
240-second observation deadline instead of a polling-count budget and reports
acknowledgment gaps even when the threshold is missed. A completed high-rate
run and investigation of renewal pauses remain follow-ups.
An independent final directory scan found no `.api-probe-*` fixtures in the
dedicated project. A private receipt review request for this source head was
accepted (attempt `b95d4241-e4de-4084-bb14-c3d02e5bc6c1`); no review disposition
has been received in this validation run.

### Prompt failure of replaced reply inboxes

A real-broker regression reproduced one cause of renewal delay: an admitted
request whose reply namespace was replaced waited for its full timeout and
returned 408, even though the old response channel could no longer deliver.
Both rotating-prefix cases failed the new test before the fix.

Installed CLI validation at source `80b3f7093a704d76e4dd3f53fa65640f2b57cb79`
used tools-only host3 upgrade `ab78e3f1-1feb-4b0a-8b65-38a290eb0b07`, which
succeeded. The project-host runtime remained at `4d70ab9e1fc8`. The installed
CLI SHA-256 matched the rebuilt tools:
`c34db4a03142866273ce51ae7fbc38f69a8e89fbcaaf5266da376efb00f45f7f`.
The local primary hub stopped during upgrade observation and was restarted
after confirming its stopped state; the same operation was observed to completion,
not resubmitted. Project restart failed during Podman removal; a subsequent
explicit start (`713acd99-69b6-49a8-a949-2cf16857c25f`) restored direct commands.

The revised high-rate probe used a 600-second manual key, a 240-second
observation budget, 1ms requested inter-write delay, and a target of 600 writes
before explicit revocation. It acknowledged 484 writes over 104,697ms, with a
maximum acknowledgment gap of 3,043ms. It then failed during `save-disk` with
403 at `1790498304006`ms, immediately after the authenticated host lease expiry
of `1790498304` seconds. The parent key had not expired or been deleted.
Thus this run exposed a lease-expiry admission race, not a successful explicit
revocation test. The earlier 484-write result was a harness-budget exhaustion;
the matching count here is coincidental and the failure is different.

The host policy checks the lease deadline during publication, while the broker
disconnects the expired socket on a timer. A request can encounter the expired
policy before timer teardown and receive a terminal permission error. Existing
receipt recovery intentionally does not retry 403. This remains unresolved at
the tested head; recovery must distinguish expired transport authority without
turning genuine permission denials into generic retries or replaying mutations.
Cleanup deleted fixture key 132. An independent direct project directory scan
returned no `.api-probe-*` directories after cleanup.

The client now tracks request iterators by their reply inbox. Replacing an
inbox, or closing the client, cancels its pending single-response and streamed
requests with `CONNECTION_LOST`. Reconnection that preserves the same inbox
continues to preserve pending responses. There is no automatic transport replay;
the filesystem receipt protocol remains responsible for recovery. Tracking is
released on successful completion, cancellation, and publication failure.

Eight real-broker rotation cases cover stable/rotating namespaces, mutable
credential providers, and both request forms. Rotated requests reject within a
250ms test deadline after sign-in, rather than their three-second timeout;
the service executes each held request only once. Close/failure cleanup tests
verify that pending-request tracking and inbox listeners are released.
The five focused suites pass 35 tests, and the reconnect-policy suite passes
eight more with normal timing settings (test-mode timing changes its defaults).
Conat and CLI TypeScript builds pass. Installed validation of this client change
is recorded above; the subsequent broker fix and completed high-rate probe are
recorded below.

### Lease-expiry admission classification

The broker now checks the authenticated lease deadline before and after the
publication policy check, across publish, interest waits, RPC, fast RPC, and
raw RPC. Expired leases return `CONNECTION_LOST` without routing the request;
ordinary permission denials under a current lease remain 403. Socket teardown,
credential renewal, and receipt-based mutation recovery retain their existing
roles. The broker does not extend authority or replay work. Publication also
rechecks the deadline after asynchronous return-inbox authorization.

The new real-broker matrix deterministically advances the server-owned deadline
while the original teardown timer is still pending. All 15 expiry cases failed
before the fix, and the five current-lease permission cases already passed.
All 20 cases now pass, including expiry during either a successful or denied
asynchronous policy check. Conat and project-host TypeScript builds pass.
The six-suite regression set passes 82 tests with test-mode cleanup enabled,
including caller/revocation, admission, reply rotation, receipts, and confined
socket return paths; the process exits normally. A first invocation without
test mode also passed assertions but retained handles and was terminated after
reporting completion, so it is not the clean-exit verification.

Installed retest: rebuilt source `0d1d7dd87f6f224e7f61da252b8bb4defbb754f5`
as host bundle `20260927T085229Z-0d1d7dd87f6f`. Host3 upgrade operation
`661399a9-29d0-4586-8136-2c4112cb26fc` succeeded with managed component alignment
(project-host, Conat router, persistence, ACP worker). The primary dev hub was
confirmed stopped before this operation was admitted and was restarted; the
operation was not submitted twice. The installed CLI remained at the verified
`c34db4a0...` SHA-256 recorded above, tools version `1790497614068`.

The same isolated manual-key harness, with a 600-second parent lifetime,
240-second observation budget, 1ms requested delay, and target of 600 writes,
completed successfully and exited zero:

- 605 acknowledged synchronized writes over 143,968ms before explicit key deletion.
- Maximum acknowledgment gap before deletion: 2,463ms.
- 625 acknowledged writes total; last acknowledgment 3,772ms after deletion returned.
- Session interruption at 3,991ms after deletion, during `save-history`, with
  `live text session interrupted: authorization failed`.
- Independent live-document reads five seconds apart both returned
  `sync-revocation-write-624`; these inspect live state, not unacknowledged disk writes.
- Cleanup completed. A subsequent direct project check independently confirmed
  the unchanged installed CLI hash and no `.api-probe-*` directories.

This closes the observed high-rate manual-key renewal/revocation failure for
this installed run. It does not establish the entire manual/managed matrix,
migration, authority-outage behavior, or production readiness. The private
follow-up review request for `0d1d7dd87f` was accepted under attempt
`1e911507-bd67-4be3-98c6-c3bb51181ef0`; a disposition has not been received here.

## Disk-save disconnect reproduction, 2026-09-27

Further installed-CLI probes used the same verified `d20be971...` bundle:

- A normal-rate run completed 130 writes over 83,745ms before deletion. Its last
  acknowledgment was 20,358ms after deletion returned. At 20,930ms a disk save
  rejected with the string `Error: socket has been disconnected`. Independent
  live reads five seconds apart both returned write 165, although the last
  acknowledged index was 164. A lost acknowledgment therefore did not mean the
  last write failed to execute. Cleanup absence was independently verified.
- A higher-frequency run (1ms inter-write delay, target 1,000 writes) reproduced
  the same disk-save error after 250 acknowledged writes, before the harness
  revoked the key. Cleanup deleted key 128 and restarted only the disposable
  validation project. A subsequent directory listing found no probe directories.

This identifies a real healthy-lease reliability gap, not merely missing error
logging: forced lease disconnect can interrupt in-flight disk-write admission
acknowledgments. Do not mask it by blindly replaying mutations. The next recovery
work must preserve or reconcile operation outcome under current authority.

Source tracing also found that `toConatError` returned a plain string for socket
disconnects. It now returns `ConatError` with code `CONNECTION_LOST` and the
subject, preserving the existing message. The code is deliberately distinct
from admission denial or a safe-to-retry response. Two regression tests failed
before the change and now verify structured errors and no replay for ordinary
publish and fast RPC, including an execution followed by a lost acknowledgment.
All 14 request/inbox/admission tests and the Conat TypeScript build passed.
This error-typing change is not a reconnect fix and has not been deployed.

## Installed text-session follow-up, 2026-09-27

Built the tools bundle from `5f314c31e60102000ebe0176394ec843a351c841` and
upgraded only host3's tools (version `1790492688735`, operation
`b5c11247-3442-40c5-a176-920021238590`). The running validation project still
had the previous CLI, so only that dedicated project was restarted. Its installed
CLI SHA-256 then matched the local build:
`d20be971ee22a2390411e95390aad3c335181c023d34bbf0addfdab4a2c0c105`.
No host runtime or other project was restarted for this tools update.

Three disposable manual-key runs used the installed CLI with an empty environment
and a private provider file:

- First run: 132 acknowledged writes over 81,986ms before deletion. Last write
  acknowledgment was 16,325ms after deletion returned. The CLI reported
  `live text session interrupted: authorization failed`, but the harness only
  timestamped an inner save-loop catch, missing the outer session rejection.
  Independent live reads five seconds apart both returned synthetic write 159.
  This run did not establish interruption timing.
- Second run: stopped after 79 writes, before the planned deletion. A non-Error
  thrown value was logged incorrectly as `undefined`. The key was then deleted
  by cleanup. This unexplained pre-revocation interruption is an open reliability
  gap; do not infer consistently healthy lease recovery from the passing runs.
- Third run, with outer rejection timing and string-error logging corrected:
  131 acknowledged writes over 81,642ms before deletion, 159 writes total.
  Last acknowledgment was 16,236ms after deletion returned and the session
  reported authorization interruption at 16,589ms. Independent live reads five
  seconds apart both returned synthetic write 158. The probe exited successfully.

The third run demonstrates the bounded manual-key text interruption and stable
post-revocation document in this scenario, including sustained editing across
multiple host leases. It does not close the preceding intermittent failure,
prove managed-turn behavior, or cover authority outages/migration. Temporary
provider/document directories were removed and fixture processes stopped by
restarting only the dedicated validation project during each cleanup. No user
document was edited. A private focused review was accepted for the exact code
head (attempt `1561b8c2-2024-43af-8c15-b4fe0ea12351`); no review result yet.

## Earlier synchronized-text interruption gap, 2026-09-27

The CLI text-session follow-up now guards opening, saving, disk saving, and
session callbacks against a received authentication denial or explicit client
closure. It closes the raw sync document, rejects pending callers even if the
underlying close resolves a save, and rejects subsequent use of that session.
Ordinary disconnection and a successful lease handshake do not trigger this
guard. Cached sessions are separated by client instance as well as project/path,
and closed entries are reopened rather than reused. Failed/timed-out openings
also close their raw session and remove authorization listeners.

Eight new session tests cover pending saves, disk saves, healthy reconnection,
client/explicit closure, idle denial, opening cleanup, and cross-client cache
isolation. Together with the two existing text tests and two lease-reconnect
tests, all 12 passed; CLI production and test TypeScript builds passed. Most
session assertions use a synthetic sync document; the lease test uses an actual
in-process broker. This is not yet deployed/installed-CLI evidence. The live
interruption gate below stays open until the probe is rerun, including independent
post-revocation document inspection and healthy editing across lease renewal.

Follow-up source tracing found that `SyncDoc.save()` awaits
`DStream.save()`, whose retry loop catches save failures indefinitely. Separately,
`Client.waitUntilSignedIn()` missed an authentication error already received on
a connected client and awaited another `info` event. A regression test reproduced
the latter as a timeout rather than the existing denial. The client now rejects
that known denial immediately, while a disconnected client may still await a
fresh successful handshake. This does not fix the durable-stream retry policy
or establish synchronized-text revocation completion.

The three reconnect/inbox/admission suites passed all 18 tests, but Jest retained
an open handle and was interrupted after reporting success. Separate test-mode
runs of the two sign-in cases and all 10 inbox/admission cases exited normally.
The full reconnect suite cannot use that mode unchanged: its existing timing
assertion assumes the non-test reconnect defaults. Conat TypeScript build and
`git diff --check` passed. No deployment or live rerun of this follow-up yet.

The installed CLI on the same isolated validation project was run with a
private key file and an empty environment. A disposable `probe.txt` was opened
through `api.text.open(...).withSession(...)`. One live session repeatedly
replaced its synthetic content, awaited `save()` and `save_to_disk()`, and
logged each completed write. After at least three writes, its parent manual
key was deleted.

The trace contained 39 completed writes; the final acknowledgment arrived
20,757ms after deletion returned. However, no interruption or completion event
arrived during the subsequent bounded polling window. The probe therefore
failed its interruption assertion. This is not evidence of successful writes
past the revocation bound, nor sufficient proof of server-side write denial:
the client was left awaiting an operation instead of reporting transport loss.

Inspection of `cli/src/api/text.ts` shows that the session binder awaits the
callback without a transport-loss race, and the save path awaits sync save
promises directly. The next step is to reproduce cancellation behavior in
focused tests, ensure pending writes cannot be silently replayed under a later
credential, and rerun the installed CLI fixture with independent post-revocation
document inspection. Do not count this synchronized-editing case as passed.

The fixture key was deleted before the assertion failure. Cleanup restarted
only the dedicated validation project and removed its temporary provider and
document directory. No user document was used or changed.

## Live terminal revocation and reattachment, 2026-09-27

Validation project `2cb4b3fe-2ffa-4061-8e45-d1ee239c9535` remained on host3.
Its installed CLI SHA-256 was checked directly:
`bdb14be84fdd083bbe963738fefd8308ca3ab4b938ebd7bd9e0eebeabd1e3d53`.
No host/runtime/tools upgrade was performed for this checkpoint.

The installed CLI, launched with an empty environment and a private API-key
file, spawned a shell, wrote a synthetic command, and read its expected output
through ordinary terminal history. The shell, provider directory, and key were
removed afterward (key ID 120). This is ordinary manual-key CLI evidence.

A separate raw scoped-client probe used the current local Conat client code
and the deployed project terminal service. Its shell produced a line every
500ms. After deletion of the parent manual key, 47 output deliveries had been
observed in total; the last arrived 21,684ms after deletion returned, and the
connection was observed disconnected at 22,112ms. A new host exchange using
the deleted key was rejected. These observations are within the documented
30-second bound, not a claim of immediate revocation or a load-test bound.

A fresh authorized manual key then attached, without spawning, to the same
terminal PID (75) and received new output. This demonstrates the intended
distinction between revoked session access and a process that remains alive.
The fresh client destroyed the fixture process, all clients closed, and both
test keys were deleted. The probe exited successfully.

This closes the manual-key continuous terminal-output and fresh-key
reattachment cases for this deployed fixture. It does not prove installed CLI
automatic terminal recovery, managed-turn parity, source-membership loss,
authority outage, or all terminal input/reconnect races.

## Two-broker interest withdrawal, 2026-09-27

`core/server.cluster-revocation.test.ts` starts two real in-process Conat
brokers connected through the cluster protocol. An API-key-shaped principal on
one broker subscribes and registers a fast-RPC service; a client on the other
broker successfully publishes to that subscription and invokes the service.
The test then makes the authority callback reject or remain unavailable.
Using the production 15-second refresh and 10-second timeout, both cases
disconnect the key client and remove subscription and RPC interest from both
the local broker and the remote link. A subsequent remote RPC fails.

Both cases passed in 43.5 seconds, exited normally, and closed their clients,
services, subscriptions, and brokers. Conat typecheck and `git diff --check`
passed. The authentication/authorization callbacks are test doubles: this is
cluster transport and cleanup evidence, not deployed two-bay authority outage,
continuous-load timing, project-host session, or managed-turn validation.

## Shared-editor browser checkpoint, 2026-09-27

Source checkpoint: `74d11eff2f6bdb91250a07797c5d1b65c8f16be7`.
The live connector dialog initially overflowed at a 320px viewport: its
304px client width had 399px of scrollable content. The selected-project row
pushed the Hidden checkbox outside the viewport. The shared editor now allows
the selector to shrink and the remove button to wrap. Long project titles
ellipsize inside the selector instead of imposing a minimum content width.

After rebuilding, direct Playwright checks against the local hub's actual
signed-in frontend found:

| Dialog and viewport                     | Client / scroll width | Result                 |
| --------------------------------------- | --------------------- | ---------------------- |
| Connector, 1280px                       | 700 / 700px           | No horizontal overflow |
| Connector, 320px                        | 304 / 304px           | No horizontal overflow |
| Manual API key, 1280px                  | 760 / 760px           | No horizontal overflow |
| Manual API key opened directly at 320px | 304 / 304px           | No horizontal overflow |

All four dialog checks passed the focused axe rules for contrast, labels,
ARIA attribute values, and button names; this is not a complete accessibility
audit. Desktop checkbox keyboard toggling, Escape dismissal, and trigger-focus
restoration passed. Direct-mobile manual-key selection worked with keyboard
Enter after filtering; its Create button was reachable by scrolling. Mobile
Escape dismissal passed. Successful runs reported no browser page errors.
Only draft controls were exercised: no connector configuration was saved and
no API key was created by these UI probes.

Screenshots are retained locally under `src/.local/api-first-ui` as
`connector-1280.png`, `connector-320.png`, `manual-1280.png`, and
`manual-320.png`. The probe obtained its browser cookie through the existing
fresh-authenticated `system.issueBrowserSignInCookie` operation, kept it in
memory, and closed the browser and Conat client after each run.

Seventeen focused frontend tests passed, along with frontend typecheck,
frontend lint, and `git diff --check`. A full `pnpm -C src build:dev` at this
exact source checkpoint completed successfully. No project-host or tools
upgrade was performed for this UI change.

### Remaining UI gates and unsuccessful setup paths

- Resizing an already-open manual-key dialog from desktop to 320px made the
  dialog disappear. The account settings page renders its active content in
  different desktop/mobile trees; the draft is not proven to survive that
  transition. Direct-mobile success does not close this issue.
- Pointer selection of the filtered project option at 320px timed out in one
  attempt. Keyboard selection passed in the final run; pointer behavior still
  needs investigation.
- Dark themes, 200% zoom, saved-value round trips, approval persistence, and
  connector footer reachability remain unverified by this checkpoint.
- Typed browser spawning loaded the signed-in page but timed out waiting for
  automation registration. Direct Playwright was used instead; registration
  itself is not validated.
- The primary development hub stopped during setup with a billing-authority
  lease-query timeout. After verifying it was stopped, normal hub startup
  recovered it; the attached bays were left running. This does not establish
  a fix for the unrelated billing failure.

The remaining manual/managed, outage, migration, resource-limit, and persistent
project-session acceptance gates below remain open.

## Full-build checkpoint, 2026-09-27 (not deployed)

### Mobile project-picker follow-up

At `8dd6f53d820402b0242ca65eeb00d4fcd4917d2e`, the shared editor keeps
its add-project picker explicitly empty after selection instead of retaining
the just-added title. Eighteen focused tests, frontend typecheck, and lint pass.
The new integration test uses the actual Ant Design picker for two successive
pointer selections and checks its placeholder and retained focus.

After rebuilding the static frontend at that revision, a live 320px manual-key
dialog accepted a pointer click on the filtered project's visible dropdown
option. The selected project remained in its grant row and the add picker
cleared. Client/scroll widths were both 304px, the four focused axe rules passed,
the Create button was reachable, and Escape dismissed the dialog. No page
errors occurred, and no key or configuration was saved. This supplies the
previously missing mobile pointer-selection evidence for this flow.

An earlier attempt ran while the primary hub was stopped and produced no
assertions; it is not counted. Its log records a billing-authority lease-query
timeout at 2026-09-27T06:28:27.008Z. Normal startup recovered the primary without
restarting the attached bays. The successful probe refreshed the hub environment
and closed both browser and connection. Repeated dev-hub fail-stops remain an
environment reliability concern, not a resolved API-first acceptance gate.

### Responsive draft-retention follow-up

At `2c618235fa3fa89acd8cbece1aef0a60fe84cc9b`, settings content stays at
the same keyed React path across desktop/mobile navigation. The new regression
test checks that the exact input node, keyboard-entered draft, and focus survive
both transitions. All 21 focused frontend tests passed, as did frontend
typecheck and lint. After the test fixture's component naming was corrected for
the hooks lint rule, its four-test suite and typecheck passed again.

`pnpm -C src build:dev` passed. Its incremental scheduler skipped static output,
so `NODE_ENV=development pnpm rspack build` was also run in `packages/static`;
the successful bundle identified the exact source revision above.

The actual manual-key dialog then survived 1280 -> 320 -> 1280px without
closing or repopulating its selected-project draft. Client/scroll widths were
760/760, 304/304, and 760/760px, respectively. All three focused axe scans
passed, the Create footer was reachable at every width, and Escape dismissed
the dialog. No page errors occurred. No key was created. The 320px screenshot
was visually inspected. This closes the observed responsive-unmount failure
for this draft flow, not the remaining theme, zoom, or saved-value gates.

The first probe produced no assertions while the primary hub was stopped and
is not counted as validation. Normal startup recovered the primary; both
attached bays were already running and were not restarted. The successful
probe ran after refreshing the dev hub environment and closed its browser and
Conat connection normally.

At `0d9db0b52ae82e5c9cf2ed48f3f90f20882bd899`, `pnpm -C src build:dev`
completed with exit status 0 in `/home/user/cocalc-ai`. The tracked checkout
remained clean. This builds the accumulated transport, terminal recovery, and
Jupyter reconciliation changes together; it does not deploy them or establish
the live manual/managed acceptance matrix.

Nine Conat suites passed all 53 tests against the rebuilt workspace outputs:
inbox rotation, inbound admission, usage monitoring, socket inbox-return,
socket client/base/TCP, Jupyter replay pagination, and scoped Jupyter transport.
The initial Jest process remained alive after reporting success and an
open-handle warning; it was terminated after test completion. A diagnostic run
located open test broker listeners. The initial invocation omitted
`COCALC_TEST_MODE=1`, which enables Conat's instance tracking and test cleanup.
Repeating all nine suites with that setting passed all 53 tests and exited
normally with status 0, without `--forceExit`. No runtime code change was needed.

An independent review was requested for this exact head and its accumulated
transport changes. Delivery was accepted and saved (attempt
`41779c61-3050-48fe-af21-ccfada0b13aa`); this is not a completed review or approval.

### Deployable bundle checkpoint (not deployed)

`pnpm dev:hub:build` completed with exit status 0 at
`e4082b57bfd70e11ea229430aa46b15ace311859` (documentation-only follow-up to
the code checkpoint above). It built the production frontend, workspace,
project-host and project runtime bundles, CLI, and amd64/arm64 tools archives.
The frontend emitted asset/entrypoint size warnings, not compilation errors.
The tracked checkout remained clean. No hubs or projects were restarted and no
host upgrade was requested.

Project-host build identity: `20260927T012318Z-e4082b57bfd7`.
Project runtime build identity: `20260927T012343Z-e4082b57bfd7`.
All four archives passed `xz --test`. SHA-256 hashes (paths relative to `src`):

| Artifact                                          | SHA-256                                                            |
| ------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/project-host/build/bundle-linux.tar.xz` | `29d8e71e3793fcf59426eac7baf62d6fbb4f08bf2953c1f19609d46ea3fc5d9d` |
| `packages/project/build/bundle-linux.tar.xz`      | `da88aca5751921df7bc6277af8e235d2cc9a0e65099f9fd44364598ed1ecbe65` |
| `packages/project/build/tools-linux-amd64.tar.xz` | `fcca35a5410a18026f42bc9bd97d505f84c78d0f3a4712f0a88e5a099c76a277` |
| `packages/project/build/tools-linux-arm64.tar.xz` | `3350222ebd2b08cf6a741170f4454a0815b816a91f1e47a9195af9a12e5fbf2d` |

The CLI bundle `packages/cli/build/bundle/index.js` hashes to
`997caa25f222e04a26a6d8e706d366a93be5f7700336b95cf47c8b3d7018ba0c`.
Extracting `bin/cocalc-cli.js` from each tools archive produced that same hash.
These identities support subsequent installed-version checks; archive integrity
and byte equality do not establish live API authorization or workflow parity.

## Limited dev-host rollout, 2026-09-27

The primary dev hub was recovered with `pnpm dev:hub:start` after its existing
billing-authority lease-timeout fail-stop. No lease safeguards were changed.
The two attached bays were already running and were not restarted.

Only `host3` (`a3c4c6d0-2d08-4a01-9f9a-a5b544bfba31`) was upgraded from
the site's software endpoint, selecting project-host, project, tools, and
bootstrap-environment with managed-runtime alignment. Operation
`a2e179a5-bcc8-406e-83f4-609e86745831` reached `succeeded`. Its bootstrap
status reported zero drift and these installed versions:

- Project-host: `20260927T012318Z-e4082b57bfd7`.
- Project bundle: `1790472232510`.
- Tools bundle: `1790472290885`.

The existing validation project `2cb4b3fe-2ffa-4061-8e45-d1ee239c9535` was
started (operation `3829bca9-e9af-44bd-99f5-3221263b3d4d`) and subsequently
reported `running`. Its `/opt/cocalc/bin2/cocalc-cli.js` SHA-256 is
`997caa25f222e04a26a6d8e706d366a93be5f7700336b95cf47c8b3d7018ba0c`, exactly
matching the recorded build. Delta's host was not upgraded or restarted.
This verifies installation, not scoped-key terminal/Jupyter workflows or
independent review of the new transport code. The validation project remains
running for the next disposable fixture.

### Installed CLI terminal probe: partial pass, default-write failure

The verified host3 project ran its installed CLI using a manually issued,
five-minute key granting the full-runtime capability set for only that project.
The inner CLI ran under `env -i`, an explicit public API URL, a private
`--api-key-file`, and `--no-daemon`; no ambient account or agent credential was
available to it. The human-authenticated outer CLI only provisioned and cleaned
the fixture and launched the installed command.

Terminal spawn returned a real Bash PID. Ordinary `terminal write` returned
`written: false`, reason `terminal has an active browser leader`, about 2.6
seconds after spawn despite no browser being attached to this fixture. Repeated
history reads did not show submitted input. The explicit `--force` option for
the fixture's own terminal returned successful input and history contained
`answer-42`, assembled by the shell rather than present literally in its input.
Thus spawn, forced input, and history are verified; the default CLI workflow
fails and the leader/close lifecycle requires investigation. No Jupyter or
managed-turn claim follows from this probe.

Keys 77, 78, and 79 were deleted after the three attempts. Interactive Bash
ignored the first cleanup's SIGTERM, so a fourth temporary key (80) enumerated
only the unique `api-probe-*` sessions and hung up their PIDs (45, 89, 181).
It too was deleted. A subsequent process listing confirmed all three shells
were gone. Local and remote private credential directories were removed.

### Acknowledged terminal cleanup follow-up (not deployed)

CLI spawn previously called the socket's fire-and-forget close and could tear
down its transport before the terminal service released leadership. The shared
socket client now exposes `closeAndWait`, using the server's existing close
request/acknowledgment protocol. It closes locally even if confirmation fails,
but propagates failure rather than claiming confirmed remote cleanup. The
terminal client forwards that method; CLI spawn awaits it after successful
spawn and before returning. No new server RPC or agent-specific path is added.

Twenty socket tests pass, including acknowledged cleanup through one broker
and two linked brokers, plus an unconfirmed-close error with no request replay.
Both real-PTY cases pass: automatic input remains denied to an attached
terminal, becomes allowed after acknowledged close, and the same process can
be reattached. Conat, project, and CLI builds pass. The project Jest run emitted
an open-handle warning after assertions but exited with status 0. Installed
CLI retesting is still required before treating the live default-write failure
as resolved.

### Installed terminal cleanup retest: pass, 2026-09-27

At `073db91f44ea28c1a6a55e33dc6c0a54f0d8ebfd`, `pnpm build:tools` completed
and both architecture archives passed `xz --test`. Only host3's tools were
upgraded, operation `1e432fb1-d99c-4fc6-a76c-45bb826ad0b1` (`succeeded`).
Bootstrap status reported tools version `1790474475343` installed with zero
drift. No host protocol or project runtime bundle changed.

The validation project's restart reported a `stopProject` timeout. Subsequent
status and get requests both reported `opened`, so a separate start was
submitted as `3b9b7956-209f-4e9e-aeed-dafab00a608d`. The project then served
commands with installed CLI SHA-256
`0f89fd38eb2df579c7da3970028a10a0857e1272bbec7444f7d4077399e7c0e0`, matching
the new build. The restart timeout remains an operational observation, not a
successful restart claim. Delta was not restarted or upgraded.

The same isolated manual-key probe now requires ordinary input acceptance;
its forced-write fallback was removed. With an empty environment, a private
key file, explicit public API URL, and `--no-daemon`, the installed CLI spawned
terminal `api-probe-6e9ee806-8c4c-45a7-b3a3-4e60c3acdc0b` (PID 45).
Default input returned `written: true`, `bytes: 24`, `kind: auto`; history
contained the shell-generated `answer-42`. The probe exited 0, deleted key 81,
removed its credential directory, and hung up the fixture shell. A subsequent
process listing confirmed the shell was gone.

This closes the reproduced installed spawn/default-write/history failure for
an ordinary manual key. It does not establish daemon recovery, revocation
during sustained terminal traffic, managed-turn parity, or Jupyter persistence.

### Installed notebook probe: blocked before kernel discovery

On the same installed CLI, three ordinary manual-key attempts (keys 82-84)
could not complete live notebook initialization. The first combined edit/run/save
attempt failed; subsequent probes isolated `api.notebook.getKernel()` in a
new unique notebook path. The final diagnostic confirmed that remote execution
killed the command at its 45-second limit. No Python result, saved output, or
fresh-client persistence pass was obtained. All three keys and their private
credential directories were removed; the second attempt's process inspection
showed no remaining child process.

The project runtime logs show `jupyter.start` admitted and its server-side
syncdb becoming ready in roughly one second. They also record `ENOENT` while
initializing the newly requested notebook from disk. That log alone does not
explain the client-side stall.

Inspection identifies two concrete transport gaps to address next:

- Full-runtime token issuance includes only the exact
  `persist.project-<project_id>` subject. The actual persistence client requests
  `<subject>.id` and uses descendant socket subjects. Executing the built
  authorization policy confirms the root is allowed while `.id` and
  `.server.test.client` are denied. Existing full-runtime policy tests do not
  exercise these ordinary persistence requests.
- The socket client's custom-load-balancer path assigns only a server ID;
  unlike ordinary discovery, it does not negotiate `inboxReturn`. Persistence
  uses that path, so fixing the publication audience alone is insufficient to
  establish confined reply subscriptions.

These findings require a shared persistence/socket fix with negative confinement
coverage, not broader account inbox access or an agent-only notebook path.
The new-notebook initialization case and the full installed workflow must then
be retested. No production authorization behavior was changed in this probe.

### Persistence discovery fix (not deployed)

Full-runtime tokens now grant the dot-delimited persistence service namespace
for exactly their target project, including discovery and socket subjects.
Viewer keys still receive no persistence authority. Cross-project, account,
prefix-collision, and subscription denials remain tested, as does storage-path
confinement inside a permitted project service.

The shared socket load-balancer contract accepts either the legacy server ID
or a server descriptor carrying `inboxReturn: 1`. Persistence clients opt into
feature discovery; updated load balancers retain the string response for old
clients. New clients normalize legacy responses without claiming inbox-return
support, share the discovery cache, clear it on disconnect, and reject malformed
responses without caching them. The persist client passes negotiated features
to the normal socket path rather than subscribing to a broad project inbox.

All 48 tests in eight Conat suites pass, including real single-/two-broker
load-balanced socket negotiation, request/response, confined return routes,
foreign-inbox denial, and confirmed cleanup. All 35 host authorization tests
pass; Conat and project-host TypeScript builds and `git diff --check` pass.
These tests establish transport primitives and policy, not a real notebook
save or a persistence database round-trip.

The issuer and token verifier both validate the canonical audience. Their
updated versions must be deployed together with the persistence service and
CLI before the installed notebook retest; mixed audience versions fail closed.
No live installation was changed by this follow-up.

### Persistence rollout and notebook presence follow-up

`pnpm dev:hub:build` passed at `cf59599857a95e7a3f9220cf882d7cf0523349ec`;
all four runtime/tools archives passed `xz --test`. The three dev bays were
restarted (the primary was already stopped when the restart script inspected
it). Host3 upgrade `64f51edb-e722-453d-8719-8608b9e45f3e` succeeded with
project-host, project, tools, and managed-service alignment. Bootstrap status
reported zero drift:

- Host build: `20260927T023413Z-cf59599857a9`.
- Project bundle: `1790476486202`.
- Tools bundle: `1790476544436`.

Validation-project restart `cd18147c-d47f-47d9-9c09-332155b10217` succeeded.
Its installed CLI hash matched the build:
`053399247109928b8542ec92d3195c478f242a834b5e69ad829d180cbac9b4bb`.
Delta's host was not upgraded. Older hosts can reject the new canonical token
audience; this is a limited dev rollout, not a fleet-wide readiness claim.

The first installed manual-key retest (key 85) completed kernel discovery,
returning an empty list instead of timing out. The minimal image has Python
3.14.4 but no ipykernel or jupyter-client. A dedicated temporary environment at
`/home/user/.api-first-jupyter-validation-20260927` was provisioned using the
development uv binary because the image also lacks ensurepip. It contains
ipykernel 7.3.0 and jupyter-client 8.10.0, with user kernelspec
`api-first-validation-20260927`. This fixture remains installed for the next
test; no system packages or project image were changed.

The next key (86) discovered that Python kernel, but notebook editing failed
with `patchflow commit failed permission denied publishing` to the document's
`project.<id>.pubsub-cursors.<encoded-path>` subject. Both keys and their private
provider/notebook directories were removed. A later process listing showed no
remaining Python kernel or probe process. Execution/save/reopen remain unproved.

The subsequent, not-yet-deployed fix includes the reviewed `pubsub-cursors`
service in full-runtime token audiences. Subscription policy additionally
requires the matching project, `project:exec`, an explicitly signed service
root, and a single concrete document segment. It does not grant wildcard,
foreign-project, viewer, other-service, or account-inbox subscription rights.
This preserves collaborative presence instead of disabling it in headless
clients to bypass the error.

Thirty-four Conat tests and 35 host authorization tests pass. The new two-broker
test receives scoped presence, verifies interest remains active, expires the
client lease, and observes both disconnection and remote interest removal.
Conat typechecking and `git diff --check` pass. This follow-up still needs a
coordinated issuer/host upgrade and installed notebook retest.

### Installed notebook execution and restart persistence

The follow-up was deployed to the isolated host3 on 2026-09-27. The targeted
host bundle build passed at `9cc0f888885d06e1819ae5a3a6cf7970faf3ebc5`, with
identity `20260927T025624Z-9cc0f888885d` and archive SHA256
`2258ccc33ea9a0c283ec7d0a930647243d9504c577ec4722b52f6e0b22e03007`.
All three dev bays restarted successfully. Host upgrade
`8eb196d7-9015-4295-8233-d44e2ba55a5b` succeeded with managed-service alignment;
bootstrap status confirmed this host identity and zero drift. Project and tools
bundles remain `1790476486202` and `1790476544436`, respectively. Delta's host
was not upgraded.

The first probe stopped before creating a key because the development session's
fresh-auth interval had expired. The supported `auth elevate --dev` flow renewed
it. Subsequent probes used the installed CLI with a clean environment, a private
credential file, and an ordinary five-minute API key restricted to validation
project `2cb4b3fe-2ffa-4061-8e45-d1ee239c9535`. Human fixture credentials were
not passed to those scoped CLI processes.

- Key 87: discovered the temporary Python kernel, inserted cell `4397e6`, ran
  Python (`cli-muj8fv7k-hw11mo`), verified `notebook-answer-42`, saved, and
  verified the same cell/output from a separate CLI process.
- Key 88: repeated execution/save with cell `072413` and run
  `cli-muj8hgsu-2zbnaa`, then restarted the disposable project using the human
  fixture session. Restart `7f2383a5-7b8c-4c54-94e2-b694f4e3bb25` succeeded.
  A new scoped CLI process reopened the notebook and verified the saved cell
  and output after that restart.

Both probes exited successfully and deleted their keys and private provider/
notebook directories. The temporary Python environment/kernelspec remains
installed for further tests. No raw notebook JSON was read or edited; notebook
operations used the live Jupyter scripting API. This establishes the ordinary
manual-key edit/run/save/reopen workflow, including project-restart persistence.
It does not establish stream resumption, sustained-session revocation, the
managed-turn matrix, or readiness of hosts that have not been upgraded.

A supplemental private review of `0d9db0b52a..9cc0f88888` was accepted and saved
under attempt `b9c73fea-390f-41e6-ad15-153b7c059277`. No review result has yet
been received; this is not a security approval.

### Active notebook revocation follow-up (client fix not yet deployed)

An installed-CLI probe used manual key 89 and a disposable Python cell emitting
one output per second for 90 seconds. The observer waited for actual stream
output before deleting the key. Deletion completed at `1790478543716` ms UTC;
the last observed output batch arrived at `1790478547799`, 4,083 ms later.
No subsequent batch was observed during the remaining polling window. However,
the CLI never reported stream completion or the expected transport-loss error.
This is evidence of stopped delivery, not a complete revocation/cleanup pass.

The logical Jupyter socket handled `close`/`closed` but not `disconnected`.
A denied reconnect can therefore leave the iterator waiting indefinitely. A
new broker-disconnect regression timed out against the old implementation.
The fix cancels the active iterator with the existing uncertain-outcome
`JUPYTER_RUN_TRANSPORT_LOST` error on disconnect too. It does not resubmit code.
Tests cover normal completion, explicit socket close, transport disconnect,
and server-enforced lease expiry; reconnect uses a fresh application client,
and the runner invocation remains exactly one. Fifteen Conat Jupyter tests,
five project Jupyter API tests, and Conat typechecking pass. The installed CLI
still needs rebuilding and this live probe must be repeated.

Cleanup exposed a separate runtime failure: the restart operation failed at
`podman rm -f -t 5` for the disposable container. Host diagnostics then showed
no running containers. Project start
`b5c03ab1-320e-4dad-8aec-cf95f9fc2884` succeeded, after which the exact leftover
private probe directory was removed. Key 89 was already deleted before that
failure. This restart failure is not treated as a successful lifecycle test.

### Installed notebook revocation retest

The CLI and both tools archives built successfully at
`b99e13f67ed33321008323b5e53397922f83cc6e`; both archives passed `xz --test`.
Host3 tools upgrade `9762975d-2aef-4452-84bb-156579995707` succeeded. The running
project initially retained the old CLI, so disposable-project restart
`e64550a6-d140-43aa-929e-023a2e9d6cd7` was performed and succeeded. Its installed
`/opt/cocalc/bin2/cocalc-cli.js` then matched the new bundle SHA256
`17036f8418377d91c9cfb5dd5ac895e135425403edaca6d7c5150091b8d6913f`.
Host authorization remains at the previously deployed `9cc0f888885d` build.

The same continuous-output notebook probe used key 90. After observable Python
output, key deletion completed at `1790479259690` ms UTC. The last delivered
batch was at `1790479277711` (18,021 ms later); the client reported
`JUPYTER_RUN_TRANSPORT_LOST` at `1790479278120` (18,430 ms after deletion).
It did not report normal completion or resubmit the run. Both observed times
are within the 30-second retained-session bound. The probe exited successfully;
its cleanup restart and private provider/notebook-directory removal succeeded.

This verifies live interruption reporting for this manual-key notebook stream.
It is not proof of other transport families, managed-turn finalization,
membership loss, authority outage, or uninterrupted long-run recovery across
healthy credential renewal. Those remain separate acceptance cases.

### Consumed-output cursor for renewal recovery (not deployed)

Healthy credential renewal must not require rerunning a notebook cell. The
existing bounded replay service stores numbered batches, but direct output
previously omitted their sequence numbers. The direct stream now includes a
`jupyter-batch-sequence` transport header matching the stored batch, including
the backpressure retry path. Output messages themselves are unchanged.

`JupyterRunIterator.replayCursor` tracks only batches consumed by the caller,
not those merely received and queued. Disconnect cancellation therefore cannot
advance recovery past discarded buffered output. Missing, invalid, duplicate,
or discontinuous sequences disable the cursor rather than silently guessing a
resume position. Older clients ignore the added header; a newer client reading
an older server's unnumbered stream cannot safely resume it.

Thirty Conat Jupyter tests and 55 backend Jupyter tests pass, along with
Conat typechecking. Tests cover queued cancellation, awakened consumers,
canonical transport headers, invalid sequences, and replay after socket close,
transport disconnect, and server lease expiry. Replay excludes the consumed
batch and runner invocation stays at one. Automatic CLI consumption of replay
pages across healthy renewal remains unimplemented; this is prerequisite
sequence bookkeeping, not a long-running-session completion claim.

### CLI retained-output recovery (not deployed)

The ordinary CLI run session now catches typed transport loss only when its
stream has a valid consumed-output cursor. It opens a new application client
through the existing authenticated project connection and reads bounded replay
pages for the same run ID. It never sends another run request. It polls unfinished
output once per second, validates contiguous sequences and run IDs, and refuses
missing/expired replay rather than claiming completion. Read failures carry
`JUPYTER_RUN_RECOVERY_FAILED`, the run ID, and the underlying cause.

Each replay read has a five-second timeout. One retry is allowed for a closed
or disconnected application socket, but not for explicit 401/403 denial or
cancellation. Closing the session aborts polling and closes both clients;
responses arriving after cancellation are discarded. Legacy unnumbered streams
still report transport loss rather than guessing a recovery cursor.

Forty-three Conat Jupyter tests and eleven focused CLI tests pass. The CLI
TypeScript build (including Conat dependencies) and test compilation pass.
The broker-backed recovery case reconnects with scoped authorization, receives
the missing output, and verifies exactly one simulated runner invocation.
This is not a deployed long-run test. Healthy renewal across several token
lifetimes, notebook save after recovery, and interactive stdin during recovery
remain to be validated with the real installed CLI/runtime.

### Recovery deployment verification, 2026-09-27

Project and tools bundles built successfully at
`8deee7733428c79113efed50b65191d6f90a9ccc`; all three archives passed
`xz --test`. Project archive SHA256 is
`eb11dc3c0e010a07042e9c4fe9cffd91e43dbdb2f5afc2ee4a5851fe18b1c2db`;
the installed CLI SHA256 is
`ea4cc5e2950adf1d4464014aa24e84f27be038f7234a798614cf472c60b13701`.

The initial combined project/tools upgrade reported success, but the project
runtime remained at `cf59599857a9` while the CLI was current. A real Python
80-second probe using key 91 consequently reported `JUPYTER_RUN_TRANSPORT_LOST`;
inspection confirmed the old runtime lacked `jupyter-batch-sequence`. Its
private credential directory and key were removed. This attempt does not test
the new server/client recovery combination.

The primary dev hub also stopped with a billing-authority lease query timeout.
It was restored through `pnpm dev:hub:start`; the attached bays remained running.
The prior project restart was terminal/canceled due to a host-process change,
and a subsequent explicit start succeeded. No uncertain notebook execution was
automatically resubmitted.

A project-only upgrade pinned to version `1790480271355`, operation
`04c327ee-78c8-4a08-b12f-e25b1b9f49f9`, succeeded on host3. Its desired and
installed project versions then agreed; tools remained `1790480368473`.
Disposable-project restart `1d4c7bd8-8121-4149-b016-8fd699dcd94e` succeeded.
Inside the project, `build-identity.json` now identifies
`20260927T033740Z-8deee7733428`, and the runtime contains the sequence header.
Host authorization remains at `9cc0f888885d`; other hosts were not upgraded.

Two new, independently named 80-second notebook fixtures (keys 92 and 93)
then exercised the installed combination. Both reached retained-output recovery
but failed with `JUPYTER_RUN_RECOVERY_FAILED`. The second captured only safe
error categories: its cause had code `408`, was a timeout, and was not classified
as a permission denial, closed-connection error, or unknown command. Neither
attempt passed output-completeness, save, or fresh-client verification. Each
private provider/notebook directory and key was removed by the probe cleanup.
These are new test runs, not retries of an uncertain execution.

Healthy long-run recovery is therefore **not working end to end yet** at this
checkpoint. The next investigation must distinguish replay connection setup
from the bounded replay request itself; increasing timeouts alone is not proof
of a correct recovery lifecycle. Interactive stdin remains separately unproven:
the kernel control path still sends its request through the original run socket.

### Scoped CLI lease reconnection (not deployed)

The host ends expired authorization leases with an explicit server disconnect.
Socket.IO does not automatically reconnect that namespace, even when ordinary
transport reconnection is enabled. The previous Jupyter recovery fixture
manually called `connect()` before reading replay, unlike the actual CLI.

Scoped API-key project-host connections now handle only that server-disconnect
reason by invalidating the cached child token and initiating a new handshake.
The existing issuer rechecks parent authority. This does not reuse the old
lease, broaden scope, retry a command, or attach an old logical socket to a new
reply prefix. Ordinary transport/client disconnect behavior is unchanged, and
closing the client removes the listener.

A real broker test expires a short lease, observes fresh authentication and a
different reply prefix, then revokes its test authority and checks that the next
handshake is rejected. Focused coverage also verifies disconnect-reason
selection and explicit-close cleanup. This addresses the transport mismatch;
installed notebook recovery still requires a new live test.

### Installed long-run notebook recovery pass

The CLI/tools build at `b1893df996ed073070f67b81c97b6b6b72cba558` completed;
both architecture archives passed `xz --test`. Sixteen focused CLI tests,
CLI typechecking, and test compilation passed. Host3 tools upgrade
`2e819df6-95d2-4adc-9bd1-19e3459a7857` installed version `1790481887848`.
The first project restart failed during container removal; after inspecting
its terminal operation and observing the project in `opened` state, explicit
start `b067983c-d466-45bd-800b-8949fa0641d6` succeeded. The installed CLI SHA256
then matched `874baf80c23dbde45c2c91e0ed7275d749b2ce31b0fc956ffea11ca0ff221e8b`.
Project runtime remains `20260927T033740Z-8deee7733428`.

Manual key 94 ran the installed CLI with an isolated environment and credential
file. Real Python execution `cli-mujb0d6z-a44wo4` in cell `28de5f` emitted
`tick-0` through `tick-79`, one per second, then its final answer. The probe
asserted all 80 lines appeared exactly once and in order, and that the kernel's
execution counter was exactly one. It completed in 85,441 ms, consuming 662
stream characters, across multiple 25-second host-credential lifetimes.
Notebook save returned `saved: true`; another CLI process reopened the notebook
and verified the saved output for the same cell. The private fixture directory
and key were removed successfully.

This is a live manual-key output recovery/save/reopen pass, not a claim that
interactive stdin recovery, managed turns, or other persistent session families
are complete. A private supplemental review of
`9cc0f888885d..b1893df996` was accepted and saved as attempt
`9f6d0f52-e51b-49c9-914c-5ddda8413eff`; review completion is still pending.

### Revocation after lease-reconnect deployment

The installed continuous-output probe then used key 95. Deletion completed at
`1790482573249` ms UTC. The last delivered output was at `1790482587136`,
13,887 ms after deletion, within the 30-second credential-backed I/O bound.
The CLI reported `JUPYTER_RUN_RECOVERY_FAILED` at `1790482608230`, 34,981 ms
after deletion. The stricter probe checks both delivery and interruption time,
so it failed its interruption-time assertion; this is not recorded as a full
revocation-test pass. The key was already deleted, and the probe's restart and
private-directory cleanup completed without a cleanup error.

The late error is distinct from continued authorized output. Inspection found
that a socket request may spend its timeout in readiness, repeat that wait
after reconnect, and then the CLI may retry the bounded replay read on another
socket. Consequently the configured five-second request timeout is not a
five-second end-to-end recovery deadline. Tightening and testing that deadline
remains work; the observed I/O stop does not justify claiming all long-lived
session cleanup semantics are complete.

### End-to-end replay deadline (not deployed)

The CLI replay reader now applies a single five-second deadline to each page
read, including transport readiness and its one safe retry. Timeout, session
abort, or explicit close disposes the application client and prevents late
failures from creating another client. A healthy client is still reused for
subsequent pages. No notebook execution request is retried.

Twenty focused CLI tests pass, with CLI typechecking and test compilation.
The deterministic deadline test spends 60 ms of a 100 ms budget on the first
attempt, verifies that the retry receives only 40 ms, and observes timeout and
client disposal at the original deadline. Other cases cover cancellation,
late completion, denial without retry, and successful client reuse. The earlier
live 34,981 ms interruption remains the deployed evidence until this build is
installed and the probe repeated.

The tools build at `f619253d673a8f05c0173f3652286fa8e3fd73e0` subsequently
passed, including archive integrity checks. CLI bundle SHA256 is
`4b555bf93fcf93299db0811436f7b855124bbcfa756cf32e864d07ec8c8486fb`.
Host3 tools upgrade `bbbf67c1-10cc-4275-8824-f1008117a8a2` succeeded for
version `1790483329162`. The primary hub then exited with another billing
lease query timeout while disposable-project restart
`0195ea23-b931-4aeb-a602-f2bd9dce2542` was running. Normal hub startup restored
the primary; attached bays were still running.

After recovery, the project remained reachable with the previous CLI hash
`874baf80c23dbde45c2c91e0ed7275d749b2ce31b0fc956ffea11ca0ff221e8b`, while
the operation continued to report `running`. The rollout request was explicitly
canceled through the operation API; its waiter observed terminal `canceled`.
Cancellation of the LRO record alone does not prove all underlying work stopped.
No duplicate restart or new credential probe was submitted after this incident.
The new deadline is built and installed on the host, but is not yet verified
inside the running project or by the live revocation probe.

### Deadline build deployed and revocation verified

After confirming the old restart was canceled and the project was running,
restart `7775473f-4d53-4cb4-903b-7e1d086e4c19` succeeded. The running project's
CLI SHA256 now matches the deadline build:
`4b555bf93fcf93299db0811436f7b855124bbcfa756cf32e864d07ec8c8486fb`.
This supersedes the interrupted-rollout checkpoint above.

The active-notebook probe used key 96. Deletion completed at `1790484064926`
ms UTC; the last delivered output was at `1790484083715` (18,789 ms later).
The CLI reported `JUPYTER_RUN_RECOVERY_FAILED` at `1790484089009` (24,083 ms
later). Both assertions passed the 30-second bound. The fixture's restart and
private-directory cleanup completed successfully. This demonstrates one live
revocation case, not all timing phases, load conditions, or session families.

The subsequent healthy-run attempt failed during provider upload, before
notebook execution. Primary hub PID 1306528 exited at
`2026-09-27T04:41:59.183Z` with a billing-authority lease query timeout. Normal
hub startup restored PID 1330503; attached bays remained running. Key 97 was
explicitly deleted, and its private fixture directory was removed. This setup
failure is not evidence about notebook replay correctness.

After restoring the hub, a fresh attempt with key 98 passed the healthy
80-second execution probe. Cell `929126`, run `cli-mujc9qj2-m11nsz`, completed
in 82,934 ms with all 80 ticks in order and exactly one execution-counter
message. The CLI saved the notebook and a second CLI process verified the
same cell's persisted output. Key deletion and private-directory cleanup
completed successfully. Thus the installed deadline build has both a healthy
multi-lease output-recovery pass and an active-output revocation pass. This
does not establish interactive stdin recovery, managed-key parity, or the
remaining cross-bay and session-family acceptance cases.

### Interactive input after renewal: live failure

The same installed CLI was tested with key 99 and a real Python cell that
requests a synthetic answer immediately, sleeps 35 seconds, then requests a
second answer. The CLI scripting callback returns `42` for either prompt.
Run `cli-mujcervw-1n6n9s` delivered the first prompt at 4,603 ms and produced
`before=42`. The second prompt never reached the callback, and `after=42` was
absent when the test's 65-second deadline fired (observed at 65,294 ms).
The probe failed as expected for missing recovery, then completed project
restart/private-directory cleanup and deleted key 99. No cell was resubmitted.

Inspection explains the gap: `jupyter/control.ts` sends stdin requests through
the original run socket. The CLI's replay reader opens another Jupyter socket
for retained output but does not rebind pending input. Existing scoped transport
tests request input before disconnecting, so their input assertions do not cover
this scenario. The output-only live successes above remain valid, but do not
establish interactive notebook parity.

The next implementation needs an ordinary authenticated run-input recovery
contract, bound to the existing notebook/run and a unique pending request. It
must allow a newly authorized client to answer without executing the cell again,
deduplicate answers across uncertain acknowledgments, bound pending state and
lifetimes, and keep answers (especially password input) out of replay storage
and diagnostics. Revoked or out-of-scope clients must not acquire this channel.
Validation must cover prompts both before and after renewal, a reply crossing
renewal, duplicate/stale answers, cancellation, and revocation while waiting.

### Pending-input service foundation (not deployed)

The ordinary Jupyter service now owns bounded, in-memory pending input for each
admitted run. `get-input` and `answer-input` use the existing authorized Jupyter
service and exact notebook/run/request targets. The original socket's response
and recovery responses resolve the same pending request, first answer wins.
Only the most recent accepted request ID is retained for duplicate acknowledgments;
answers are not retained in that state or written to the output replay store.
Run completion/service close clears state. Limits are one pending prompt per
active run, 16 KiB UTF-8 prompt, 64 KiB answer, and a 15-minute input lifetime.
An active duplicate run ID for the same canonical notebook is rejected.

The Python execution adapter uses this callback when available, preserving the
old socket adapter for other callers. Recovery acceptance cancels the obsolete
reverse request; inbox-return sockets now honor its abort signal and release
pending reply state. No cell execution retry was added.

Five state-machine cases and six scoped Jupyter cases pass, including a fresh
socket answering after original-socket closure, wrong notebook/request rejection,
duplicate-answer isolation, and no answer in replay snapshots. Together with
22 inbox-return cases, 33 focused tests pass; 55 backend Jupyter tests pass.
Conat and Jupyter typechecks pass. The initial transport Jest invocation passed
assertions but retained open handles; it was terminated, and subsequent combined
transport/backend runs used `--forceExit`. This is not clean-exit evidence.

Automatic CLI prompt recovery, callback deduplication across replacement clients,
and live two-prompt/revocation validation remain to be implemented and exercised.
These tests do not establish fresh credential issuance or revocation while a
prompt is pending, and the deployed failure above remains the live result.

### CLI pending-input integration (not deployed)

The CLI run session now shares an input responder between original and replay
clients. Server prompts carry a monotonically increasing per-run sequence as
well as their unique request ID. The responder retains only the current prompt
state, shares its callback promise across duplicate delivery, and rejects older
sequences. It clears the stored answer after acknowledgement or observed absence
of pending input, and closes with the run/replay reader. Callback errors are
reported without their potentially sensitive original message.

Replay polling checks pending input without awaiting the human callback. A ready
answer is submitted against its exact run/request; an uncertain acknowledgement
can be retried with the same request ID without invoking the callback again.
Input lookup/submission share the existing five-second replay deadline, including
transport retries. Deadline cancellation closes the responder, so a late lookup
cannot start a callback. No execution request is retried. A mismatched replay
run is rejected before input recovery is attempted.

Twenty-five focused CLI tests pass, including five responder/deadline cases;
11 input-state/scoped-service tests pass. CLI typechecking and test compilation
pass. This is component evidence, not a deployed interactive-input success.
The project runtime and CLI both need rebuilding/upgrading before repeating the
real two-prompt probe and testing revocation while a callback is pending.

### Input recovery deployed: two-prompt live pass

Project and tools builds at `836ac11985fcf5214ab026bb760036a54b42677a`
completed, and all three project/amd64-tools/arm64-tools archives passed
`xz --test`. Host3 project upgrade `02a86265-bc03-4428-9123-67a5c667a8d0`
installed version `1790485877012`; tools upgrade
`b3cad4c7-8ab9-44a3-8bb3-7999c1d8c72b` installed `1790485950326`.
Disposable-project restart `54da09ee-2574-441c-a1d3-3a4746cf5a39` succeeded.
Inside the running project, build identity was
`20260927T051106Z-836ac11985fc`, with CLI SHA256
`bdb14be84fdd083bbe963738fefd8308ca3ab4b938ebd7bd9e0eebeabd1e3d53`.
No other host was upgraded.

The previously failing two-prompt fixture passed with key 100. Run
`cli-mujd87ji-aj0c89` received its first prompt at 2,626 ms and its second
at 38,162 ms, with exactly two callback invocations. Both `before=42` and
`after=42` were observed; the run completed in 40,331 ms. No execution retry
was used. Project restart/private-directory cleanup completed and key 100 was
deleted. This supersedes the earlier live input-recovery failure for this
specific case; pending-input revocation and other acceptance cases remain
separate tests.

### Revocation while notebook input is pending: live pass

Key 101 ran a Python cell that prints a marker and waits for input. Its callback
was observed at `1790486278921` ms UTC, then deliberately waited 45 seconds
before returning the synthetic answer `42`. Key deletion completed at
`1790486279471`. The last delivered output was at `1790486278959` (512 ms
before deletion); `JUPYTER_RUN_RECOVERY_FAILED` was reported at
`1790486301007`, 21,536 ms after deletion. The test's 30-second interruption
and output-delivery assertions passed.

After waiting until at least 50 seconds after deletion, a separate authorized
CLI notebook inspection found no `revocation-after=42` output. This observation
covers the delayed-answer window without using the revoked key to inspect the
kernel. The probe then completed project restart and private-directory cleanup;
the key was already deleted. This is one manual-key pending-input case, not
proof of all cancellation races, managed lifecycle behavior, or clustered RPC
interest withdrawal.

## Shared-editor round-trip coverage (component tests)

The connector wrapper tests now render the real shared scope editor, replacing
only project lookup and backend/fresh-auth services. Both header and composer
entry points load an all-projects viewer default with a narrower explicit
directory override, change an account privilege by keyboard, save, reload, and
save again. Assertions check exact scope preservation, revision advancement,
fresh-auth invocation, source-project exclusion, and focus restoration. The
manual-key editor also preserves a restricted all-projects grant alongside
mixed explicit grants when saved without a privilege change.

All 14 tests across the connector, shared editor, and manual-key suites pass.
Frontend lint and TypeScript build pass. This establishes component integration, not real backend
approval, live persistence, browser layout, theme contrast, or mobile reflow.

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

### Explicit human regrant by scope edit: live failure

On 2026-09-27, disposable project `bf537fc6-5378-4cbe-955f-afd7cfe8c58c`
on bay-0 repeated the membership fixture. Initial admission, removal denial,
restoration-with-old-key denial, settled-barrier denial, and fresh-key admission
all behaved as expected through ports 9100, 13114, and 13214.

The human-authorized management API then explicitly edited the old key with
the project-read scope again. The edit returned, but its first subsequent HTTP
admission through port 9100 failed with `API key revoked or scope changed`.
The assertion stopped there; edited-key admission through the other two bays
was not exercised. All fixture keys were deleted, membership restored, and
project hard-delete completed successfully. This is a regrant failure, not
evidence of unintended revival. Source inspection showed edits advancing
scope revision without a new issuance sequence. The fix must distinguish
explicit renewed project consent from name-only edits or automatic renewal.

### Explicit human regrant: corrected and live-validated

Private source commits `3368c0d90e` and `a97d99800a` address two separate causes:

- Explicit manual scope edits now allocate an account-home issuance sequence
  atomically with the key update. Name/expiry edits do not; managed keys remain
  excluded from manual editing.
- Authentication no longer uses the database pool's 15-second query cache.
  That cache paired a stale authentication revision with fresh membership
  authority and also weakened persistent socket revalidation freshness.

The first fix alone was retested on disposable project
`4f87d136-f735-43a9-9f61-a5f0c5bf026a`. Metadata edits correctly retained denial,
but explicit scope approval still failed with the revision error. It was cleaned
up before the cache fix was developed.

After both fixes, the server package build passed in the private and main
checkouts. The normal dev hub restart command restarted the primary hub and
both attached bays. No project-host or tools upgrade was needed. The full
fixture passed on project `a628e578-0b83-4a40-8579-37a23f2702fd` owned by bay-0
and project `44e4de3a-1aca-43ed-a57d-f238f537a3ba` rehomed to bay-1
(operation `b16eb07d-aa38-40ab-95c9-f07428fa6efd`, succeeded).

For each project, ordinary HTTP admission through ports 9100, 13114, and 13214
proved initial access; denial after removal, restoration, and settled barrier;
fresh-key access; continued old-key denial after rename and expiry extension;
and restored old-key access immediately after explicit human scope approval.
All fixture keys were deleted, membership restored, and both disposable project
hard-deletes succeeded.

The focused server suites passed 131 tests: management, issuance ordering,
membership revocation, authoritative key state, HTTP policy, and socket auth.
The database-backed run used `COCALC_TEST_USE_PGLITE=1` and
`NODE_OPTIONS=--experimental-vm-modules`. Earlier invocations lacked the database
setup or VM-module flag and failed; they are not passing evidence. Jest used
`--forceExit`, so these results do not establish clean open-handle teardown.

This proves manual HTTP scope regrant, including distinct project-owner and
account-home bays. It does not establish managed-turn regrant, established-stream
membership revocation, outage behavior, or rendered UI scope consent.

Supplemental private review of `a97d99800a2afce22c44355f95379d7a0a85ef43`
was accepted and saved as attempt `8aac9838-f200-47d5-bbc5-131d957344b3`
(correlation `api-first-regrant-a97d99800a`). Acceptance is not review completion.

The independent input-recovery review request for source `836ac11985fc` was
accepted and saved under attempt `1bb40e88-7252-4b8b-bb83-e08f7f7836ab`
(correlation `api-first-input-836ac11985`). This is a new supplemental scope,
not a retry of previous review requests, and is not a completed review.

### Established Hub sockets after the uncached authorization fix

On 2026-09-27, source `a97d99800a` (checkout `4bd7a62667`, documentation-only
follow-up) was exercised through live ports 9100, 13114, and 13214. Each fixture
used an ordinary manual key, disabled client reconnection, established an
authorized reply subscription, verified distinct per-connection inboxes, and
verified denial of the account-wide inbox. Sockets remained connected across
the first 15-second revalidation interval before the mutation or expiry.

| Event             | Bay-0 disconnect | Bay-1 disconnect | Bay-2 disconnect |
| ----------------- | ---------------: | ---------------: | ---------------: |
| Scope replacement |        12,886 ms |        12,972 ms |        13,035 ms |
| Credential expiry |            94 ms |           135 ms |           193 ms |
| Key deletion      |        12,896 ms |        12,953 ms |        13,008 ms |

Scope/deletion durations start before the human management RPC; expiry durations
start at the credential expiry timestamp. These are three observed runs, not
worst-case load guarantees. Fixture keys and connections were cleaned up.

A separate disposable-project fixture exercised established project subscriptions
while the project belonged to bay-1 and the account/key authority remained on
bay-0. Project `59041885-b528-4c41-80be-6aa402ecd207` was rehomed successfully
by operation `4ed25a7d-3af0-4ea9-a708-91d91099557d`. Each bay had its own
scoped subscriber and publisher on one uniquely named synthetic project subject.
Initial delivery succeeded on every broker. The fixture removed membership in
the authoritative project database, confirmed old-key HTTP denial through all
bays, restored membership, waited for the barrier to settle, and issued a fresh
publisher key. Publications were attempted every 200 ms while original-key
subscriptions remained under observation for more than 32 seconds after loss.

| Entry bay | Original socket disconnect after loss | Last original-key delivery after loss |
| --------- | ------------------------------------: | ------------------------------------: |
| bay-0     |                             14,449 ms |                             14,328 ms |
| bay-1     |                             14,587 ms |                             14,527 ms |
| bay-2     |                             14,731 ms |                             14,534 ms |

The old key stayed denied after membership restoration and barrier settlement;
a fresh key worked through all bays. All fixture keys were deleted, sockets
closed, membership restored, and the disposable project hard-delete succeeded.

Fixture setup failures are not passing evidence: the first attempt supplied a
callback instead of consuming Conat's subscription iterator; subsequent attempts
assumed arbitrary subjects were delivered across bay brokers or reused the
primary human cookie on the other bays. The latter was rejected as an expired
cookie. Each failed attempt cleaned up its disposable project and keys. The
final fixture used per-bay API-key publishers and consumers instead.

This establishes bounded disconnect and delivery cessation for these live Hub
subscriptions. It does not inspect distributed RPC-interest tables, prove
cross-bay message replication, test authority outages, or establish project-host
terminal/Jupyter/sync/preview/proxy and managed-turn parity.

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
billing-authority lease query timeout at `2026-09-26T23:18:47.942Z`, generation 76. The standard dev start command recovered it as PID 1067362; attached bays
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

### Real Python kernel over scoped transport (isolated)

The project-package opt-in integration test uses CoCalc's production kernel API
to launch local `python3`, then connects it to the actual Jupyter client/service
over a broker enforcing the existing project-host API-key subject policy. Python
`input()` receives `17` through the reverse-request path; the first cell prints
`51`, and the next prints `18` from retained kernel state. A subsequent Python
exception is delivered as an error output and the next run still prints `17`.
Broad terminal-style client-subject subscription remains denied. The test closes
and awaits kernel cleanup and removes its temporary directory.

Run from `src/packages/project` with
`COCALC_REAL_KERNEL_TEST=1 pnpm exec jest conat/jupyter-scoped-kernel.test.ts --runInBand --forceExit`.
The real-kernel case plus both real-PTY cases pass (3 tests); project TypeScript
build passes. Replay storage is still a test double and the runner is a small
adapter to the production kernel, not the notebook controller. This therefore
does not prove collaborative notebook persistence, deployed CLI behavior,
mid-run reconnect, or managed-turn lifecycle. Ordinary CI skips this opt-in test
unless explicitly enabled in an environment with a local Python kernel.

### Host-token provider and inbox readiness follow-up (not deployed)

Tracing the CLI revealed that its host inbox hook reads mutable token state,
not just authenticated `info.user`. A new regression reproduced a timeout when
that provider changed before the next sign-in: recomputing both old and new
prefixes observed the new value twice. The client now compares the current hook
result with the prefix actually used to initialize its inbox.

The expanded tests also exposed a stable-prefix reconnect race: a new request
could precede restoration of its reply subscription. On a new transport
connection the client now confirms inbox subscription before exposing it to
requests. An unchanged authorized prefix retains its inbox subject and emitter;
a changed prefix gets a new one. Four cases cover stable/rotated prefixes from
both sign-in data and mutable providers, deliberately blocking subscription
restoration to verify requests do not leave early. These four cases pass, the
broader 28-test request/socket/Jupyter selection passes, and Conat builds. This
fixes shared request/reply readiness, not persistent socket session recovery.

The reconnect regression also holds an acknowledged request at the service,
reconnects with the same authorized namespace, and then delivers its response
through the restored inbox. Both stable-prefix provider variants retain the
pending listener and execute the request exactly once. The harness waits for
publication acknowledgment as well as service admission: disconnecting before
the acknowledgment instead produces a disconnected error with an uncertain
execution outcome, not evidence that the operation was rejected. No automatic
replay is added. All four inbox-rotation cases and the Conat TypeScript build
pass. This is local broker evidence, not deployed CLI/session validation.

### Attach-only terminal recovery primitive (not deployed)

The terminal API now has an explicit `attach` operation. It binds a fresh
authorized socket to an existing running session and returns its PID and bounded
history, but never creates a replacement process. Missing or ended sessions
reject before changing the socket's existing attachment. `spawn` retains its
existing create-or-attach semantics. Terminal RPC failures now use the standard
Conat error header instead of serializing an Error as successful response data;
the client also validates the returned running-session PID.

Both real-PTY scoped-transport cases pass, including fresh reply-namespace
rotation, same-PID reattachment, no extra spawn, failed attachment without
disrupting subsequent terminal I/O, and rejection after process destruction.
The 20 terminal/socket regression tests pass. This establishes an attach-only
primitive for recovery; automatic transport replacement and frontend/daemon
session recovery are not yet implemented or claimed.

### Socket requests do not replay uncertain operations (not deployed)

Recovery inspection reproduced duplicate application execution: the socket
client retried already-admitted requests after response timeouts and service
`503` errors. Both regression cases executed their handler twice before the fix.
The shared socket client now recovers readiness only before publication and
propagates request/stream-setup failures without resubmitting the operation.
Applications retain responsibility for explicit idempotency or reconciliation.
Ordered data retransmission inside an existing logical socket is unchanged.
Tests cover response timeout, an admitted service-side `503`, and a stream setup
whose publication acknowledgment is deliberately lost after admission.

### Explicit socket retirement on reply-namespace rotation (not deployed)

Inbox-return sockets now listen for the client's authenticated inbox becoming
ready. If its namespace no longer contains the socket's bound return route, the
socket closes with `closeReason: reply-namespace-changed`, removes its listener,
and clears queued transport input/output. It does not mutate the server's route
binding or transfer unacknowledged input to a new logical connection. Existing
owners receive the normal closed event and can create a new authorized socket.

The real-PTY test now leaves the old reconnect-enabled socket alive across
namespace rotation, observes automatic retirement, verifies old reads/writes
reject, then explicitly attaches a fresh socket to the same PID. Both PTY cases
and 21 socket/inbox tests pass; Conat and project TypeScript builds pass.
Automatic application-level reattachment is still not implemented by this
change; this supplies its explicit transport invalidation boundary.

### Terminal supervisor integration (not deployed)

The existing frontend terminal reconnect supervisor now recognizes
`reply-namespace-changed` on an initialized terminal and uses the attach-only
RPC on replacement clients. It retains attach-only intent across failed and
subsequent recovery attempts; no retry falls back to spawning a replacement
shell. An observed process exit or explicit runtime-replacement notice restores
the existing new-runtime behavior. Buffered, not-yet-sent UI input is released
only after attachment succeeds; obsolete socket transport buffers are not moved.

Focused component coverage invokes the registered supervisor callback after the
closed event, tests successful and failed-first attachment, and asserts no spawn
and no early input delivery. This is supervisor/component evidence combined
with the separate real-PTY transport tests, not a rendered/deployed browser
end-to-end test. CLI daemon and Jupyter/sync recovery remain separate work.

### Explicit Jupyter stream interruption (not deployed)

An unexpected socket close during a direct Jupyter run now cancels the output
iterator with `JupyterRunTransportError`, code `JUPYTER_RUN_TRANSPORT_LOST`, and
the affected `run_id`. The error explicitly leaves execution outcome uncertain;
no cell is resubmitted. Intentional client close and normal completion retain
their graceful end behavior. The frontend already drops closed cached clients
and classifies loss of the run transport separately from completion.

The scoped broker test interrupts an admitted run after its first output,
checks the typed error, lets the server finish, and queries kernel status through
a fresh client with only one runner invocation. Its kernel and replay store are
test doubles. Both scoped cases, 51 backend Jupyter tests, 15 frontend reconnect
tests, and the separate real Python-kernel test pass (69 total); Conat and project
builds pass. Resumption of the interrupted stream and deployed notebook
persistence are not established by this test.

### Bounded Jupyter run reconciliation (not deployed)

The ordinary Jupyter service now exposes `get-run`, with `JupyterClient.getRun`
for callers holding a run ID after interruption. It reads the existing project
replay store on the host; no new subscription or persistence authority is granted
to the caller. Pages have an exclusive sequence cursor, at most 100 batches
(32 by default), and at most 1 MiB of encoded response data. A batch too large
to fit is rejected rather than skipped. Concurrent replay reads are capped by
the service's run concurrency limit. Target path/run-ID lengths are bounded.

Replay is ephemeral under the existing retention policy. A missing result means
unavailable or expired, not proof that execution never happened; `done` means
the output stream ended, not that all executed code succeeded. This lookup
does not start or rerun code and does not yet implement automatic replay
consumption in CLI/agent clients.

Thirteen scoped-transport/page tests pass, covering interrupted-run lookup,
missing results, cursor/page bounds and oversized output. All 52 backend Jupyter
tests pass, including a new fresh-client pagination check using the real replay
store. That backend fixture still uses a simulated code runner; deployed
notebook persistence and end-to-end CLI resumption remain unverified.

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
