# Legacy Migration Security Audit - 2026-06-29

Status: actionable audit pass completed for the project restore and financial
migration paths before production enablement.

## Scope

- Legacy project listing/import/restore APIs in
  `src/packages/server/legacy-migration`.
- Legacy financial preview/apply APIs in the same package.
- Browser-facing Conat API auth binding in
  `src/packages/conat/hub/api/legacy-migration.ts`.
- Seed-bay routing wrapper in
  `src/packages/server/conat/api/legacy-migration.ts`.
- Import tooling in `src/packages/server/legacy-migration/import-dump.ts`.

## Findings And Fixes

### Project access authorization

Risk: a user migrates a legacy project they should not be able to access.

Current state:

- Browser Conat API uses `authFirstRequireAccount`, which overwrites any
  caller-supplied `account_id` with the authenticated account id.
- Migration APIs route to the seed bay, so legacy dump data is checked in one
  global authority.
- Account links are created from verified current account emails matched to
  verified legacy account emails. Unverified matches are shown only as a prompt
  to verify email.
- Project authorization requires the linked legacy account to be the legacy
  owner or to appear in the legacy project users map.
- Deleted/hidden legacy projects are excluded during dump import and from
  normal listing.
- Sparse artifact-only rows do not authorize access because they do not include
  owner/user membership.

Residual risk:

- Gmail canonicalization intentionally treats dotted and plus-address Gmail
  variants as the same identity. This is useful for real users but should remain
  explicitly documented as an intentional policy.
- Any legacy collaborator can import a shared project first, becoming owner of
  the new project; later authorized legacy collaborators join as collaborators.
  That does not leak data beyond old collaborator access, but it changes
  ownership semantics for shared projects.

### Project migration resource abuse

Risk: a user creates too much work at once and overloads the hub/project hosts.

Fixes in this pass:

- One import RPC now accepts at most 50 unique legacy project ids.
- Selective restore include/exclude path lists now accept at most 1000 paths.
- Selective restore path entries are capped at 4096 characters and reject NUL.

Existing mitigations:

- Full restores are queued and the restore worker limits total and per-host
  parallelism.
- Full restores run on project hosts and use signed object downloads; the hub
  does not proxy archive bytes.
- Project-host archive restore validates member paths, blocks absolute and
  parent-directory archive entries, and excludes managed sensitive roots such as
  `.cache/cocalc`, `.local/share/cocalc`, `.snapshots`, `.smc`, and managed SSH
  files.
- Restore creates migrated-project disk entitlement overrides based on actual
  restored usage plus headroom, reducing accidental lockout.

Residual risk:

- A user with many legitimate legacy projects can still enqueue many restores
  over multiple RPC calls. This is probably acceptable for launch, but should be
  monitored by restore queue depth, per-account queued restore count, and host
  restore concurrency.
- Selective restore still depends on project-host tar/indexing limits for
  archive-internal size and file-count abuse.

### Financial migration authorization and idempotency

Risk: a user claims credit/subscription value for a legacy account they do not
own, or claims it more than once.

Current state:

- Financial rows are derived only from linked verified-email legacy accounts.
- Claimed legacy financial accounts are keyed by
  `legacy_migration_financial_claims.legacy_account_id`, so each legacy account
  can be applied once.
- Credit creation uses deterministic invoice ids
  `legacy-migration-credit:<legacy_account_id>`, and `purchases.invoice_id` is
  unique, so credit balance replay is independently idempotent.
- Amounts are computed server-side from imported raw legacy records; the client
  only selects membership class/interval.

Fixes in this pass:

- Home-bay legacy membership grant creation now takes a per-account transaction
  advisory lock.
- The home-bay apply step now treats any historical legacy-migration membership
  grant as already used, even if expired. This prevents duplicate 30-day grants
  if the seed bay retries after a partial failure.

Residual risk:

- The seed bay still calls the home bay while holding a transaction. This is
  operationally fragile under long network stalls, though the independent credit
  invoice id and home-bay membership-grant idempotency now protect value replay.
- `applying` rows can block a claim if a future change commits them before
  finishing. If we ever split the seed claim into multiple transactions, add an
  explicit stale-claim retry/reconciliation path.

## Production Checks To Watch

- Legacy project import RPC errors containing the new per-call cap message.
- Restore queue depth, restore failures, and per-host active restore count.
- Count of `legacy_migration_financial_claims` by status.
- Duplicate or multiple `subscriptions` rows per account with
  `metadata->>'source_id'='legacy-migration'`.
- Purchases tagged `legacy-migration-credit` where the same invoice id appears
  more than once; the unique index should make this impossible.

## Follow-Up Hardening

- Add a per-account queued restore limit if queue depth becomes a production
  problem.
- Add a reconciliation/admin report for home-bay legacy grants or credits that
  exist without a corresponding seed-bay applied claim.
- Consider preserving legacy owner role when multiple verified legacy
  collaborators import the same shared project.
- Add explicit migration audit events for each project import, restore start,
  restore finish, financial claim, credit id, and membership grant id.
