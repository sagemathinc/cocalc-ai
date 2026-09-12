/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const ADMIN_OVERVIEW_BODY = String.raw`
## What admin docs are for

Admin docs describe operational workflows for running a CoCalc-ai site. They
are not public product docs: they assume a signed-in site administrator, current
source-derived behavior, and the security model of the running deployment.

Use admin docs when you need to operate the site, inspect users, configure
settings, publish site messages, or guide Codex to the correct admin panel
without searching source code from scratch every time.

## Admin safety model

Admin workflows can reveal account data, change site behavior, impersonate
users, reset credentials, disable 2FA, affect billing, or move ownership across
bays. Treat them as high-trust operations.

Prefer UI actions and documented CLI commands that require fresh auth for
dangerous operations. Avoid ad hoc database edits unless the docs or source
explicitly call for them.

## Navigation

Open the Admin tab from the main app. Use the Admin navigation
menu to choose User Search, News, Site Settings, RootFS Images, Bay Operations,
Backup Shards, Software Licenses, Registration Tokens, SSO Providers & Domains,
or Membership Tiers. On small screens, choose the area from the selector.

Docs actions for admin pages are stable destinations that Codex can use through
the browser action API when the current user is an admin.
`;

export const ADMIN_NEWS_BODY = String.raw`
## What admin news is for

Admin news manages public news posts, event posts, and in-app system notices.
System notices are useful for urgent operational messages such as outages,
maintenance, or service-impacting configuration changes.

## Create a system notice

1. Open the Admin tab.
2. Open **News**.
3. Choose **Create news item**, then set **Channel** to **System**.
4. Write the notice in Markdown.
5. Set timing, visibility, and any image or link fields.
6. Save and verify how it appears in the app.

System notices are operational communication. Keep them short, concrete, and
dated when they describe an incident or maintenance window.

## News and events

Use regular news items for public product updates. Use event posts for events
that should appear on the public events surface. The same admin editor supports
Markdown, image paste/upload, and preview.
`;

export const ADMIN_SITE_SETTINGS_BODY = String.raw`
## What site settings are for

Site settings configure behavior for the running CoCalc-ai deployment. They
include product configuration, authentication options, project-host/cloud
settings, email, backup, runtime policies, and other operational controls.

## Work with settings

1. Open the Admin tab.
2. Open **Site Settings**.
3. Search for the setting or section you need.
4. Read the current value and nearby help text before changing it.
5. Save, then verify the affected workflow in the app or CLI.

Some setting changes affect security, authentication, billing, project hosts,
or backups. For those, make a note of the old value and prefer a small
roll-forward/roll-back test.

## Configuration wizards

Some settings have dedicated helper wizards, such as Cloudflare, GCP service
accounts, Nebius CLI, launcher defaults, and runtime retention policies. Use
those wizards when available instead of editing related fields independently.
`;

export const ADMIN_USERS_BODY = String.raw`
## What user management is for

The admin user search surface is the starting point for account support and
site operations. It lets admins find accounts and open account-specific tools.

## Common workflows

Search for a user by name or email, expand the result, then use the detail tags
for the workflow you need:

- **Impersonate** generates an impersonation link after recent admin
  verification and 2FA.
- **Profile** includes password reset and 2FA removal tools.
- **Ban** controls account ban state.
- **Projects** lists recent projects the account collaborates on.
- **Billing**, **Egress**, and **Membership** expose billing, network, and
  membership tools.

## Safety

Impersonation, password reset, and removing 2FA are sensitive support actions.
Use them only for a concrete support or administrative reason, and expect fresh
admin authentication checks for dangerous operations.
`;

export const ADMIN_CLI_BODY = String.raw`
## What admin CLI workflows are for

The CoCalc CLI is often the fastest way to inspect a running dev or production
site, especially for bay/account/project-host operations. Admin CLI workflows
should use fresh environment and fresh auth so commands target the intended
hub.

## Start with the correct environment

For local hub-backed development:

~~~sh
cd src && eval "$(pnpm -s dev:hub:env)"
~~~

Refresh this after restarting the hub or changing local dev instances.

## Useful commands

~~~sh
cocalc bay list --json
cocalc account where <account_id> --json
cocalc account rehome <account_id> --bay <bay_id> --reason "..." --yes --json
cocalc account rehome-status --op-id <op_id> --source-bay <bay_id> --json
~~~

Dangerous account operations require recent admin verification. In local dev,
use:

~~~sh
cocalc auth elevate --dev
~~~

## Account-owned state

Account-private DKV/conat-persist state, including docs private notes and git
review state, must follow the account home bay. After rehome, verify the account
location and smoke-test a feature that reads account-private state.
`;

export const ADMIN_RECEIVABLES_BODY = `
## Read this runbook from the CLI

This is the packaged source of truth for CoCalc's commercial accounts
receivable workflow. It is included in each CoCalc CLI build and can be read or
searched without a source checkout:

~~~sh
cocalc docs show admin/accounts-receivable --include-admin
cocalc docs search "accounts receivable" --include-admin
cocalc docs skill-context --query "accounts receivable" --include-admin
~~~

CoCalc's commercial-order workflow is the shared source of truth for
sales-assisted agreements, invoicing, payment collection, and fulfillment.
Stripe delivers invoices and accepts payment. Zendesk records customer
communication. Neither replaces the commercial order.

## Authority and access

Commercial tables are seed-global. Public Conat requests may originate on any
bay, but all reads and writes route to the cluster seed. Launchpad follows the
same route with its only bay acting as seed.

The authorization and safety policy is:

- Admin membership is required for every operation.
- Financial, approval, migration, and fulfillment mutations require fresh
  authentication and reject impersonation.
- Every read and mutation requires a human-readable audit reason.
- Mutations use \`expected_version\` and a stable idempotency key.
- CLI mutations preview by default and require \`--commit\` for effects.

Never include payment credentials, bank account details, card details, or full
provider payloads in an order, note, evidence reference, or audit reason.

## Start with the queue

Use human output while operating interactively and \`--json\` for agents:

~~~sh
cocalc admin receivables list --state ready-to-invoice,overdue --json
cocalc admin receivables show AR-2026-000123 --json
cocalc admin receivables events AR-2026-000123 --json
cocalc admin receivables diagnostics --json
~~~

Run \`cocalc admin receivables --help\` and the relevant nested command's
\`--help\` before a mutation. Mutations preview by default. Review the preview,
then repeat with the displayed version, a concrete reason, and \`--commit\`.

Order creation previews are validated by the same seed-authoritative code used
for commits. They reject nonstandard next actions, missing or invalid due dates,
malformed contacts, and invalid or inconsistent line items. The preview also
normalizes amounts, email addresses, and timestamps. A draft may be created
before its billing contact is known, but \`approval_ready\` remains false and
\`approval_blockers\` explains that exactly one billing contact is required.

## Rollout controls

Enable these site settings independently under **Billing & Commerce / Accounts
Receivable**:

| Setting | Effect |
| --- | --- |
| \`commercial_receivables_visible\` | Admin queue, detail, audit, preview, and diagnostics reads. |
| \`commercial_receivables_mutations_enabled\` | Order creation, editing, assignment, notes, approval, cancellation, and backfill. |
| \`commercial_receivables_stripe_drafts_enabled\` | Stripe invoice draft creation and reviewed adoption of an existing Stripe invoice. |
| \`commercial_receivables_stripe_quotes_enabled\` | Stripe quote preview and draft creation. |
| \`commercial_receivables_stripe_quote_finalize_enabled\` | Stripe quote finalization and PDF retention. |
| \`commercial_receivables_stripe_quote_accept_enabled\` | Stripe quote acceptance and draft-invoice conversion. |
| \`commercial_receivables_stripe_send_enabled\` | Stripe invoice finalize/send and void. |
| \`commercial_receivables_manual_settlement_enabled\` | Recording externally verified checks, wires, or other manual settlements. |
| \`commercial_receivables_reconciliation_enabled\` | Manual reconciliation, durable webhook processing, and scheduled reconciliation. |
| \`commercial_receivables_fulfillment_enabled\` | Site-license linking, provisioning, and ending fulfillment. |

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

## Standard workflow

1. Create an order from reviewed terms. Record the organization snapshot,
   billing contact, exact line items, service dates, linked Zendesk tickets,
   owner, next action, and due date. Select the next action from the standard
   receivables task list. Put customer-specific instructions and context in an
   audited internal note.
2. If procurement requires a formal pre-PO document, choose a Stripe-native
   quote or the local PDF fallback. Preview the exact terms before creating or
   issuing it. Finalize a Stripe quote only after reviewing its provider state
   and PDF. Do not accept it until an authorized customer has explicitly
   accepted those terms.
3. When procurement sends a purchase order, attach its PDF and reviewed PO
   reference to the order. The file remains available after payment or order
   completion.
4. Approve the order after validating the customer agreement and delivery
   details.
5. Preview the invoice. Resolve every blocker before creating a Stripe draft.
6. If a Stripe quote was accepted, use its generated draft invoice. Otherwise,
   create a draft invoice. Neither path sends automatically.
7. Review the Stripe customer, contact, line items, total, currency, negotiated
   payment terms, PO/reference fields, and test/live mode.
8. Send the invoice with fresh auth and the current order version.
9. Preview and provision the site license. Provision-before-payment is allowed
   only with the explicit reviewed flag.
10. Let Stripe webhooks update payment state. The scheduled reconciler repairs
   dropped or out-of-order webhooks.
11. The order becomes complete only when its configured collection and
   fulfillment requirements are both satisfied.

Collection and fulfillment are intentionally independent. Provisioning a site
license does not mark an invoice paid, and payment does not provision a license.

## Stripe-native quotes

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

Set the order and use the current version returned by \`show\`. Every effectful
command previews without \`--commit\`; repeat it with the reviewed current
version and \`--commit\` to apply it.

~~~sh
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
~~~

Copy the internal commercial quote id and refreshed order version from the
result before each later mutation:

~~~sh
QUOTE_ID="replace-with-internal-quote-uuid"

cocalc admin receivables quote stripe finalize "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "reviewed Stripe quote and totals" --json
cocalc admin receivables quote stripe finalize "$ORDER" \
  --quote-id "$QUOTE_ID" --reason "reviewed Stripe quote and totals" \
  --expected-version 5 --commit --json

cocalc admin receivables quote download "$ORDER" \
  --quote-id "$QUOTE_ID" --output-file quote.pdf
~~~

Do not infer acceptance from an email open, PDF view, purchase-order request,
or silence. Record or reference the authorized customer's affirmative
acceptance in the audit reason, then supply the required acknowledgment:

~~~sh
cocalc admin receivables quote stripe accept "$ORDER" \
  --quote-id "$QUOTE_ID" --customer-acceptance-confirmed \
  --reason "customer accepted quote in Zendesk ticket 12345" --json
cocalc admin receivables quote stripe accept "$ORDER" \
  --quote-id "$QUOTE_ID" --customer-acceptance-confirmed \
  --reason "customer accepted quote in Zendesk ticket 12345" \
  --expected-version 6 --commit --json
~~~

After acceptance, refresh the order, obtain the generated internal invoice id,
review its draft, and send it through the existing invoice workflow only when
delivery is intended:

~~~sh
INVOICE_ID="replace-with-internal-invoice-uuid"

cocalc admin receivables show "$ORDER" --json
cocalc admin receivables invoice preview "$ORDER" --json
cocalc admin receivables invoice send "$ORDER" --invoice-id "$INVOICE_ID" \
  --reason "reviewed quote-generated draft invoice for delivery" --json
cocalc admin receivables invoice send "$ORDER" --invoice-id "$INVOICE_ID" \
  --reason "reviewed quote-generated draft invoice for delivery" \
  --expected-version 7 --commit --json
~~~

Cancel a quote that must not proceed. Reconcile the existing quote after an
ambiguous timeout or provider webhook gap; never create another quote merely
because a command timed out.

~~~sh
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
~~~

## Local PDF quote fallback

Use the local PDF provider for sites without Invoicing Plus or when procurement
needs a standalone document rather than a Stripe-managed quote. An issued local
quote is a first-class immutable PDF snapshot retained with the order. It
records its exact recipient, billing address, items, total, service term,
validity date, and SHA-256 digest. Voiding changes status but does not delete or
rewrite the document. Existing local quotes are never migrated or rewritten as
Stripe quotes.

~~~sh
cocalc admin receivables quote preview AR-2026-000123 --json
cocalc admin receivables quote issue AR-2026-000123 \
  --reason "send formal procurement quote" --json
cocalc admin receivables quote issue AR-2026-000123 \
  --reason "send formal procurement quote" --expected-version 4 --commit --json
cocalc admin receivables quote download AR-2026-000123 \
  --quote-id <uuid> --output-file quote.pdf
~~~

## Billing corrections and purchase orders

Purchase-order PDFs are also immutable, digest-verified commercial documents.
Uploading a PO reference fills an empty order \`po_number\`; it fails closed if
the reference conflicts with a PO number already reviewed on the order. An
incorrect or superseded attachment is voided, never deleted, and remains
downloadable for audit. Attachments are accepted even after an order is paid or
complete because procurement evidence can arrive late.

~~~sh
cocalc admin receivables document upload AR-2026-000123 \
  --file purchase-order.pdf --reference PO-5874860 \
  --reason "attach purchase order received from procurement" --json
cocalc admin receivables document upload AR-2026-000123 \
  --file purchase-order.pdf --reference PO-5874860 \
  --reason "attach purchase order received from procurement" \
  --expected-version 7 --commit --json
cocalc admin receivables document download AR-2026-000123 \
  --document-id <uuid> --output-file purchase-order.pdf
cocalc admin receivables document void AR-2026-000123 \
  --document-id <uuid> --reason "superseded by corrected PO"
~~~

Use the dedicated billing correction action when procurement supplies a new
invoice recipient or address after approval or fulfillment. It preserves
approval and fulfillment, updates only future billing/procurement contacts and
invoice address/memo fields, and is rejected while an invoice has a status
other than void or failed.

~~~sh
cocalc admin receivables billing update AR-2026-000123 \
  --file billing-details.json --reason "procurement supplied AP contact" --json
~~~

The JSON file must contain exactly one \`billing\` contact in
\`billing_contacts\`. It may also contain \`procurement_contacts\`,
\`billing_address\`, and \`invoice_memo\`.

## Collection-mode corrections

Use the dedicated collection-mode action when an approved order was configured
for a manual invoice but should instead use a Stripe-hosted invoice, or the
reverse. This is an operational payment-route correction: it preserves the
approved agreement, price, workflow, and fulfillment state.

The transition is limited to \`manual_invoice\` and \`stripe_invoice\`. It
requires fresh auth and is rejected for complimentary agreements, active Stripe
quotes, unresolved provider operations, or after any invoice or payment history
exists.

~~~sh
cocalc admin receivables collection mode AR-2026-000123 \
  --mode stripe_invoice --reason "use Stripe hosted invoicing" --json
cocalc admin receivables collection mode AR-2026-000123 \
  --mode stripe_invoice --reason "use Stripe hosted invoicing" \
  --expected-version 8 --commit --json
~~~

## Import historical site-license accounting

Use the receivables backfill only for sales completed outside the canonical AR
system. The importer creates a normal manual-invoice commercial order, approves
it, records a local invoice, and optionally records a verified payment. It does
not create editable analytics records. Contracted, invoiced, and collected
analytics are subsequently derived from these canonical records.

Each historical candidate requires stable provenance, the existing site-license
UUID, exact service dates, one billing contact, and invoice evidence. Add
\`payment\` only when collection has been independently reconciled. For example:

~~~json
[
  {
    "organization_name": "Example University",
    "site_license_id": "11111111-1111-4111-8111-111111111111",
    "agreed_total": "1200.00",
    "next_action": "Create invoice",
    "service_starts_at": "2025-01-01T00:00:00Z",
    "service_ends_at": "2026-01-01T00:00:00Z",
    "billing_contact": {
      "role": "billing",
      "name_snapshot": "Accounts Payable",
      "email_snapshot": "ap@example.edu"
    },
    "provenance": {
      "source": "legacy-site-license-spreadsheet",
      "reference": "row-42"
    },
    "invoice": {
      "reference": "INV-42",
      "issued_at": "2024-12-15T00:00:00Z",
      "due_at": "2025-01-15T00:00:00Z",
      "evidence_reference": "archived invoice INV-42"
    },
    "payment": {
      "amount": "1200.00",
      "received_at": "2025-01-10T00:00:00Z",
      "method": "wire",
      "evidence_reference": "bank reconciliation row 42"
    }
  }
]
~~~

Preview the entire file first. The response lists every planned canonical
action and all blockers without writing. Commit only the identical reviewed
file and reuse the same idempotency key when resuming an interrupted import.

~~~sh
cocalc admin receivables backfill --file historical-site-licenses.json \
  --reason "import reconciled historical site licenses" --json
cocalc admin receivables backfill --file historical-site-licenses.json \
  --reason "import reconciled historical site licenses" \
  --idempotency-key historical-site-licenses-2026-08 --commit --json
~~~

An invalid candidate rejects the entire batch before writing unless it has
already been identified as represented by an existing order and marked skipped.
Review both the planned actions and skipped rows: an existing match can appear
in the blocker list without preventing other valid candidates from being
imported. Duplicate site licenses, Zendesk tickets, or provenance references
within the input file are blocking errors for candidates still being imported.
If a later operational error interrupts a commit, rerun the identical command
and idempotency key to resume its canonical action sequence.

## Recovery and idempotency

Stripe calls and database commits cannot form one transaction. Provider
operations therefore reserve durable idempotency keys before remote calls.

- Retry a timed-out command with the same input and idempotency key.
- Do not create a replacement invoice after a timeout.
- Run quote or invoice reconcile when Stripe may have succeeded but local state
  is uncertain.
- Never create a replacement quote or invoice merely because a provider call
  timed out.
- \`indeterminate\` provider operations and failed webhook events appear in
  diagnostics review queues.
- An existing Stripe invoice can be adopted only after mode, currency, total,
  and ownership metadata validation.
- Webhook replay is safe and never creates generic CoCalc account credit.

There may be only one active creating, draft, or open invoice per order.
Corrections after finalization use void and reissue rather than editing history.

## Manual payments

Use manual settlement only after verifying an external payment independently.
Record the exact amount, currency, received date, method, and a non-secret
reference such as a check number or bank confirmation identifier. The command
requires fresh auth, the current version, an audit reason, and \`--commit\`.

Manual settlement records a commercial payment. It does not add spendable
credit to a CoCalc account.

## Site-license fulfillment

The approved \`terms_snapshot.site_license\` plan records owner, managers,
domains, pools, service term, and policy metadata. Preview reports whether the
operation will create, link, or leave a license unchanged. Provision verifies
the resulting license against the approved snapshot and stores the license id
on the order.

Use \`--allow-before-payment\` only when early activation was explicitly
approved. Ending fulfillment never rewrites collection history, and overdue
payment never automatically suspends a university license.

## Diagnostics and follow-up

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

## Stripe test validation

Before production send is enabled:

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
`;

export const ADMIN_CRM_BODY = String.raw`
## Read this runbook from the CLI

The integrated CRM joins customer identity and internal follow-up without
replacing Zendesk, Stripe, commercial orders, or site licenses. This runbook is
packaged in every CoCalc CLI build:

~~~sh
cocalc docs show admin/crm --include-admin
cocalc docs search "customer relationship CRM" --include-admin
cocalc docs skill-context --query "institutional customer CRM" --include-admin
~~~

The canonical record is a customer organization with a stable number such as
\`CRM-2026-000123\`. It joins reviewed domains, contacts, CoCalc accounts,
opportunities, internal tasks, Zendesk ticket references, Stripe customer
references, commercial orders, site licenses, metrics, and an append-only
timeline.

## Authority and safety

- CRM records are seed-global. Every bay routes reads and writes to the seed.
- Admin membership and a human-readable reason are required for every read.
- Mutations preview by default. A committed mutation requires the preview's
  \`expected_version\`, a stable idempotency key, \`--commit\`, and fresh auth.
- Merges, verified domains, external links, exports, and backfill are reviewed
  operations. Email-domain matches are evidence, not automatic identity.
- Zendesk owns conversations, Stripe owns provider settlement, commercial
  orders own accepted terms and fulfillment coordination, and site licenses
  own entitlements. CRM links those systems; it does not copy their authority.
- Never put card data, bank credentials, secrets, private keys, or unrestricted
  provider payloads in notes, evidence, metadata, or audit reasons.

Use browser-approved production authentication when required:

~~~sh
cocalc auth bootstrap --email <admin-email>
cocalc auth status --check
~~~

## Start with search and Customer 360

~~~sh
cocalc admin crm organizations list --json
cocalc admin crm organizations search --domain example.edu --json
cocalc admin crm organizations search --zendesk-ticket 20599 --json
cocalc admin crm organizations show CRM-2026-000123 --json
cocalc admin crm activities list CRM-2026-000123 --json
cocalc admin crm links list --provider cocalc \
  --external-id source-system:organization-123 --json
cocalc admin crm links list --provider cocalc \
  --external-id-prefix source-system: --limit 100 --json
cocalc admin crm digest --assignee me --json
cocalc admin crm diagnostics --json
~~~

Selectors accept customer number, exact customer name, reviewed domain, email,
and other documented human identifiers. Ambiguous selectors return bounded
candidates instead of silently choosing a record.

External-reference filters are combined. \`--external-id\` is an exact,
case-sensitive identifier; \`--external-id-prefix\` is a literal prefix, not a
SQL wildcard, and the two options are mutually exclusive. JSON output places
rows in \`data.external_references\` and reports \`data.truncated\`,
\`data.result_bytes\`, and, when another page exists, \`data.next_cursor\`.
Repeat the same filters with \`--cursor <next_cursor>\` until
\`data.truncated\` is false. A cursor-complete list is not a frozen database
snapshot; repeat and compare a full scan when concurrent changes matter.

## Preview and commit

Run a mutation once without \`--commit\`. Review the proposed change, warnings,
\`expected_version\`, and \`idempotency_key\`. Re-run the same command with those
values and \`--commit\`:

~~~sh
# PREVIEW ONLY — this command makes no change.
cocalc admin crm organizations create \
  --name "Example University" --type university \
  --owner admin@example.com \
  --reason "reviewed institutional inquiry" --json

# COMMIT — apply the exact reviewed preview.
cocalc admin crm organizations create \
  --name "Example University" --type university \
  --owner admin@example.com \
  --reason "reviewed institutional inquiry" \
  --expected-version 0 --idempotency-key <key-from-preview> --commit --json
~~~

Retry an uncertain mutation with exactly the same idempotency key and payload.
Never invent a replacement record after a timeout. A stale optimistic version
means another operator changed the record; read it again and make a new review.

## Standard institutional workflow

1. Search before creating a customer. Review names, aliases, domains, contacts,
   Zendesk tickets, orders, and site licenses for duplicates.
2. Create the customer and assign a relationship owner.
3. Add institutional domains as \`suggested\`; verify only after reviewing
   evidence. Generic providers such as Gmail cannot be verified as customer
   identity domains.
4. Add contacts and explicitly link their CoCalc accounts and customer roles.
5. Create an adoption-pilot, site-license, renewal, or expansion opportunity.
6. Create an explicit task with an assignee and due date for the next action.
7. Link the relevant Zendesk ticket without copying its thread.
8. Move the opportunity through the constrained stages. When terms are ready,
   create the commercial order from the opportunity and continue in Accounts
   Receivable.
9. Link the resulting site license and retain important internal context as
   concise timeline notes.

Representative commands:

~~~sh
# PREVIEW ONLY — this command makes no change.
cocalc admin crm domains add CRM-2026-000123 example.edu \
  --kind primary --reason "domain supplied by procurement"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm people create --name "Ada Example" \
  --organization CRM-2026-000123 --roles billing,procurement \
  --email ada@example.edu --linkedin https://www.linkedin.com/in/ada-example \
  --website https://example.edu/~ada \
  --note "Primary procurement contact for the pilot" \
  --reason "billing contact supplied by customer"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm people update ada@example.edu \
  --x https://x.com/adaexample --timezone America/New_York \
  --reason "reviewed public contact details"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm links add CRM-2026-000123 \
  --provider zendesk --kind ticket --external-id 20599 --verify \
  --reason "reviewed institutional inquiry"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm links add example-customer \
  --provider cocalc --kind person --person ada@example.com \
  --external-id source-system:person-456 --verify \
  --reason "reviewed source-person binding"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm links add example-customer \
  --provider cocalc --kind person \
  --external-id source-system:person-789 --reject \
  --reason "reviewed and rejected source candidate"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm opportunities create CRM-2026-000123 \
  --name "Campus adoption pilot" --kind adoption-pilot \
  --owner admin@example.com --value 3900 --close-date 2026-09-30 \
  --reason "customer accepted pilot terms"
# PREVIEW ONLY — this command makes no change.
cocalc admin crm tasks create CRM-2026-000123 \
  --type procurement --assignee admin@example.com \
  --due 2026-09-01T17:00:00Z --subject "Obtain purchase order" \
  --reason "procurement follow-up"
~~~

Run \`cocalc admin crm --help\` and each nested command's help for the full
command tree. Every admin UI mutation has a CLI equivalent.
CRM task deadlines must be RFC3339 timestamps with an explicit timezone.
Manual activity commands require \`--occurred-at\` in the same format. The Admin
UI captures a note's event time once for preview and reuses it for commit.

## Complete CLI leaf-command inventory

This inventory is checked against the command tree registered by the CLI. It
lists command paths rather than every option; run a leaf command with
\`--help\` for its exact arguments and flags. A **previewed mutation** makes no
change unless it is repeated with the reviewed \`expected_version\`, the same
payload and idempotency key, and \`--commit\`. A **sensitive export** does not
mutate CRM, but it writes customer data to the requested local file and requires
fresh authentication. A **conditional write** is read-only by default, but its
\`--refresh\` option persists a newly computed snapshot.

<!-- crm-cli-inventory:start -->
- **read** — \`cocalc admin crm organizations list\`
- **read** — \`cocalc admin crm organizations search\`
- **read** — \`cocalc admin crm organizations show\`
- **conditional write** — \`cocalc admin crm organizations metrics\`
- **previewed mutation** — \`cocalc admin crm organizations create\`
- **previewed mutation** — \`cocalc admin crm organizations update\`
- **previewed mutation** — \`cocalc admin crm organizations archive\`
- **previewed mutation** — \`cocalc admin crm organizations merge\`
- **previewed mutation** — \`cocalc admin crm domains add\`
- **previewed mutation** — \`cocalc admin crm domains verify\`
- **previewed mutation** — \`cocalc admin crm domains reject\`
- **previewed mutation** — \`cocalc admin crm domains retire\`
- **previewed mutation** — \`cocalc admin crm domains transfer\`
- **read** — \`cocalc admin crm people list\`
- **read** — \`cocalc admin crm people search\`
- **read** — \`cocalc admin crm people show\`
- **previewed mutation** — \`cocalc admin crm people create\`
- **previewed mutation** — \`cocalc admin crm people update\`
- **previewed mutation** — \`cocalc admin crm people link\`
- **previewed mutation** — \`cocalc admin crm people unlink\`
- **read** — \`cocalc admin crm opportunities list\`
- **read** — \`cocalc admin crm opportunities show\`
- **previewed mutation** — \`cocalc admin crm opportunities create\`
- **previewed mutation** — \`cocalc admin crm opportunities update\`
- **previewed mutation** — \`cocalc admin crm opportunities transition\`
- **read** — \`cocalc admin crm tasks list\`
- **read** — \`cocalc admin crm tasks show\`
- **previewed mutation** — \`cocalc admin crm tasks create\`
- **previewed mutation** — \`cocalc admin crm tasks assign\`
- **previewed mutation** — \`cocalc admin crm tasks reschedule\`
- **previewed mutation** — \`cocalc admin crm tasks complete\`
- **previewed mutation** — \`cocalc admin crm tasks cancel\`
- **read** — \`cocalc admin crm activities list\`
- **previewed mutation** — \`cocalc admin crm activities note\`
- **previewed mutation** — \`cocalc admin crm activities call\`
- **previewed mutation** — \`cocalc admin crm activities meeting\`
- **read** — \`cocalc admin crm links list\`
- **previewed mutation** — \`cocalc admin crm links add\`
- **previewed mutation** — \`cocalc admin crm links remove\`
- **previewed mutation** — \`cocalc admin crm order create\`
- **read** — \`cocalc admin crm outreach list\`
- **read** — \`cocalc admin crm outreach show\`
- **read** — \`cocalc admin crm outreach preview\`
- **previewed mutation** — \`cocalc admin crm outreach draft\`
- **previewed mutation** — \`cocalc admin crm outreach approve\`
- **previewed mutation** — \`cocalc admin crm outreach queue\`
- **previewed mutation** — \`cocalc admin crm outreach pause\`
- **previewed mutation** — \`cocalc admin crm outreach resume\`
- **previewed mutation** — \`cocalc admin crm outreach cancel\`
- **previewed mutation** — \`cocalc admin crm outreach retry\`
- **previewed mutation** — \`cocalc admin crm outreach reconcile\`
- **previewed mutation** — \`cocalc admin crm outreach delivery retry\`
- **previewed mutation** — \`cocalc admin crm outreach delivery reconcile\`
- **previewed mutation** — \`cocalc admin crm outreach delivery cancel\`
- **read** — \`cocalc admin crm outreach limits\`
- **read** — \`cocalc admin crm outreach diagnostics\`
- **read** — \`cocalc admin crm outreach batch list\`
- **read** — \`cocalc admin crm outreach batch show\`
- **read** — \`cocalc admin crm outreach batch preview\`
- **previewed mutation** — \`cocalc admin crm outreach batch add\`
- **previewed mutation** — \`cocalc admin crm outreach batch create\`
- **previewed mutation** — \`cocalc admin crm outreach batch update\`
- **previewed mutation** — \`cocalc admin crm outreach batch remove\`
- **previewed mutation** — \`cocalc admin crm outreach batch approve\`
- **previewed mutation** — \`cocalc admin crm outreach batch queue\`
- **previewed mutation** — \`cocalc admin crm outreach batch pause\`
- **previewed mutation** — \`cocalc admin crm outreach batch resume\`
- **previewed mutation** — \`cocalc admin crm outreach batch cancel\`
- **read** — \`cocalc admin crm outreach templates list\`
- **read** — \`cocalc admin crm outreach templates show\`
- **previewed mutation** — \`cocalc admin crm outreach templates create\`
- **previewed mutation** — \`cocalc admin crm outreach templates activate\`
- **previewed mutation** — \`cocalc admin crm outreach templates retire\`
- **read** — \`cocalc admin crm outreach suppressions list\`
- **previewed mutation** — \`cocalc admin crm outreach suppressions add\`
- **previewed mutation** — \`cocalc admin crm outreach suppressions revoke\`
- **read** — \`cocalc admin crm outreach followups list\`
- **read** — \`cocalc admin crm outreach followups show\`
- **read** — \`cocalc admin crm outreach followups preview\`
- **previewed mutation** — \`cocalc admin crm outreach followups send\`
- **previewed mutation** — \`cocalc admin crm outreach followups reschedule\`
- **previewed mutation** — \`cocalc admin crm outreach followups complete\`
- **previewed mutation** — \`cocalc admin crm outreach followups cancel\`
- **read** — \`cocalc admin crm outreach engagement\`
- **read** — \`cocalc admin crm support-context\`
- **previewed mutation** — \`cocalc admin crm backfill\`
- **read** — \`cocalc admin crm digest\`
- **read** — \`cocalc admin crm diagnostics\`
- **sensitive export** — \`cocalc admin crm export\`
<!-- crm-cli-inventory:end -->

## System boundaries

Use Zendesk to reply to customers and manage ticket state. Use Accounts
Receivable to review terms, generate/send Stripe invoices, record payment, and
coordinate fulfillment. Use site-license administration for entitlement
details. CRM tasks represent important internal follow-up but do not replace a
commercial order's constrained next action.

External references store stable identifiers, a redacted label, and bounded
metadata only. Current Zendesk details are fetched on demand through the
support API. Accepted order snapshots and issued invoices are never rewritten
when a CRM contact or organization changes.

Creating or updating a \`person\` external reference binds one reviewed
source-person identifier to an existing CRM person. It requires \`--person\`,
and that person must have an existing relationship to the organization named
by the command. Relationship state does not erase identity history. Removing
the binding may omit \`--person\`. The reference does not create a person, move
one between organizations, or make an unreviewed identity authoritative.

Person records may include a reviewed website, LinkedIn, Facebook, and X
profile plus one bounded internal note. These fields are visible to CRM admins
and agents. Keep the note concise and never store credentials, payment details,
private keys, or other secrets in it; use customer timeline notes for dated
relationship events instead.

## Duplicate handling and backfill

Customer discovery is candidate-only and preview-first:

~~~sh
# PREVIEW ONLY — this command makes no change.
cocalc admin crm backfill --limit 100 --reason "review commercial customer candidates" --json
# COMMIT — apply the exact reviewed candidate selection.
cocalc admin crm backfill --candidate <candidate-key> \
  --reason "reviewed order and license identity" \
  --expected-version 0 --idempotency-key <key> --commit --json
~~~

Never merge solely because two contacts share an email domain. A merge rewrites
relationships and leaves the source as a durable redirect; review the full
plan and warnings first.

## Diagnostics and rollout

Use the deterministic daily digest for the team's bounded operational handoff:

~~~sh
cocalc admin crm digest --assignee me --due-within-days 1 \
  --renewal-within-days 90 --json
~~~

It reports overdue and near-term CRM tasks, receivables next actions, upcoming
renewals, open expansion opportunities, and unassigned customers. Pass
\`--as-of\` when a repeatable historical cutoff is important. Counts are
explicitly marked as bounded if any section reaches its requested limit. The
digest does not send email or notifications; it is the source an admin or agent
uses for a morning review.

The diagnostics queue identifies unowned active customers, overdue tasks,
opportunities without next tasks, won opportunities without orders, unlinked
orders/licenses, stale metrics, merge-reference problems, and identity
conflicts.

The independent site settings are:

| Setting | Effect |
| --- | --- |
| \`crm_visible\` | Customer queue, Customer 360, search, timeline, metrics, and diagnostics. |
| \`crm_mutations_enabled\` | Customer, contact, domain, activity, and relationship mutations. |
| \`crm_pipeline_mutations_enabled\` | Opportunity and internal follow-up task mutations. |
| \`crm_zendesk_linking_enabled\` | Reviewed Zendesk ticket and requester links. |
| \`crm_commercial_integration_enabled\` | Stripe, commercial-order, and site-license links and order creation. |
| \`crm_metric_projections_enabled\` | Bounded spend, receivables, license, and adoption metrics. |
| \`crm_exports_enabled\` | Fresh-auth bounded sensitive exports. |
| \`crm_backfill_enabled\` | Preview and reviewed application of discovery candidates. |

Enable visibility first, then normal mutations, and only then export/backfill.
Rollback should disable effectful controls while preserving read visibility.
`;

export const ADMIN_CRM_OUTREACH_BODY = String.raw`
## Read this runbook from the CLI

CRM outreach lets the team initiate a small, reviewed institutional
conversation while keeping every message, reply, follow-up, and suppression
visible to all admins. Zendesk owns the conversation thread; CoCalc CRM owns
the prospect, review workflow, throttling, follow-up task, and audit history.

~~~sh
cocalc docs show admin/crm-outreach --include-admin
cocalc admin crm outreach --help
cocalc admin crm outreach diagnostics --json
cocalc admin crm outreach limits --json
~~~

Admins working in the browser should use the [CRM outreach UI
guide](/app-docs/admin/crm-outreach-ui). The [general CRM UI
guide](/app-docs/admin/crm-ui) covers Customer 360, contacts, opportunities,
and shared tasks.

## Safety model

- Outreach is seed-global and admin-only. Mutations preview by default and a
  committed mutation requires fresh authentication, \`expected_version\`, and
  the preview's idempotency key.
- Sending is disabled independently from visibility and drafting. Enable it
  only after diagnostics reports valid Zendesk and webhook configuration.
- Every recipient must be a reviewed CRM contact with an active relationship
  to the target organization and a reviewed email address.
- Suppressions, duplicate checks, organization cooldowns, per-domain limits,
  and global limits are rechecked when work is claimed, not only at preview.
- CoCalc records \`notification_requested\`; it does not claim that an email was
  delivered. Zendesk and its notification trigger remain authoritative.
- Never use this system for bulk marketing lists. It is designed for one
  recipient or a deliberately small reviewed batch.

## Prepare one reviewed outreach

Search before creating anything, and create an opportunity and contact when
they do not already exist. Every mutation below is intentionally shown twice:
the first command previews and makes no change; the second repeats the exact
command with the preview's \`expected_version\` and \`idempotency_key\` and
commits it. Use \`result.id\` from the committed batch response as
\`<batch-id>\`.

~~~sh
# PREVIEW ONLY — this command does not create a batch.
cocalc admin crm outreach batch create \
  --name "Example University adoption pilot" \
  --purpose "Offer a reviewed institutional adoption pilot" \
  --kind adoption_pilot --owner admin@example.com \
  --template adoption-pilot \
  --reason "Prepare a reviewed pilot offer" --json

# COMMIT — create the exact reviewed batch.
cocalc admin crm outreach batch create \
  --name "Example University adoption pilot" \
  --purpose "Offer a reviewed institutional adoption pilot" \
  --kind adoption_pilot --owner admin@example.com \
  --template adoption-pilot \
  --reason "Prepare a reviewed pilot offer" \
  --expected-version <expected-version-from-preview> \
  --idempotency-key <idempotency-key-from-preview> --commit --json

# PREVIEW ONLY — this command does not add the recipient.
cocalc admin crm outreach batch add <batch-id> \
  --person ada@example.edu --organization CRM-2026-000123 \
  --opportunity <opportunity-id> \
  --reason "Ada is the reviewed institutional contact" --json

# COMMIT — add the exact reviewed recipient.
cocalc admin crm outreach batch add <batch-id> \
  --person ada@example.edu --organization CRM-2026-000123 \
  --opportunity <opportunity-id> \
  --reason "Ada is the reviewed institutional contact" \
  --expected-version <expected-version-from-preview> \
  --idempotency-key <idempotency-key-from-preview> --commit --json

cocalc admin crm outreach preview <batch-id> --json
~~~

Templates are immutable revisions. Create a draft revision, review its exact
rendered subject and body, then activate it. Merge fields are allowlisted and
HTML in Markdown is disabled. A custom per-recipient subject or body is stored
as an exact immutable snapshot before approval.

## Approve and queue

Approval freezes recipient and content snapshots. Queueing makes the worker
eligible to create exactly one proactive Zendesk ticket per recipient. The
approval commit changes the batch version, so preview queueing only after the
approval commit succeeds; do not reuse the approval version or idempotency key.

~~~sh
# PREVIEW ONLY — this command does not approve the batch.
cocalc admin crm outreach approve <batch-id> \
  --reason "Reviewed exact content" --json
# COMMIT — approve the exact reviewed batch snapshot.
cocalc admin crm outreach approve <batch-id> \
  --reason "Reviewed exact content" \
  --expected-version <approval-expected-version> \
  --idempotency-key <approval-idempotency-key> --commit --json

# PREVIEW ONLY — this command does not queue the batch.
cocalc admin crm outreach queue <batch-id> \
  --reason "Approved for controlled send" --json
# COMMIT — queue the exact reviewed batch snapshot.
cocalc admin crm outreach queue <batch-id> \
  --reason "Approved for controlled send" \
  --expected-version <queue-expected-version> \
  --idempotency-key <queue-idempotency-key> --commit --json

cocalc admin crm outreach list \
  --state queued,creating_ticket,notification_requested,replied --json
cocalc admin crm outreach show <delivery-id> --json
~~~

Valid delivery states are \`draft\`, \`approved\`, \`queued\`,
\`creating_ticket\`, \`notification_requested\`, \`replied\`, \`closed\`,
\`suppressed\`, \`failed\`, and \`cancelled\`. There is no \`sent\` delivery
state because Zendesk notification and actual email delivery are distinct
events.

The provider operation has a stable external id. On a timeout, retry or
reconcile the same delivery; do not create a replacement batch or ticket.
Pause or cancel a batch to stop work that has not started. A cancellation does
not erase tickets or messages already created.

## Replies, view observations, and follow-up

Requester replies are synchronized from Zendesk into the CRM timeline and
complete the open outreach follow-up task. MyReadReceipt observations are
stored as immutable engagement events when they can be tied strictly to the
configured integration and Zendesk comment. A view observation is useful
evidence, but it is not proof that a human read or understood the message and
it never completes the task.

The standard policy is:

1. Send creates one waiting follow-up task, due after the configured interval
   (seven days by default).
2. A reply completes the task and moves the shared work to the relationship
   owner.
3. Viewed with no reply is shown as “view observed, no reply” and is eligible
   for a concise same-thread follow-up after review.
4. No view and no reply should first prompt delivery/address verification,
   rather than a more aggressive message.
5. After the configured maximum follow-ups (two by default), the task becomes
   a final review. Close the opportunity as no response or set a deliberate
   later action; do not continue an automatic sequence.

~~~sh
cocalc admin crm outreach followups list --overdue --unreplied --json
cocalc admin crm outreach followups list --viewed --unreplied --json
cocalc admin crm outreach engagement <delivery-id> --json
cocalc admin crm outreach followups preview <delivery-id> --json

# PREVIEW ONLY — this command does not queue the follow-up.
cocalc admin crm outreach followups send <delivery-id> \
  --body-file follow-up.md --reason "Reviewed seven-day follow-up" --json

# COMMIT — queue the exact reviewed same-thread follow-up.
cocalc admin crm outreach followups send <delivery-id> \
  --body-file follow-up.md --reason "Reviewed seven-day follow-up" \
  --expected-version <expected-version-from-preview> \
  --idempotency-key <idempotency-key-from-preview> --commit --json
~~~

Follow-ups are never sent automatically. An admin reviews the current ticket,
exact body, suppression state, limits, and timing before queueing a public
comment on the existing Zendesk ticket.

## Suppression and opt-out

An opt-out, provider complaint, hard bounce, or manual suppression immediately
prevents new work and cancels queued delivery/follow-up work in its scope.
The public opt-out endpoint uses an opaque one-time-looking token and always
returns a generic confirmation page.

~~~sh
cocalc admin crm outreach suppressions list --json

# PREVIEW ONLY — this command does not yet block outreach.
cocalc admin crm outreach suppressions add --scope email \
  --value ada@example.edu --suppression-reason manual \
  --note "Requested no further proactive contact" \
  --reason "Recorded contact preference" --json

# COMMIT — apply the exact reviewed suppression.
cocalc admin crm outreach suppressions add --scope email \
  --value ada@example.edu --suppression-reason manual \
  --note "Requested no further proactive contact" \
  --reason "Recorded contact preference" \
  --expected-version <expected-version-from-preview> \
  --idempotency-key <idempotency-key-from-preview> --commit --json
~~~

Revoking a suppression requires a reviewed reason and does not automatically
resume cancelled work.

## Configuration and controlled validation

Admins configure all outreach limits and provider identifiers under Site
Settings. Effective values are hard-clamped by the server, reload without a
deploy, and are exposed by \`outreach limits\`. Keep delivery disabled until:

1. The shared support address, Zendesk group, form, submitter, trigger, and
   webhook are configured and diagnostics is healthy.
2. A proactive ticket with a public comment notifies a controlled internal
   requester, and that requester's reply appends to the same ticket.
3. The webhook signature is rejected when invalid or stale.
4. A clearly labelled test message exercises reply, view observation,
   suppression, timeout reconciliation, and follow-up without duplicates.

Use a subject and first line such as \`[TEST CRM OUTREACH - DO NOT ACTION]\` for
all tests against the real Zendesk tenant. Never use an actual prospect as a
test recipient.
`;

export const ADMIN_CRM_OUTREACH_UI_BODY = String.raw`
## What the Outreach workspace is for

Open **Admin → Customers → Outreach** to prepare and monitor a small number of
reviewed, proactive institutional conversations. The workspace keeps outreach
visible to the whole team without turning CRM into an email client: CoCalc owns
review, throttling, suppressions, follow-up, and audit history, while Zendesk
owns the external conversation and requester replies.

Use the [general CRM UI guide](/app-docs/admin/crm-ui) to create or review the
customer, contact, opportunity, and owner first. Agents automating this work
should use the [CRM outreach CLI runbook](/app-docs/admin/crm-outreach).

## Check the workspace before composing

1. Read the status banner and queue summary. Do not prepare new sends if
   diagnostics report provider, consistency, or webhook problems.
2. Check the minute, hour, and day usage before planning a batch. Site-wide,
   per-domain, and organization cooldown limits are enforced again when the
   worker claims a delivery.
3. Filter **Deliveries** by recipient, state, engagement, owner, kind, batch,
   organization, opportunity, suggested action, Zendesk ticket, or date.
4. Open an existing delivery or batch before creating a replacement. A timeout
   may require reconciliation of the original provider operation, not another
   ticket.

The state \`notification_requested\` means CoCalc asked Zendesk to notify the
requester. It is not a claim that an email was delivered or read. A view
observation may come from a mail proxy or security scanner and is context, not
proof that a person read the message.

## Compose reviewed outreach

1. In **Templates**, choose an active template whose purpose matches the
   conversation. Create a new immutable revision when the shared wording needs
   to change; do not silently repurpose an unrelated template.
2. In **Batches**, create a draft with a clear business purpose, outreach kind,
   responsible owner, and active template.
3. Add a reviewed CRM contact to the draft. Verify the organization,
   opportunity, selected email, and any cooldown warning. A custom subject or
   body becomes an exact recipient snapshot rather than changing the template.
4. Keep batches deliberately small. This workspace is for reviewed
   relationship outreach, not bulk marketing lists.

Creating a template, batch, or recipient uses the same two-step safety flow as
other CRM changes: choose **Review change**, inspect the proposed fields and
warnings, then choose **Confirm with fresh auth**. Closing the review makes no
change.

## Review, approve, and queue

1. Open the draft batch and choose **Review exact messages**.
2. Read every recipient, subject, body, footer, merge result, warning, and
   blocking error. Fix the underlying CRM contact or draft instead of approving
   around a blocking error.
3. Approve only when the frozen recipient count and exact message snapshots are
   correct. Approval does not contact anyone.
4. Queue the approved batch only when delivery is enabled and diagnostics are
   healthy. Queueing creates durable work; the seed worker later performs the
   rate-limited Zendesk operation.
5. Pause or cancel queued work when circumstances change. Already-created
   Zendesk tickets and public messages remain part of the audit history.

Open a delivery to inspect its exact approved opening message, provider
attempts, engagement observations, and redacted Zendesk thread. Use Zendesk for
the complete authoritative conversation.

## Record suppressions immediately

Use **Suppressions** when a person opts out or when an address, person,
organization, or domain must not receive proactive contact. Choose the narrowest
scope that satisfies the request, record the real reason and a useful internal
note, then review and confirm the change.

An active suppression blocks queued and future outreach in its scope. Revoking
one requires a separately reviewed reason and does not resume cancelled work.
Never remove an opt-out merely to get a batch through preflight.

## Follow up without an automatic sequence

The opening message creates a shared follow-up task. Use the delivery filters
and queue summary to find due or overdue work, including **View observed, no
reply**. Then:

1. Open the delivery and inspect the latest redacted Zendesk thread,
   suppression state, view caveat, prior attempts, and current suggested action.
2. For no view and no reply, verify delivery and the address before sending a
   more forceful message.
3. For a view observation with no reply, consider one concise, reviewed
   same-thread follow-up. The observation does not complete the task.
4. Enter the exact follow-up body, choose **Review change**, and confirm with
   fresh authentication. Follow-ups are never sent automatically.
5. A requester reply completes the waiting task. After the configured maximum
   follow-ups, perform the final review and either close as no response or set a
   deliberate later action.

## Safe handoffs

- Continue public conversation and ticket status work in Zendesk.
- Continue opportunity ownership and ordinary internal tasks in Customer 360.
- Continue quotes, invoices, collection, payment, and fulfillment in
  **Admin → Accounts Receivable**.
- Use Site Settings for outreach feature gates, provider identifiers, webhook
  secrets, and rate limits. Keep delivery disabled until controlled validation
  is complete.
- Never put payment credentials, passwords, private keys, unrestricted provider
  payloads, or unrelated personal data in outreach notes or audit reasons.
`;

export const ADMIN_CRM_UI_BODY = String.raw`
## What the Customers workspace is for

Open **Admin → Customers** to see the shared operational record for an
institution or other customer. The workspace brings together reviewed
identity, contacts, opportunities, follow-up tasks, support references,
commercial orders, site licenses, and a chronological timeline. Zendesk,
Accounts Receivable, Stripe, and site-license administration remain the
authoritative systems for their own work.

The customer number, such as \`CRM-2026-000123\`, is the stable identifier to
use when discussing a record with another admin or an agent.

## Find the right customer first

1. Choose a **View** to narrow the queue to prospects, pilots, renewals,
   expansions, overdue follow-up, or another operational group.
2. Search by customer name, alias, domain, contact, or customer number.
3. Open the record and verify its domains, contacts, linked systems, and
   relationship owner before adding anything.
4. Create a customer only when search shows that no appropriate record exists.

The summary cards describe the currently visible queue. **Data quality and
follow-up diagnostics** finds records that need ownership, tasks, or system
links; it does not change data.

## Work in Customer 360

The customer page is organized around the team's normal workflow:

- **People** records decision makers, instructors, billing contacts, and other
  reviewed contacts. A contact may also link to a verified CoCalc account and
  include a reviewed website, LinkedIn, Facebook, or X profile. Use **Edit** on
  a contact card to maintain these fields.
- **Pipeline** records a constrained opportunity such as an adoption pilot,
  renewal, or expansion. When terms are accepted, hand the won opportunity to
  Accounts Receivable instead of copying payment details into CRM.
- **Follow-up** records the next internal action with an admin assignee and due
  date. Use concise, actionable subjects such as “Obtain purchase order”.
- **Commercial and support systems** links stable Zendesk, Stripe, commercial
  order, and site-license identifiers. The linked systems retain authority for
  conversation, payment, fulfillment, and entitlement state.
- **Timeline** is an append-only operational history. Use its filter to find
  events by summary, details, source, type, date, or ticket/order identifier.

The optional internal note on a person is for concise, stable context about
that contact. Use **Add note** for dated relationship events and other durable
customer context that is not itself a task. Never store card data, banking
credentials, passwords, private keys, or unrestricted provider payloads in
CRM.

## Review and confirm changes

CRM changes use a two-step safety flow:

1. Complete the form and choose **Review change**.
2. Read the proposed fields, warnings, and audit reason in the preview.
3. Choose **Confirm with fresh auth** and complete the browser verification.

If the record changed after preview, refresh it and review a new proposal rather
than retrying stale data. Closing a preview makes no change. The audit reason
should explain why the action is appropriate, not merely repeat the button
label.

## Common handoffs

- Continue support conversations and ticket status changes in Zendesk.
- Continue invoicing, collection, payment verification, and fulfillment in
  **Admin → Accounts Receivable**.
- Continue seat pools, domains, managers, and entitlement details in
  site-license administration.
- Use the [CRM outreach UI guide](/app-docs/admin/crm-outreach-ui) to compose,
  review, suppress, and follow up on proactive institutional conversations.
- Use the [agent and CLI runbook](/app-docs/admin/crm) for automation, exact
  commands, diagnostics, merges, backfill, and system boundaries.
`;

export const ADMIN_SOFTWARE_COMMAND_BODY = `
## What cocalc software is for

The \`cocalc software\` command is the high-level operator interface for taking
changes in the \`cocalc-ai\` source tree and turning them into immutable
artifacts, public release-channel promotions, site-profile deploys, smoke
checks, deployment history, and rollback targets. Use it from inside the
\`cocalc-ai\` git repository when you want to build a component, push it to the
software store, deploy or promote it, and then verify exactly what happened.

This page is only an orientation. The source-of-truth command reference is the
CLI itself:

~~~sh
cocalc software info
cocalc software info hub
cocalc software info plus --json
~~~

Use human mode when operating manually. Use \`--json\` when an agent needs a
structured component map with lifecycle notes, common failure modes, and
recommended commands.

## Lifecycle

~~~text
cocalc-ai source
      |
      v
software build <component>[:<tag>]
      |
      v
local immutable artifact store
      |
      v
software push <component>[:<tag-or-id>]
      |
      v
R2 software artifacts + indexes
      |
      v
software deploy <component>[:<tag-or-id>] <profile-or-channel>
      |
      v
target: Rocket bay, project-host fleet, release channel, or GitHub Star channel
      |
      v
software smoke/history/rollback
~~~

Deployment history is written to the durable software store, not only to the
target bay or host. A deploy writes a started record before mutating the target
and seals it as succeeded or failed afterwards; an unsealed record should be
treated as unknown.

## Target map

~~~text
Bay profile target
  static, hub, bay, bay-conat-router, bay-conat-persist,
  bay-frontdoor, bay-cloudflared, bay-scaffold

Project-host fleet target
  project-host, project, tools, container-runtime,
  host-conat-router, host-conat-persist, host-acp-worker, host-runtime-stack

Release channel target
  cli, launchpad, plus

GitHub Star channel target
  star
~~~

Site-profile targets use a profile from \`cocalc auth list\`. Release-channel
targets use \`dev\`, \`candidate\`, or \`stable\`. Keep the profile or channel
explicit when deploying and inspecting results.

The selected fleet components below have different deployment effects.
Do not assume omitting \`--rollout\` prevents changes to running hosts:

| Component | Effect of \`software deploy\` |
| --- | --- |
| \`project-host\`, \`host-conat-router\`, \`host-conat-persist\`, \`host-acp-worker\`, \`host-runtime-stack\` | Starts a canary-first fleet campaign for the selected managed components without requiring \`--rollout\`. |
| \`project\` | Changes the fleet default. Add \`--rollout\` to upgrade online hosts as part of the command. |
| \`tools\` | Changes the fleet default and upgrades online hosts without requiring \`--rollout\`. |
| \`container-runtime\` | Publishes compatibility artifacts without changing fleet desired state. \`--rollout\` is rejected; selecting and qualifying hosts for an upgrade is a separate operation. |

## Components

| Component | What it is |
| --- | --- |
| \`static\` | Browser frontend, public assets, webapp assets, and setup scripts served by a bay. |
| \`hub\` | Bay hub worker/control-plane runtime for APIs, routing, and backend logic. |
| \`bay\` | Full Rocket bay runtime artifact and broad bay-side operational escape hatch. |
| \`bay-conat-router\` | Bay-side Conat router service, deployed from a \`bay\` artifact with a scoped service restart. |
| \`bay-conat-persist\` | Bay-side Conat persist service, deployed from a \`bay\` artifact with a scoped service restart. |
| \`bay-frontdoor\` | Bay frontdoor/sticky-session service in front of hub workers. |
| \`bay-cloudflared\` | Bay Cloudflare tunnel helper and related service wiring. |
| \`bay-scaffold\` | Bay systemd units, scripts, and environment templates without a full app rollout. |
| \`project-host\` | Project-host agent/runtime that supervises projects and host-side services. |
| \`project\` | Runtime bundle used inside user projects for project daemons and project-level services. |
| \`tools\` | Full project tools payload for Linux amd64 and arm64 project hosts. |
| \`container-runtime\` | Host container-runtime artifact; deploy publishes compatibility artifacts without starting a fleet rollout. |
| \`tools-minimal\` | Small tools payload coordinated with CoCalc Plus; build/push only as a standalone component. |
| \`host-conat-router\` | Project-host-local Conat router managed component. |
| \`host-conat-persist\` | Project-host-local Conat persist managed component. |
| \`host-acp-worker\` | Project-host ACP worker managed component. |
| \`host-runtime-stack\` | Combined project-host, Conat router, Conat persist, and ACP worker campaign. |
| \`cli\` | Standalone \`cocalc\` command-line binary promoted through release channels. |
| \`launchpad\` | Standalone local hub/runtime launcher promoted through release channels. |
| \`plus\` | CoCalc Plus release-channel product, coordinated with \`tools-minimal\`. |
| \`star\` | Self-hosted CoCalc distribution promoted through GitHub Star channel releases. |

## Minimal operator pattern

~~~sh
cocalc software build hub:fix-name
cocalc software deploy hub:fix-name staging
cocalc software smoke hub staging
cocalc software history hub staging
~~~

For release-channel products, replace the site profile with a channel:

~~~sh
cocalc software deploy cli:fix-name candidate
cocalc software smoke cli candidate
~~~

For the exact component behavior, run \`cocalc software info <component>\` before
deploying.

## Read a fleet campaign result

\`host deploy rollout-fleet\` operates on one authoritative bay. The CLI
excludes hosts pinned for the selected components and rejects a mixed-bay
cohort. It runs the canary first, requires a continuous healthy stabilization
interval, then continues in bounded waves. A failed host or automatic rollback
stops later waves; hosts from completed waves may already have changed.

The direct \`host deploy rollout-fleet\` command returns a queued operation
unless \`--wait\` is supplied. \`software deploy\` supplies \`--wait\` for these
campaigns. Inspect the operation ID and per-host results, including excluded
hosts; queued work is not a completed upgrade. Default promotion happens after
all waves succeed and its promotion checks pass; the direct host command's
\`--no-promote-global\` option leaves successful hosts as explicit exceptions.
Software rollback deploys the selected artifact from successful deployment
history; it does not restore project files or database contents.

## Interpret readiness evidence

After a change, review the evidence for the affected layer:

- A successful \`rocket health host-routes\` check verifies routes from bay
  frontdoor workers to project-host APIs. It does not execute a notebook or
  verify a research result.
- With an explicit site profile, \`cocalc --profile <profile> admin health --wide\`
  reports individual operator checks, timestamps, latency observations, the
  latest recorded smoke result, and backup/restore-test status. Review the
  selected bay, sample coverage and each check; unknown, missing or stale
  evidence is not a successful check.
- A recorded smoke success covers its recorded steps and project. Verify the
  affected terminal or kernel, file synchronization and required application
  with a representative disposable workload before declaring that workflow
  ready. Backup enablement alone does not prove a successful restore.

These are source-backed command and result boundaries. No fleet campaign,
rollback, workload or restore was executed to validate this reference.
`;

export const ADMIN_BAY_OPS_BODY = String.raw`
## What Bay Operations is for

Bay Operations is the admin overview for a multi-bay CoCalc-ai deployment. Use
it to see which bays are alive, how much work each bay owns, whether rehome
operations are running or failing, and whether backup or load projections need
attention.

## What to check first

1. Open the Admin tab.
2. Open **Bay Operations**.
3. Check heartbeat status for every bay.
4. Review account, project, and project-host ownership counts.
5. Look for failed or running rehome operations.
6. Open bay details when backup health or load projections look suspicious.

The detail view includes copyable commands for common bay inspection and
diagnostic workflows. Prefer those typed commands over ad hoc database queries.

## Ownership model

Account-private state belongs on the account home bay. Project data belongs on
the project owning bay. Project-host operations belong on the host bay. When
moving accounts, projects, or hosts, verify both the database owner fields and
the corresponding filesystem or conat-persist state.

## Safety

Bay operations are control-plane work. Do not change ownership fields manually
unless the documented move operation cannot run and you have already inspected
the source and destination bays.
`;

export const ADMIN_ROOTFS_BODY = String.raw`
## What RootFS administration is for

RootFS administration manages the runtime image catalog and the images cached
on project hosts. Use it when a runtime image should be published, hidden,
blocked, deleted, garbage-collected, or scanned on a real host.

## Common workflow

1. Open the Admin tab.
2. Open **RootFS Images**.
3. Filter for the catalog entry you care about.
4. Inspect central lifecycle state and per-host availability.
5. If scanning is enabled and the entry references a managed release, choose
   **Scan now**, then select an online project host.
6. Hide or block images before deleting when users may still depend on them.

Scanning is disabled by default. **RootFS Scan: Enabled** in Site Settings
controls the scan UI and manual scan requests; scanning requires Trivy
image/cache storage and project-host scan capacity. An online host alone is not
sufficient if scanning is disabled or the catalog entry has no managed release.
When scanning is enabled, choose an available online host before expecting
results.

## When to use this page

Use RootFS administration after changing runtime-image build or retention
policy, when a project host fails to pull an image, or before removing old
images from the catalog.
`;

export const ADMIN_BACKUP_SHARDS_BODY = String.raw`
## What backup shards are for

Backup shards describe where project backups are stored and how backup capacity
is split across the deployment. Admins use this page to inspect shard
configuration and avoid silent backup-capacity or routing mistakes.

## Review backup shards

1. Open the Admin tab.
2. Open **Backup Shards**.
3. Confirm the expected shards are present.
4. Check that shard metadata matches the intended deployment.
5. Use **Bay Operations** to inspect bay backup health if a shard looks stale or
   overloaded.

Backups are a safety boundary. Treat edits as operational changes that need a
clear reason, a rollback path, and a small verification afterwards.
`;

export const ADMIN_REGISTRATION_TOKENS_BODY = String.raw`
## What registration tokens are for

Registration tokens control special signup and onboarding flows. Use them for
private cohorts, managed classrooms, migrations, pilots, and sites where
ordinary email signup is restricted.

## Create or update a token

1. Open the Admin tab.
2. Open **Registration Tokens**.
3. Create a token or edit an existing one.
4. Confirm intended limits, expiration, and account effects.
5. Test the signup path with a non-admin account before sharing it widely.

For token-only email signup, leave **Allow email signup** enabled in **Site
Settings**, then turn off **Public signup without a registration token** in
**Registration Tokens**. Disabling **Allow email signup** blocks new email
accounts even when they have a token. Review SSO signup policy separately; see
[Signup emergency controls](/docs/admin/signup-emergency-controls).

## Safety

Tokens grant access to the site. Keep names and descriptions clear enough that
another admin can tell why the token exists and when it should be removed.
`;

export const ADMIN_SIGNUP_EMERGENCY_CONTROLS_BODY = String.raw`
## What this runbook is for

Use this during a launch incident when new-account creation is causing abuse,
support load, or operational risk. These controls affect new signups only; they
do not stop existing users, existing projects, active sessions, or billing
records.

## Fast close: require registration tokens

1. Open **Admin -> Registration Tokens**.
2. Turn off **Public signup without a registration token**.
3. Confirm there is at least one active registration token if invite-only
   signup should continue.
4. If there are no active tokens, email/password signup is effectively closed
   until an admin creates an active token or re-enables public signup.
5. Verify in a private browser session that creating a new account requires a
   token.

This is the preferred first response because it preserves controlled onboarding
for known cohorts while blocking public anonymous account creation.

## Full close: disable email signup

1. Open **Admin -> Site Settings**.
2. Find **Access & Identity -> Signup**.
3. Set **Allow email signup** to **no**.
4. Save and verify in a private browser session that the email/password signup
   path is unavailable.

Use this when even token-gated email/password signup should stop. This is more
disruptive than requiring registration tokens.

## Narrow close: restrict signup domains

1. Open **Admin -> Site Settings**.
2. Find **Access & Identity -> Signup**.
3. Set **Signup email domain policy** to **Allow only listed domains**.
4. Add the allowed domains, for example \`example.edu\` or
   \`*.example.edu\`.
5. Optionally set a public message explaining who can sign up.
6. Save and verify one allowed address and one blocked address.

Use domain restrictions when abuse is coming from disposable or unrelated email
domains but a known institution or pilot group should continue onboarding.

## SSO account creation

If SSO is enabled, also review **Access & Identity -> Single Sign-On** and any
domain-specific SSO policies. Prefer **Registration token required** or
**Disabled** for SSO account creation during an incident. Otherwise users may
still create accounts through an SSO path even when ordinary email signup is
closed.

## Reopen checklist

1. Decide whether reopening should be public, token-gated, or domain-limited.
2. Re-enable only the needed path.
3. Test signup in a private browser session.
4. Leave a short admin note or incident note with the old and new values.

## Related emergency switches

The **Launch Emergency Controls** in **Admin -> Site Settings** stop specific
post-signup capabilities such as project creation, free project starts,
dedicated-host creation, AI/Codex, and payment checkout. Use those when the
incident is not primarily new-account creation.
`;

export const ADMIN_MEMBERSHIP_AND_LICENSES_BODY = String.raw`
## What membership tiers and software licenses are for

Membership tiers describe site-level capabilities and usage limits. Software
licenses describe purchasable or assignable license packages. Together they
control many commercial and access-policy workflows.

## Membership tiers

Use **Membership Tiers** to define or adjust standard capability bundles. Pay
special attention to dedicated-host fields such as host creation, project-host
tier, and dedicated-host usage limits. Creating hosts still also requires
normal billing and admission checks.

## Software licenses

Use **Software Licenses** to manage license tiers and concrete licenses. License
configuration can control project upgrades, max project hosts, and other
resource limits.

## Safety

Small-looking changes can affect future purchases, existing users, or dedicated
host access. Record the old value before changing limits, then verify with an
account that should receive the updated capability.
`;

export const ADMIN_MANAGED_EGRESS_BODY = String.raw`
## What Network Egress is for

Network Egress tracks managed egress that CoCalc attributes to accounts,
projects, and categories. It gives admins an operational view into recent
network usage so they can investigate unexpected traffic, understand limit
pressure, and connect support reports to concrete account or project activity.

## Review site-wide egress

1. Open the Admin tab.
2. Open **Network Egress**.
3. Choose the time range that matches the support or operations question.
4. Review top accounts, top projects, categories, and recent events.
5. Drill into the relevant user or project when the aggregate view points to a
   specific owner.

The site-wide view is for triage. It helps answer "who or what is producing
traffic right now?" before deciding whether the next step is account support,
project inspection, membership limits, or infrastructure investigation.

## Account-level egress

The admin user detail view also exposes recent and historical managed egress
for a specific account. Use the account-level view when a user asks why they
are over a managed-egress limit, or when you need to correlate traffic with
that account's projects and membership entitlements.

## Safety

Managed egress data can reveal operational behavior of user projects. Treat it
as support and abuse-investigation data. Prefer summarizing categories and
amounts rather than copying raw event details into tickets unless the ticket
needs that evidence.
`;

export const ADMIN_SSO_BODY = String.raw`
## What SSO administration is for

SSO administration configures single sign-on providers and domain policies for
a CoCalc site. Use it when an institution or organization needs SAML login,
domain-managed signup behavior, or a policy that requires users from a domain
to use a specific identity provider.

## Configure an SSO provider

1. Open the Admin tab.
2. Open **SSO Providers & Domains**.
3. Add or edit the provider.
4. Paste metadata XML when available so the form can fill the entity ID, SSO
   URL, and signing certificate.
5. Save the provider, then test sign-in with a non-admin account that belongs
   to the target domain.

Prefer metadata import over manual copy/paste. Manual fields are useful for
debugging, but metadata reduces transcription mistakes in certificates and
service URLs.

## Configure domain policy

Domain policies decide how users with matching email domains sign in. A domain
can allow passwords, require SSO, allow signup through SSO only, and optionally
require CoCalc-native 2FA. Keep policy names and notes clear enough that
another admin can understand why the rule exists.

Enabling **Require CoCalc 2FA** also changes onboarding: SSO cannot create a
new account for that domain. An admin must create or prepare the account first.
Existing accounts must already have a CoCalc second factor enabled before
signing in through SSO, and sign-in then requires that second factor. Prepare
this access before requiring native CoCalc 2FA for a domain.

## Safety

SSO policy changes can lock users out. Before requiring SSO for a domain,
verify that the provider works, that at least one admin has an alternate access
path, and that support knows how users should recover if their institutional
identity is unavailable.
`;
