# API-first live validation, 2026-09-26

Implementation tested: `8856762c4c7327c2318e019013f23f4e3142bec7`.
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

## Still unverified or incomplete

- Live membership removal/re-addition, source-turn invalidation, and explicit
  human-approved regrant behavior.
- Home outage, migration, stale directory faults, and clustered RPC-interest
  withdrawal; no claims about these follow from ordinary three-bay connectivity.
- Full-runtime CLI command parity, long-running sync/Jupyter/terminal sessions,
  cancellation/crash races, and the entire manual/managed acceptance matrix.
- Historical database upgrades beyond this dev stack's successful startup.
- Shared editor theme/mobile/keyboard checks and approval resource budgets.

Existing unrelated billing maintenance logged a missing billing account during
startup. No billing records were changed to address that message.
