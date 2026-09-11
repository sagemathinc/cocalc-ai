# Accounts Receivable Operations

This runbook is also packaged with every CoCalc CLI build so admins and agents
can read it without access to the source checkout:

```sh
cocalc docs show admin/accounts-receivable --include-admin
cocalc docs search "accounts receivable" --include-admin
cocalc docs skill-context --query "accounts receivable" --include-admin
```

CoCalc's commercial-order workflow is the shared source of truth for
sales-assisted agreements, invoicing, payment collection, and fulfillment.
Stripe delivers invoices and accepts payment. Zendesk records customer
communication. Neither replaces the commercial order.

## Authority And Access

Commercial tables are seed-global. Public Conat requests may originate on any
bay, but all reads and writes route to the cluster seed. Launchpad follows the
same route with its only bay acting as seed.

The initial authorization policy is:

- Admin membership is required for every operation.
- Financial, approval, migration, and fulfillment mutations require fresh
  authentication and reject impersonation.
- Every read and mutation requires a human-readable audit reason.
- Mutations use `expected_version` and a stable idempotency key.
- CLI mutations preview by default and require `--commit` for effects.

Never include payment credentials, bank account details, card details, or full
provider payloads in an order, note, evidence reference, or audit reason.

## Rollout Controls

Enable these site settings independently under **Billing & Commerce / Accounts
Receivable**:

| Setting                                                | Effect                                                                             |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `commercial_receivables_visible`                       | Admin queue, detail, audit, preview, and diagnostics reads.                        |
| `commercial_receivables_mutations_enabled`             | Order creation, editing, assignment, notes, approval, cancellation, and backfill.  |
| `commercial_receivables_stripe_drafts_enabled`         | Stripe invoice draft creation and reviewed adoption of an existing Stripe invoice. |
| `commercial_receivables_stripe_quotes_enabled`         | Stripe quote preview and draft creation.                                           |
| `commercial_receivables_stripe_quote_finalize_enabled` | Stripe quote finalization and PDF retention.                                       |
| `commercial_receivables_stripe_quote_accept_enabled`   | Stripe quote acceptance and draft-invoice conversion.                              |
| `commercial_receivables_stripe_send_enabled`           | Stripe invoice finalize/send and void.                                             |
| `commercial_receivables_manual_settlement_enabled`     | Recording externally verified checks, wires, or other manual settlements.          |
| `commercial_receivables_reconciliation_enabled`        | Manual reconciliation, durable webhook processing, and scheduled reconciliation.   |
| `commercial_receivables_fulfillment_enabled`           | Site-license linking, provisioning, and ending fulfillment.                        |

All controls default off. Normal rollout enables visibility first, then order
mutations, Stripe quote creation in test mode, quote finalization, quote
acceptance, Stripe invoice send, reconciliation, and finally
fulfillment/manual settlement. Rollback should disable effectful controls
while leaving visibility enabled.

Stripe requires Invoicing Plus for live-mode one-time quote finalization, PDF
download, and acceptance. Confirm the production Stripe subscription before
enabling either quote finalization or acceptance. The three quote controls are
independent so an admin can leave acceptance disabled after enabling reviewed
draft creation and finalization.

## Standard Workflow

1. Create an order from reviewed terms. Record the organization snapshot,
   billing contact, exact line items, service dates, linked Zendesk tickets,
   owner, next action, and due date.
   Select the next action from the standard receivables task list. Put
   customer-specific instructions and context in an audited internal note.
2. If procurement needs a formal pre-PO document, choose a Stripe-native quote
   or the local PDF fallback. Preview the exact terms before creating or issuing
   it. Finalize a Stripe quote only after reviewing its provider state and PDF.
   Do not accept it until an authorized customer has explicitly accepted those
   terms.
3. Approve the order after validating the customer agreement and delivery
   details.
4. Preview the invoice. Resolve every blocker before creating a Stripe draft.
5. If a Stripe quote was accepted, use its generated draft invoice. Otherwise,
   create a draft invoice. Neither path sends automatically.
6. Review the Stripe customer, contact, line items, total, currency, Net 21 (or
   explicit negotiated) terms, PO/reference fields, and test/live mode.
7. Send the invoice with fresh auth and the current order version.
8. Preview and provision the site license. Provision-before-payment is allowed
   only with the explicit reviewed flag.
9. Let Stripe webhooks update payment state. The scheduled reconciler repairs
   dropped or out-of-order webhooks.
10. The order becomes complete only when its configured collection and
    fulfillment requirements are both satisfied.

Collection and fulfillment are intentionally independent. Provisioning a site
license does not mark an invoice paid, and payment does not provision a license.

## Stripe-Native Quotes

CoCalc remains the source of truth for commercial terms and the durable quote
identity. Stripe owns the provider state and generated PDF. A Stripe quote
moves through these reviewed states:

1. **Preview** validates customer identity, items, amounts, currency, payment
   terms, Stripe mode, and provider readiness without changing Stripe.
2. **Create draft** creates one Stripe draft quote and records its provider id.
3. **Finalize** revalidates the provider totals, opens the quote, downloads the
   Stripe PDF, and retains the PDF and SHA-256 digest in CoCalc.
4. **Accept** is permitted only after documented, explicit customer acceptance.
   It accepts the provider quote and adopts the resulting invoice as a local
   draft invoice.
5. **Cancel** cancels a draft or open Stripe quote and retains its audit history
   and any finalized PDF.
6. **Reconcile** repairs local state after a timeout or webhook gap. It does not
   create a replacement quote or invoice.

**Quote acceptance creates exactly one draft invoice. It never finalizes,
sends, or emails that invoice.** Invoice delivery remains a separate reviewed
AR action.

Set the order and use the current version returned by `show`. Every effectful
command previews without `--commit`; repeat it with the reviewed current
version and `--commit` to apply it.

```sh
ORDER=AR-2026-000123

cocalc admin receivables quote stripe preview "$ORDER" --json

cocalc admin receivables quote stripe create "$ORDER" \
  --valid-until 2026-10-01T00:00:00Z \
  --reason "prepare Stripe quote for procurement review" --json
cocalc admin receivables quote stripe create "$ORDER" \
  --valid-until 2026-10-01T00:00:00Z \
  --reason "prepare Stripe quote for procurement review" \
  --expected-version 4 --commit --json

cocalc admin receivables show "$ORDER" --json
```

Copy the internal commercial quote id and refreshed order version from the
result before each later mutation:

```sh
QUOTE_ID="replace-with-internal-quote-uuid"

cocalc admin receivables quote stripe finalize "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "reviewed Stripe quote and totals" --json
cocalc admin receivables quote stripe finalize "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "reviewed Stripe quote and totals" \
  --expected-version 5 --commit --json

cocalc admin receivables quote download "$ORDER" \
  --quote-id "$QUOTE_ID" --output-file quote.pdf
```

Do not infer acceptance from an email open, PDF view, purchase-order request,
or silence. Record or reference the authorized customer's affirmative
acceptance in the audit reason, then supply the required acknowledgment:

```sh
cocalc admin receivables quote stripe accept "$ORDER" \
  --quote-id "$QUOTE_ID" --customer-acceptance-confirmed \
  --reason "customer accepted quote in Zendesk ticket 12345" --json
cocalc admin receivables quote stripe accept "$ORDER" \
  --quote-id "$QUOTE_ID" --customer-acceptance-confirmed \
  --reason "customer accepted quote in Zendesk ticket 12345" \
  --expected-version 6 --commit --json
```

After acceptance, refresh the order, obtain the generated internal invoice id,
review its draft, and send it through the existing invoice workflow only when
delivery is intended:

```sh
INVOICE_ID="replace-with-internal-invoice-uuid"

cocalc admin receivables show "$ORDER" --json
cocalc admin receivables invoice preview "$ORDER" --json
cocalc admin receivables invoice send "$ORDER" --invoice-id "$INVOICE_ID" \
  --reason "reviewed quote-generated draft invoice for delivery" --json
cocalc admin receivables invoice send "$ORDER" --invoice-id "$INVOICE_ID" \
  --reason "reviewed quote-generated draft invoice for delivery" \
  --expected-version 7 --commit --json
```

Cancel a quote that must not proceed. Reconcile the existing quote after an
ambiguous timeout or provider webhook gap; never create another quote merely
because a command timed out.

```sh
cocalc admin receivables quote stripe cancel "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "customer declined reviewed quote" --json
cocalc admin receivables quote stripe cancel "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "customer declined reviewed quote" \
  --expected-version 6 --commit --json

cocalc admin receivables quote stripe reconcile "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "repair state after Stripe timeout" --json
cocalc admin receivables quote stripe reconcile "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "repair state after Stripe timeout" \
  --expected-version 6 --commit --json
```

## Reviewed Stripe Automatic Tax

Stripe invoices and Stripe quotes can opt into Stripe Tax using the approved
order's `terms_snapshot.invoice`. Existing orders remain untaxed unless this
option is explicitly enabled; changing Stripe's Dashboard default does not
retroactively change an approved CoCalc order.

```json
{
  "invoice": {
    "automatic_tax": true,
    "tax_code": "txcd_10103000",
    "billing_address": {
      "line1": "Reviewed customer address",
      "city": "London",
      "postal_code": "SW1A 1AA",
      "country": "GB"
    }
  }
}
```

The tax code above is an example, not a classification recommendation. Choose
the correct code for the service. Automatic tax requires an explicit Stripe
product tax code and a two-letter billing country. Supply the full address:
Stripe may also require a postal code or state/province.

Before approving the order:

1. In Stripe's live-mode Tax settings, verify the business origin, relevant
   active tax registrations, and product classification.
2. Check the customer's legal name, billing/shipping location, tax IDs and
   exemption/reverse-charge status. CoCalc does not infer or change tax
   exemptions or register the business for tax.
3. Preview the same customer, line items, and currency in Stripe with automatic
   tax enabled and **exclusive** pricing. Do not send an extra Dashboard invoice.
   Set CoCalc's `agreed_subtotal` to the pre-tax price and `agreed_total` to the
   reviewed total including tax, then approve through the normal workflow.
4. Create/review the AR draft, then explicitly finalize/send it. The normal
   reason, version, fresh-auth, and idempotency checks still apply. An accepted
   Stripe quote preserves automatic tax on its draft invoice.

Tax is added to the approved line prices, never silently absorbed into them.
A complete calculation may be zero (including when Stripe has no applicable
registration); zero is not proof that the customer is legally tax-exempt.

CoCalc blocks delivery if Stripe's automatic-tax setting differs, calculation
is incomplete, or subtotal/total no longer match the approved amounts. Stripe
can recalculate at finalization, so totals are checked again before email and
on delivery retries. If a finalization changes the tax, the invoice may already
be finalized but remains unsent by CoCalc; inspect that invoice and resolve it
through the normal void/revision workflow rather than repeatedly creating
invoices or bypassing the amount checks. Automatic advancement remains off.

For automatic-tax orders, recovery and delivery also verify each invoice
line's exclusive tax behavior and reviewed product tax code, even when the
calculated tax is zero or a changed classification produces the same total.
With the pinned Stripe API, these checks resolve the line's
`pricing.price_details` references by retrieving its Price and Product; they
do not assume invoice-item creation parameters are invoice-line response
fields. Missing or unverifiable tax settings block the operation. The same
checks apply when adopting an accepted quote's invoice and on finalized send
retries. Local quote acceptance requires nonnegative tax exactly equal to the
retained quote's total minus subtotal, including during recovery.

See [Stripe Tax for invoices](https://docs.stripe.com/tax/invoicing) and
[zero-tax calculations](https://docs.stripe.com/tax/zero-tax) for setup details.

## Local PDF Quote Fallback

Use the local PDF provider for sites without Invoicing Plus or when procurement
needs a standalone document rather than a Stripe-managed quote. Local quotes
remain first-class customer-facing artifacts. Issuance requires fresh auth and
optimistic concurrency. An issued PDF is immutable and has a stored SHA-256
digest; later order edits do not rewrite it. Voiding changes status but retains
the document and audit history. Existing local quotes are never migrated or
rewritten as Stripe quotes.

```sh
cocalc admin receivables quote preview AR-2026-000123 --json
cocalc admin receivables quote issue AR-2026-000123 \
  --reason "send formal procurement quote" --json
cocalc admin receivables quote issue AR-2026-000123 \
  --reason "send formal procurement quote" --expected-version 4 --commit --json
cocalc admin receivables quote download AR-2026-000123 \
  --quote-id <uuid> --output-file quote.pdf
```

## Billing Corrections

Use the dedicated billing correction action when procurement supplies a new
invoice recipient or address after approval or fulfillment. It preserves the
approved agreement and fulfillment state, replaces only billing/procurement
contacts and future invoice address/memo fields, and records an immutable
event. It fails closed once any non-void invoice exists; void the incorrect
invoice before correcting and reissuing it.

```sh
cocalc admin receivables billing update AR-2026-000123 \
  --file billing-details.json --reason "procurement supplied AP contact" --json
```

The JSON file must contain exactly one `billing` contact in
`billing_contacts`. It may also contain `procurement_contacts`,
`billing_address`, and `invoice_memo`.

## Collection-Mode Corrections

Use the dedicated collection-mode action when an approved order was configured
for a manual invoice but should instead use a Stripe-hosted invoice, or the
reverse. This is an operational payment-route correction: it preserves the
approved agreement, price, workflow, and fulfillment state.

The transition is limited to `manual_invoice` and `stripe_invoice`. It requires
fresh auth and is rejected for complimentary agreements, active Stripe quotes,
unresolved provider operations, or after any invoice or payment history exists.

```sh
cocalc admin receivables collection mode AR-2026-000123 \
  --mode stripe_invoice --reason "use Stripe hosted invoicing" --json
cocalc admin receivables collection mode AR-2026-000123 \
  --mode stripe_invoice --reason "use Stripe hosted invoicing" \
  --expected-version 8 --commit --json
```

## Customer PDF Links

After finalizing a Stripe quote (or issuing a local PDF quote), an admin with
fresh authentication can issue a private download link:

```sh
cocalc admin receivables quote share AR-2026-000123 --quote-id <uuid> \
  --expires-at 2026-10-01T00:00:00Z --reason "Send reviewed quote to customer"
# Review, then repeat with --expected-version <version> --commit.
cocalc admin receivables quote revoke-link AR-2026-000123 --quote-id <uuid> \
  --reason "Revoke previously shared link"
# Review, then repeat with --expected-version <version> --commit.
```

Send the returned URL through Zendesk. Anyone holding it can download this one
PDF without a CoCalc account. Expiration must be within 90 days and no later
than quote expiration. Issuing another link replaces the previous link;
revocation does not void the quote. Voiding/cancelling the quote also blocks
downloads. Revocation cannot recall copies already downloaded or a response
already in flight.

The token is returned once and only its SHA-256 hash is retained. An idempotent
retry returns no URL and does not rotate the link. If the response was lost,
issue a replacement using the current version and a new idempotency key.
Do not paste these bearer URLs into public issues or audit reasons.

The URL fragment keeps the token out of HTTP access logs. The public landing
page removes the fragment from browser history and submits the token in a POST
body when the recipient clicks Download. Do not enable request-body logging
for this endpoint. Responses use no-store, no-referrer, nosniff and a restrictive
CSP. JavaScript is required. The page loads no third-party assets.

These small, retained billing documents are seed-owned, not project files;
serving them through the hub is an intentional control-plane exception. Any
receiving bay routes downloads to the seed over a narrow internal method that
returns only the PDF and filename. The seed checks expiry/revocation and the
2 MiB bound and verifies the retained digest; it never contacts Stripe.
Each hub limits ingress to 30 requests/IP/minute and 200 requests/minute total.
The seed atomically limits each link to 20 PDF downloads/minute across hubs.
Invalid, expired, revoked and per-link-throttled requests get the same generic
unavailable response. Disabling receivables visibility stops public downloads.

## Recovery And Idempotency

Stripe calls and database commits cannot form one transaction. Provider
operations therefore reserve durable idempotency keys before remote calls.

- Retry a timed-out command with the same input and idempotency key.
- Do not create a replacement invoice after a timeout.
- Run quote or invoice reconcile when Stripe may have succeeded but local state
  is uncertain.
- Never create a replacement quote or invoice merely because a provider call
  timed out.
- `indeterminate` provider operations and failed webhook events appear in
  diagnostics review queues.
- An existing Stripe invoice can be adopted only after mode, currency, total,
  and ownership metadata validation.
- Webhook replay is safe and never creates generic CoCalc account credit.

There may be only one active creating, draft, or open invoice per order.
Corrections after finalization use void and reissue rather than editing history.

## Manual Payments

Use manual settlement only after verifying an external payment independently.
Record the exact amount, currency, received date, method, and a non-secret
reference such as a check number or bank confirmation identifier. The command
requires fresh auth, the current version, an audit reason, and `--commit`.

Manual settlement records a commercial payment. It does not add spendable
credit to a CoCalc account.

## Site-License Fulfillment

The approved `terms_snapshot.site_license` plan records owner, managers,
domains, pools, service term, and policy metadata. Preview reports whether the
operation will create, link, or leave a license unchanged. Provision verifies
the resulting license against the approved snapshot and stores the license id
on the order.

Use `--allow-before-payment` only when early activation was explicitly
approved. Ending fulfillment never rewrites collection history and overdue
payment never automatically suspends a university license.

## Diagnostics And Follow-Up

The seed worker runs under a database lease so only one hub processes each
maintenance interval. It:

- processes the durable Stripe webhook inbox;
- reconciles stale nonterminal invoices;
- updates overdue and exceptional queues;
- publishes aggregate Prometheus metrics and central-log events;
- emits one durable-watermarked internal digest per UTC day.

Diagnostics include open/unassigned/overdue totals, paid-but-unprovisioned and
provisioned-but-unpaid records, stale invoices, inconsistent orders, failed
Stripe events, indeterminate provider operations, open orders without due
dates, and active commercial site licenses that are not represented by an
order.

These are human review queues. Backfill is preview-first and never infers every
historical invoice, site license, purchase, or support ticket automatically.

## Stripe Test Validation

Before production send is enabled, complete this in Stripe test mode:

1. Create and approve a test university order.
2. Preview and create a Stripe draft quote.
3. Retry creation and verify no duplicate quote exists.
4. Finalize the quote, download the retained PDF, and verify exact totals.
5. Record explicit test-customer acceptance and accept the quote.
6. Verify acceptance created exactly one draft invoice and sent no email.
7. Preview and send that invoice, then provision a test site license.
8. Pay through the hosted invoice page.
9. Verify payment, fulfillment, completion, and immutable audit events.
10. Replay the webhook and retry commands; verify no duplicate quote, invoice,
    payment, license, or account credit.
11. Cancel a second open quote and verify its PDF and history remain retained.
12. Disable webhook processing temporarily, transition another quote, re-enable
    it, and verify scheduled reconciliation converges.

Provider/local currency or amount mismatches fail closed and must be reviewed;
they are never normalized silently.
