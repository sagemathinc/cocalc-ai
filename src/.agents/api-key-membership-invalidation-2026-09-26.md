# API-key membership invalidation

Status: implementation contract, not implemented or live-verified.
Baseline inspected: `6ecc6806554f7da41c6aee5680fe60c37956da50`.
This closes a requirement in phases 1-4 of the API-first connector plan; it
does not replace or relax that plan's acceptance matrix.

## Evidence

`server/api/project-host-api-key.ts` checks the current key revision and current
project membership before issuing a child token. An isolated test that changes
the project reference from collaborator to absent and back to collaborator
accepts the same key again. The test mocks account-home key state; it establishes
the exchange behavior, not a live end-to-end exploit.

`database/postgres/account/collaborators.ts` removes members transactionally and
appends project events. `server/projects/collaborators.ts` also changes roles
through direct SQL. These inspected paths do not persist permanent API-grant
invalidation. `database/postgres/schema/project-runtime-authority-revision.ts`
already installs a membership-change trigger, but its revision alone does not
bind parent API keys to membership history.

## Required Semantics

- Removing or downgrading a full collaborator invalidates that person's existing
  API grants for the project, including grants from an all-projects scope.
- Re-addition does not restore those grants. Other projects remain usable.
- A newly issued key or an explicit human-approved scope edit can grant access
  again. Routine managed-key renewal must not reset invalidation.
- Ordinary browser authority remains governed by membership. This extra barrier
  applies to API delegation, not to whether a human can rejoin their project.
- Existing child tokens and sessions still obey the documented revocation bound.

## Durable Ordering

Use an account-home monotonic **issuance sequence**, allocated in the same
transaction as key creation or an explicit scope edit. Store it on the key.
Renewal preserves it. Carry the sequence and its account-owned allocator through
account migration; do not reuse bay-local API-key row IDs or compare wall clocks
between bays. Represent database BIGINT values without JavaScript precision loss.

At the project-owning database, extend the existing membership-change mechanism
to record a pending revocation for each account losing full collaborator access.
Record it in the same transaction as the membership mutation, including direct
SQL mutation paths. Preserve the record through re-addition and project rehome.
Metadata-only edits must not invalidate grants.

While that record is pending, API-key access for that account/project fails
closed. A trusted worker resolves the account's current home and captures its
issuance high-water mark under the same serialization used for issuance. The
project owner then installs that cutoff and clears only the matching pending
generation. Requests using sequences at or below the cutoff remain denied after
re-addition. A later loss records a new pending generation and advances the
cutoff; stale acknowledgments cannot clear it.

Keys created during the pending interval can conservatively fall below its
cutoff. Report this as revoked delegation, requiring a new key or explicit scope
edit. Never silently retry with another credential. This avoids enumerating all
projects when creating an all-projects key or relying on whether a key happened
to access the project before removal.

Legacy keys require a defined sequence-zero interpretation. The first loss
must invalidate them too. Unsupported/unknown barrier state must fail closed
for scoped API access, not be interpreted as an unrestricted legacy grant.

## Integration Boundaries

1. Shared schema: account allocator, key sequence, and project revocation state;
   ownership, migration, and bounded indexing/retention rules.
2. Issuance: manual creation, human scope edits, and trusted turn issuance use the
   same allocator. Directory entries are locators, not sequence authority.
3. Membership mutation: capture removals and collaborator-to-viewer downgrades
   at the database boundary, with rollback and retry semantics.
4. Trusted cross-bay processing: current-owner routing, exact generation binding,
   durable retries, and no client-supplied account/sequence assertions.
5. Shared authorization: HTTP project admissions, Hub Conat project subjects,
   and host exchange consult the project barrier and authoritative key sequence.
   The host/session gate retains bounded authority and cannot renew past denial.
6. Audit/maintenance: retain cutoffs while old keys could still be presented.
   Do not delete negative authority merely because a member was re-added.

## Acceptance Gates

Test both manual and managed keys, explicit and all-projects grants, including
keys never used before removal. Cover removal/re-addition without an intervening
API call, downgrade/upgrade, unrelated-member changes, concurrent issuance and
scope editing, renewal, multiple successive losses, duplicate/stale delivery,
account/project migration, unavailable homes, and process restart. Verify other
project grants survive. Use transaction tests plus live two-bay tests; a mocked
exchange test alone cannot establish this contract.
