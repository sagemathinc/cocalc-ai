# Managed Egress Rollup Plan

## Motivation

`account_managed_egress_events` is currently an append-only raw event table and
has become a major source of load on the central bay PostgreSQL database. On
prod, it had grown to roughly 18M rows / 14GB, with thousands of rows inserted
per minute. Most rows are not rare user-initiated external egress; they are
high-volume accounting for internal/browser/control traffic such as
`interactive-conat`.

Managed egress is used for throttling and abuse control, not billing. Exact
per-event accounting is not required. It is acceptable to be slightly off in the
user's favor if database load is significantly lower.

## Goals

- Make throttling and admin views query compact rollups instead of raw events.
- Avoid raw writes in the hot path.
- Preserve useful diagnostics via compact rollup rows.
- Avoid any required backfill before deployment.
- Keep the first rollout safe for staging validation.

## Schema

Add `account_managed_egress_rollups` with one-minute buckets:

- `bucket_start TIMESTAMPTZ`
- `account_id UUID`
- `project_id UUID`
- `category TEXT`
- `bytes BIGINT`
- `event_count INTEGER`
- `first_occurred_at TIMESTAMPTZ`
- `last_occurred_at TIMESTAMPTZ`
- `metadata_sample JSONB`

Use a primary key on `(bucket_start, account_id, project_id, category)`.
Account-only traffic uses the sentinel project id
`00000000-0000-0000-0000-000000000000`, because PostgreSQL unique constraints
treat `NULL` values as distinct.

## Ingestion

Managed egress records are coalesced in memory by
`bucket_start/account_id/project_id/category`. Each hub process flushes pending
rollups at most once per minute, or sooner if there are many distinct pending
keys. Flushing uses a single `jsonb_to_recordset` +
`INSERT ... ON CONFLICT DO UPDATE`, incrementing `bytes` and `event_count`.

Raw event writes are disabled in the hot path. This trades per-event precision
for a large reduction in PostgreSQL write volume, which is acceptable because
managed egress is used for throttling/abuse control rather than billing.

## Reads

Quota/throttling reads use rollups. Admin overview/history/account history also
use rollups for totals, buckets, top accounts, and top projects.

Recent event lists read the newest rollup rows using `last_occurred_at` and
`metadata_sample`.

`interactive-conat` is stored in rollups for operator/debug queries but excluded
from quota and the normal managed-egress views. It is browser/control-plane
traffic, not actual project egress.

## Retention

The old raw event table can be aggressively pruned after prod confidence.
Rollups can be retained much longer, e.g. 30-90 days. A follow-up maintenance
task should periodically delete old raw rows and old rollups.

## Rollout

1. Deploy code to staging.
2. Confirm new rollup rows are created.
3. Confirm `interactive-conat` creates rollups but is excluded from quota/views.
4. Confirm managed egress usage and admin pages show new rollup traffic.
5. Deploy to prod.
6. After prod confidence, truncate or delete old raw events in a maintenance
   window.
