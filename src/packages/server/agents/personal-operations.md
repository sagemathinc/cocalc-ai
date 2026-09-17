# Personal Messaging Operations

Personal messaging is opt-in (`COCALC_AGENT_PERSONAL_MESSAGING_ENABLED=1`).
Its names, rename tombstones, grants, controls, and approval history are
authoritative on the execution principal's account home. Existing shared
grants are not migrated or used as fallback in personal mode.

## Account Rehome Limitation

Account rehome currently fails closed if any of the four `agent_personal_*`
tables retain rows for that account. This includes retired names, revoked or
expired grants, controls, and terminal approval history, even after the feature
is disabled. The error is explicit; do not delete retained state to bypass it.
Accounts without personal state retain the existing rehome behavior.

The guard runs under the canonical account-rehome advisory fence before a new
operation and before resuming an incomplete operation. Personal mutations and
authorization snapshots use that same transaction fence and reject running
rehomes or stale home ownership. Read routes also check account-home authority.

Full portability requires a versioned destination acknowledgment before source
cleanup, plus copy/delete support for all four tables, including request aliases
and name tombstones. The existing copy RPC's void acknowledgment is insufficient
to ensure an older destination retained these new tables.

## Denial Transport

Expected personal authorization denials cross inter-bay RPC as typed
`{ denied: PersonalAgentDenialCode }` data, not exceptions. The recipient maps
that result to a rejected send before host submission. Unexpected transport or
authority failures remain fail-closed; a lost acknowledgment after host
submission remains unknown and is not retried automatically.
