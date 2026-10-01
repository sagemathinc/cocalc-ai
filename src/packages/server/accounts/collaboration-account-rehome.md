# Collaboration Account Portability

`rehome.ts` transfers collaboration state through the existing account-local
accept/copy/status RPCs. Project ownership, project source epochs, and project
rehome are separate protocols.

## Authority And Retry

Source creation holds the canonical account-rehome transaction fence, installs
an immutable paginated snapshot, and commits its `frozen` receipt with the source
operation. Coordinator failure does not release that fence. Operators retry the
same operation; starting a different operation while frozen fails closed.

The destination checks the manifest against the committed source operation and
the account-home directory before first acceptance. Its receipt progresses
`accepted -> imported -> active`. Pages are ordered, individually hashed, and
bound by a rolling snapshot hash. Repeated pages must match their durable hash.
Incomplete or conflicting transfers cannot activate. Import is transactional;
existing account/file copy remains retryable under a separate serialization lock
shared with activation. A late retry cannot overwrite an activated account.

After destination import, the source retires personal rows and pending delivery
state, preserving a durable `retired` fence. Only after directory convergence and
the source's `directory_updated` checkpoint can the destination activate. Both
the common account-write fence and SQL triggers reject stale collaboration writes,
including maintenance paths that do not use the application helper. Return moves
replace a retired receipt only after validating a new authoritative handoff.

## State

- Personal aliases, collection, explicit follow/mute choices, read/notification
  floors, recipient epochs, and mention state retain their values.
- Artifact compatibility bindings retain their stable resource and Library keys.
- Notification cursors retain generation and position; worker claims, failure
  counters, and error messages are reset.
- Collaboration notification graph IDs, dedup keys, and pending outbox rows move
  with the account. Pending delivery becomes eligible only at activation. When
  financial rehome is enabled, that existing protocol remains the sole copier of
  its broader notification graph; collaboration cursors still use this protocol.
- Resource indexes and access leases/grants are never copied. Activation creates
  empty work items from retained project identities, with no generation or lease.
  Current owners must authorize and rebuild them before resources are visible.
  This also prevents cursor pruning from mistaking an unseeded home for revocation.
- The destination invalidation revision advances beyond both prior revisions.

## Notification Maintenance

Cursor seeding, claiming, retry updates and orphan pruning acquire account fences
without waiting, then recheck durable handoffs before writing. Frozen, incoming
and retired accounts are skipped rather than failing an unrelated account's
batch. Financial and legacy running-operation fences remain effective.

Persistent keyset checkpoints advance over examined rows, including skipped
accounts: at most 500 seed candidates, 64 claim candidates and 200 prune
candidates per scan. Claiming wraps once if its checkpoint reaches the end;
seeding and pruning wrap on subsequent passes. This prevents frozen prefixes
from starving later accounts and revisits accounts after activation. Claim keys
retain PostgreSQL timestamp precision, avoiding repeated fractional-time rows.

## Limits

Each page has at most 200 rows and 256 KiB. The immutable snapshot is bounded by
128 MiB, 400,000 rows and 4,096 pages; oversized state or incompatible schemas
abort before source cutover rather than discard data. Snapshot payloads are
discarded after retirement/activation; page hashes and the latest handoff remain
for retry and stale-operation detection. Old in-flight operations without a
snapshot fail closed if they retain collaboration state.

Recovery uses the existing forward-reconcile operation, not a new administrative
abort/unfreeze RPC. Failed SQL imports roll back atomically; failed transport or
cutover attempts leave durable fences in place until that operation resumes.

Unrelated native personal-agent, network, personal-Library and external-agent
portability guards remain unchanged. Financial portability remains governed by
its existing flag and guards. No files are scanned and no project compute starts.
