# Scheduled Stop And Compute Reminder Handoff

Workspace: `/home/user/cocalc-course-funding-v2`.
Branch: `feature/course-sponsored-compute-v2`. No commit made.

## Behavior

- Existing VM create/start APIs accept `stop_after_minutes`: an integer from 1
  through 525600, or explicit `null` to disable. New configurations default to
  360 minutes. The saved choice, absolute `stop_at`, and `stop_generation` are
  persisted independently of deletion's `expires_at`.
- Owner restart establishes a new absolute deadline from the saved choice.
  Repeated running starts without a new choice preserve the current deadline;
  idempotent requests cannot slide it. Legacy untimed VMs remain compatible.
- Agent requests cannot extend, clear, or restart beyond an existing deadline.
  An owner must authorize a later deadline through the existing owner start path.
- Bay-local durable sweeps queue reconciliation, not deletion. Timer and owner
  start share a lock around provider stop dispatch, preventing stale timer work
  from stopping a renewed generation. No idle/activity heuristic is used.
- CLI create/start support `--stop-after=6h` and `--no-scheduled-stop`.
  Course create requires all three UUID flags: `--funding-payer`,
  `--funding-pool`, `--funding-grant`. An incomplete choice fails before RPC.
  Generated CLI includes the same source and refuses course source plus new
  home-volume creation before generating any create command.
- The account navbar indicator lists account-owned VMs without a project
  filter, refreshes every 15 seconds and on focus, and marks missing/failed or
  older-than-two-minute observations unknown. Dismissing the expanded reminder
  retains the compact control. A changed running-GPU VM set re-expands it.
- Account settings persist `low_credit_notifications` (opt-in, default false)
  and `low_credit_threshold_usd` (default 10, range 1..1000). The account
  notification worker scans opted-in accounts in bounded batches, only in their
  authoritative home bay, and uses hold-aware personal spendable credit.
  It emits durable in-app notices at most once per account per 24 hours, using
  transactional deduplication. Invalid/failed balance reads are retried, not
  converted to zero. Decimal light rejects nonfinite inputs in its constructor;
  the invalid `.isFinite()` call is removed and regression-tested.
- Low-credit work adds in-app notifications only. It does not add email/SMS
  channels, change funding/deletion notices, or mutate the account ledger.

## Shared-File Coordination

Main owns the student funding selector and course budget UI. `compute-vms.tsx`
scheduled edits are done: use `stop_after_minutes: number | null` in the draft
and create request; start passes the same field as the third `setVmRunning`
argument. Display `stop_at`; never substitute `expires_at`. New draft default is
360, cloning/restarting uses the saved choice. Funding remains the independent
`funding_source: CourseVmFundingSource` field owned by main.

The only additional selector-adjacent edit was the CLI-preview
`vmCreateCliProblem` guard. Main's create callback rejects course source plus
new home volume before either create RPC. No selector implementation is claimed
here. Nietzsche was notified via the shared conversation that `worker.ts`
scheduled clauses are finished/released. No finance worker clauses were undone.

## Exact Files

Paths below are relative to the workspace root. Shared files include changes
from other agents; this is an ownership manifest, not permission to stage all
their hunks.

| File                                                                        | Owned changes                                                                 |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/packages/cli/src/bin/commands/vm.ts`                                   | Scheduled-stop and funding flags, validation, lifecycle summary               |
| `src/packages/cli/src/bin/commands/vm.test.ts`                              | Stop/funding CLI regression tests                                             |
| `src/packages/conat/hub/api/compute.ts`                                     | Stop fields and create/start contract only                                    |
| `src/packages/frontend/project/compute-vms.tsx`                             | Stop create/start controls, saved choice, deadline display, CLI preview guard |
| `src/packages/frontend/project/compute-vms-cli.ts`                          | Stop/funding CLI generation and pre-create validation                         |
| `src/packages/frontend/project/compute-vms-cli.test.ts`                     | CLI generation tests                                                          |
| `src/packages/frontend/project/compute-vm-stop-after.tsx`                   | Accessible stop duration control                                              |
| `src/packages/frontend/project/compute-vm-stop-after.test.tsx`              | Keyboard/default/opt-out tests                                                |
| `src/packages/frontend/app/running-gpu-indicator.tsx`                       | Account-wide status, polling, stale state, reminder dialog                    |
| `src/packages/frontend/app/running-gpu-indicator.test.tsx`                  | Keyboard, focus, unknown, stale request, account switch, re-alert tests       |
| `src/packages/frontend/app/post-surface-right-nav.tsx`                      | Navbar integration                                                            |
| `src/packages/frontend/account/low-credit-notification-setting.tsx`         | Persisted notification opt-in and numeric threshold                           |
| `src/packages/frontend/account/low-credit-notification-setting.test.tsx`    | Keyboard preference tests                                                     |
| `src/packages/frontend/account/account-preferences-communication.tsx`       | Preference integration                                                        |
| `src/packages/frontend/account/types.ts`                                    | Two other-settings types                                                      |
| `src/packages/server/compute/scheduled-stop.ts`                             | Policy, atomic state/event/queue transaction, due sweep                       |
| `src/packages/server/compute/scheduled-stop.test.ts`                        | Policy, durability, provider stop, concurrency tests                          |
| `src/packages/server/compute/db.ts`                                         | Persist stop columns on create                                                |
| `src/packages/server/compute/db.test.ts`                                    | Persistence/idempotent create test                                            |
| `src/packages/server/compute/schema.ts`                                     | Idempotent stop schema migration and due index                                |
| `src/packages/server/compute/types.ts`                                      | Stop row types                                                                |
| `src/packages/server/compute/worker.ts`                                     | Schema startup, sweep, live dispatch and generation lock                      |
| `src/packages/server/conat/api/compute.ts`                                  | Stop create/start integration after existing authorization                    |
| `src/packages/server/notifications/low-credit.ts`                           | Account-home notification maintenance                                         |
| `src/packages/server/notifications/low-credit.test.ts`                      | Opt-in, authority, dedupe, unknown balance tests                              |
| `src/packages/server/projections/account-notification-index-maintenance.ts` | Low-credit worker lifecycle integration                                       |
| `src/packages/util/compute-notifications.ts`                                | Shared preference keys/defaults and threshold validation                      |
| `src/packages/util/db-schema/accounts.ts`                                   | Preference defaults and opted-in scan index                                   |
| `src/packages/util/db-schema/compute-vms.ts`                                | Stop schema fields                                                            |
| `src/scripts/accessibility/scenarios.json`                                  | Integrated account GPU dialog audit scenario                                  |
| `src/.agents/scheduled-stop-handoff-2026-09-12.md`                          | This handoff                                                                  |

## Verification

- Server PostgreSQL: **94 passed, six suites**. Suites: compute
  `scheduled-stop`, `schema`, `worker`, `db`; notifications `low-credit`;
  projections `account-notification-index-maintenance`.
- Same suites on PGlite: **89 passed, five PostgreSQL-only concurrency tests
  skipped**. All five passed against PostgreSQL.
- Frontend: **21 passed, four suites**: `running-gpu-indicator`,
  `low-credit-notification-setting`, `compute-vm-stop-after`, `compute-vms-cli`.
- CLI `node --test build/test/cli/src/bin/commands/vm.test.js`:
  **43 passed, 16 suites**.
- Server `pnpm tsc --build`: passed after the Decimal fix and finance updates.
- Frontend typecheck and lint passed earlier; latest final attempts encountered
  the concurrently edited `frontend/purchases/credit-transfers.tsx` syntax error
  at line 116. This file is not part of this change-set.
- Util, Conat, database and CLI package builds passed earlier. Final CLI test
  compilation (`pnpm tsc -p tsconfig.test.json`) passed after the transient
  concurrent Conat `AccountLocalMethod` credit-transfer errors were resolved.
- Scoped frontend oxlint passed on all 12 touched frontend files: zero warnings
  and zero errors. Full frontend lint is still blocked by the unrelated syntax
  error noted above; the earlier full run passed before that file was added.
- `pnpm -C src accessibility:test`: **7 passed**.
- Standalone Playwright/axe audit: light and dark themes at 1280, 640 and 320
  CSS pixels, both control and open-dialog states; **zero axe violations,
  horizontal overflow, or runtime errors**. Keyboard open/Escape/focus restore
  passed. The low-contrast secondary timestamp found by this audit was fixed.
- Browser audit fixture and generated results/screenshots are local artifacts:
  `src/.local/compute-reminders-audit.cjs` and
  `src/.local/compute-reminders-audit/`. These use mocked RPC/account hooks, not
  a hub. The integrated full-navbar scenario was added but not run against the
  live original hub. Narrow CSS widths include the reflow equivalent of zoom;
  browser-native 200% zoom was not separately tested.
- Prettier, dependency version check and `git diff --check` passed.

No production operations, VM provisioning, live hub restart, or commit occurred.
Database tests used a private PostgreSQL instance, never the original hub DB.
The private PostgreSQL server is stopped and its temporary data directory removed.
