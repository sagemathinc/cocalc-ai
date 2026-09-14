# Database Schema Sync

The goal of this code is to ensure that the actual schema in the PostgreSQL
database matches the one defined in `@cocalc/util/db-schema`.

This creates the initial schema, adds new columns, and in a **VERY LIMITED**
range of cases, _might be_ be able to change the data type of a column.

## Schema and connection ownership

`syncSchema(dbSchema = SCHEMA, role?)` and
`schemaNeedsSync(dbSchema = SCHEMA, role?)` default to the registered schema
from `@cocalc/util/schema`. Callers may pass an explicit schema and role.

Each function opens its own dedicated connection and applies the optional
`SET ROLE` on that connection. It does not reuse a caller's connection or
transaction. In particular, running `SET ROLE` in a separate caller
transaction does not change the role of the synchronizer's connection.
`syncSchema` is not one all-or-nothing migration transaction: it also performs
legacy schema cleanup and the incremental convergence described below.

The normal pool startup path coordinates schema synchronization with a
session-level advisory lock. Do not treat the optional schema/role parameters
as a general-purpose isolated migration API or a tested CRM deployment recipe.

## Online invariant convergence

Schema sync runs under the database-wide PostgreSQL advisory lock in
`database/pool/pool.ts`. The synchronizer still assumes that a rolling
deployment has made old application writers compatible with a newly declared
constraint. Schema sync prevents database races; it cannot make old code that
explicitly writes invalid data compatible.

### `NOT NULL`

Changing a populated column from nullable to `NOT NULL` is a resumable online
migration:

1. Add a deterministic `CHECK (column IS NOT NULL) NOT VALID` constraint. This
   does not scan old rows, but PostgreSQL immediately enforces it for new
   writes.
2. Apply `pg_null_backfill` in bounded, `ctid`-ordered batches. Each batch
   commits independently, and locked rows are retried in another pass.
3. Validate the check constraint while normal reads and writes continue.
4. Set the column `NOT NULL`. PostgreSQL 12 and newer can use the validated
   check to avoid another full-table scan.
5. Remove the temporary check in the same transaction as the promotion.

The constraint, its validation bit, the remaining NULL rows, and the column's
nullability are the durable migration state. A process restart resumes from any
step without a separate migration ledger. A guard left after promotion or a
declaration rollback is removed automatically.

A newly added `NOT NULL` column without a default is initially added nullable
and follows this protocol. If legacy NULL rows exist and no
`pg_null_backfill` is declared, startup fails with a specific error while the
write guard remains in place.

### Indexes

Indexes created by db-schema carry an ownership fingerprint in their PostgreSQL
comment. Normal startup checks only the fingerprint plus `indisready` and
`indisvalid`, so the steady-state check remains cheap.

An existing or changed index without the expected fingerprint is compared
structurally. PostgreSQL canonicalizes the desired declaration by creating it
on an empty temporary `LIKE` table. The synchronizer compares catalog fields
including uniqueness, access method, key and included columns, expressions,
predicates, collations, operator classes, sort/null options, and null-distinct
behavior. This avoids maintaining a partial SQL parser in CoCalc.

Equivalent indexes with legacy names are adopted instead of duplicated. A
wrong same-name index is repaired by building a valid replacement with `CREATE
INDEX CONCURRENTLY`, atomically swapping names, and dropping the old index
concurrently. Intermediate replacement and stale indexes have deterministic
state, so a restart can resume or clean up the operation. PGlite uses the same
logic without `CONCURRENTLY`.

Only indexes carrying a db-schema ownership marker are automatically removed
after their declaration disappears. Unknown `_idx` indexes are preserved.
Primary-key and constraint-owned indexes are never claimed or replaced.
