# Local CRM and AR fixtures

Run against the **local seed bay database**, using the same database environment
as that hub. Never point this at staging or production. This is an offline
development fixture tool, not a new supported administrative mutation API.

From `src/packages/server`, after building:

```sh
pnpm customer:fixtures --actor <local-admin-account-uuid>
pnpm customer:fixtures --actor <local-admin-account-uuid> --apply --confirm seed-local-customer-fixtures
```

Default is a database-free dry run. `--as-of 2026-09-05T00:00:00Z` makes dates
repeatable. Apply rejects production, remote databases, attached bays, and
non-admin actors. Inserts are atomic. Stable IDs make reruns insert-only: they
do not overwrite UI edits or duplicate records. There is intentionally no broad
delete/reset command; use a disposable dev database snapshot to reset workflows.

The dataset includes 24 organizations, people, email addresses, relationships,
opportunities, tasks, activities, manual draft AR orders, line items and billing
contacts. Names are marked `[DEV FIXTURE]`; addresses use `example.invalid`.
Lifecycle stages, pipeline stages, priorities, overdue/future tasks, long labels
and multiple pages can be audited using normal admin screens.

No accounts, Stripe/Zendesk IDs, invoices, payments, licenses, provider jobs,
outreach batches or customer entitlements are created. Draft orders deliberately
do not pretend to be paid or overdue without the corresponding accounting data.
Do not send, provision, or connect fixture records to real provider objects.
Feature flags are not changed by this tool. For visual testing enable CRM/AR
visibility and local mutations; leave automated outreach delivery disabled.
