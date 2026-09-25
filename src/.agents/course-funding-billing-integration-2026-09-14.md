# Course Funding and Billing Authority Integration

Integrates `origin/main` at `8260856afb` into
`feature/course-sponsored-compute-v2`. This is an integration checkpoint, not
independent security review or authorization to enable customer sponsorship.

## Execution Boundary

- Course funding Hub API calls enter the existing billing command dispatcher.
  Independent financial approval remains on its separate origin; its final
  application is a server-only authority command, not a new browser or agent RPC.
  Independent sign-in is checked again when the queued command executes.
- Approval retries bind to the payer, reviewed intent, terms, and independent
  session. They return the same durable result without applying an allocation or
  consent twice. A different session does not replay a failed sign-in result.
- Monthly collection, transfer reconciliation and refund reconciliation join
  the existing bounded maintenance dispatcher. Resolved accounts are registered
  before financial work so authority account freezes apply. Collection selection
  filters ineligible statements before its batch limit.
- Existing account/pool reservations, account-home locks, captured-payment
  fulfillment and prepaid backing checks remain in force. The authority does not
  replace these domain transactions or the dedicated-host metering exception.
  New sponsored admission/renewal checks reject frozen payers; already-incurred
  settlement and funded cleanup must remain possible.

## Membership Compatibility

Canonical request identities, administrator course quoting, and historical
request hashes from main are retained alongside v2's atomic captured-payment
fulfillment. Fulfillment reacquires the local course-project ownership fence.
Completed historical purchases remain idempotent. Historical unpaid non-card
intents retain their approved snapshot when converted into the new order record.

An unresolved old card intent is deliberately not charged under a new order's
Stripe idempotency identity. It requires operator reconciliation of the old
invoice/payment before another order. This is a fail-closed upgrade case, not an
automatic migration of unknown provider outcomes. Do not delete such an intent
just to clear the error; first reconcile or refund the original payment and its
local fulfillment state.

## Deployment

The upstream billing authority is default-off and initially supports standalone
or seed-local operation only. Its authenticated attached-bay transport is not
implemented upstream. This integration does not introduce an inter-bay bypass.
Authority-enabled account funding operations reject attached-bay execution.

Lite2b currently has three bays. The merged code is installed there without
changing the activation flag, sponsorship rollout gates, or customer settings.
Authority-enabled operation was tested in the existing isolated one-bay
development database and compute namespace instead. Production activation requires the
coordinated stop/drain procedure in `docs/billing-authority.md`; do not activate
the authority on a multibay installation.

All three lite2b hubs were stopped and restarted on the merged code. The online
project host completed its project-host, project, tools, and bootstrap upgrade;
bootstrap reconciliation reports no drift. The public frontend manifest exactly
matches the local production-style build at `8d76afaae3`. Runtime bundles were
built from the merged worktree before the merge commit was recorded, so the
project-host build identifier includes the previous revision and `dirty`; this
is not an old unmerged bundle. Installed versions match the requested artifacts.
The public landing and sign-in pages rendered with no failed script responses;
the sign-in screenshot was inspected. An authenticated command executed in the
running validation project after the host upgrade. All three hub HTTP endpoints
responded successfully.

## Validation

- Full development build and server typecheck passed. Frontend lint and
  dependency consistency passed; the focused frontend run passed 29 tests.
  Documentation passed 18 registry tests and six executable example tests.
- A fresh dedicated PostgreSQL 18 instance passed 226 tests across 17 suites:
  authority fencing/queue/retry, independent approval, frozen accounts,
  membership compatibility, captured payments, refunds, transfers (including
  multibay cases with activation off), pool transactions, closure, and consent.
  Earlier closure failures were caused by thousands of unrelated retained
  fixtures in the shared test database exhausting a single bounded worker pass;
  no production bounds or shared test records were changed to make tests pass.
- An additional PostgreSQL run passed 107 tests in five suites for VM funding,
  personal fallback, multibay sponsorship, recovery, and volume funding. The
  PGlite run passed its 85 applicable tests. A cross-backend lock-wait test now
  explicitly requires PostgreSQL, like the existing multibay suite; its lock
  assertion is unchanged and passed against PostgreSQL.
- The merged isolated one-bay hub ran with authority activation on, one serving
  lease, and successful maintenance commands. Instructor allocation was approved
  through actual independent password/MFA sign-in. The student selected that
  allowance and created a disposable GCP CPU VM. It reached ready, stopped on its
  three-minute timer, and was deleted through the normal API. Final metering
  closed the reservation and pool and released its backing. Its short run
  correctly rounded to zero cents. A second CPU VM ran long enough to post one
  cent, attributed to the instructor rather than the student, and was then
  deleted through the normal API. Normal egress finalization closed its
  reservation. Independently approved instructor closure returned USD 1.99 from
  that USD 2 allocation, leaving zero reserved funds and exactly one USD 0.01
  purchase on the instructor's ledger, with no charge to the student.
- A USD 10 Stripe test-mode purchase produced one USD 10 credit, including after
  repeated processing. A separately approved USD 1 credit transfer produced one
  receipt for each QA account; replay did not duplicate it.
- Actual browser checks for monthly collection passed scoped axe and overflow
  checks at 320/720/1440 widths in light/dark themes. The narrow dark-mode
  screenshot was inspected. Consent was not enabled by this audit.

Deployment and these integration checks are complete. The provider inventory
reconciler confirmed zero remaining QA instances, disks, public addresses, or
orphans after cleanup. The disposable PostgreSQL test server was stopped; the
isolated QA and lite2b development hubs remain available. Production was not
deployed and customer sponsorship was not enabled.

These checks do not substitute for independent review, the full acceptance
matrix, or production pilot authorization.
