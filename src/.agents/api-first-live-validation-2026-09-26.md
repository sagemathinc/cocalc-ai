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
