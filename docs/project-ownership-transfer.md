# Explicit Project Ownership Transfer

An owner can choose an existing full collaborator in the project's Collaborators
panel and confirm **Transfer ownership**. The previous owner remains a
collaborator. Viewers and pending invitees are not eligible.

The CLI equivalent requires the expected current owner and explicit confirmation:

```sh
cocalc auth elevate
cocalc project transfer-ownership --project PROJECT_ID \
  --from CURRENT_OWNER_ACCOUNT_ID --to COLLABORATOR_ACCOUNT_ID --yes
```

The typed Conat method is `projects.transferProjectOwnership`. Owners and
administrators require fresh interactive authentication, including a recent
second factor when enabled. Public input cannot grant administrator authority.
Stale current-owner confirmations fail without changing ownership. To leave
after transferring, the previous owner can use the normal leave workflow.

## Attribution and Capacity

Usage attribution and runtime sponsorship derived from the former owner move to
the recipient. Independently assigned payers remain unchanged, including an
implicit student-course usage payer. Project placement and files do not move.

The recipient's home bay rejects missing, deleted, or banned accounts. When
usage attribution increases the recipient's project count, it checks the
membership project allowance against authoritative usage counts from every
configured owning bay. An unavailable bay fails the check; zero-delta attribution
changes do not consume an extra project slot. Administrators do not bypass this
check.

This is a capacity preflight, not a distributed reservation against concurrent
creation/transfers. It does not reserve storage or runtime capacity. Owners
should confirm capacity and billing responsibility with the recipient first.

## Consistency

The actor's home bay checks fresh authentication and administrator status, then
routes to the project's owning bay without forwarding session credentials. The
owning bay locks the project, validates the expected owner and recipient role,
checks the rehome fence, updates membership/attribution, and writes both a
membership outbox event and a `project-ownership-transfer` central audit record
in the same transaction. The audit includes actor, old/new owner, retained-owner
status, and before/after attribution. Both members receive refreshed projections
and the project host receives updated membership.

Legacy automatic transfers during project leave/account deletion still remove
the old owner and retain their existing attribution and admission behavior.
