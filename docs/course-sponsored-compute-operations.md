# Course-Sponsored Compute Operations

Status: development runbook. Independent accounting/security review and a
reconciled named pilot are release gates, not implied by this document.

## Attesting The Deployment

Production admission fails closed without a signed operator manifest. The
manifest is an attestation of a completed deployment, not a deployment command.
It does not revoke cloud credentials or upgrade workers. Before signing, inventory
all bays, database writers, worker builds, provider credentials, and retired
credentials. Complete the rollout and retain evidence of revocation. In particular,
a configured credential matching the manifest does not prove that an old cloud
credential has been revoked: confirm that separately with the provider.

The typed contract is
`src/packages/server/compute/funding/production-rollout-contract.ts`. Include each
bay's PostgreSQL system identifier, database name, writer and operator roles,
worker identity/build/protocol/capabilities, and deployment resource namespace.
The manifest must state the database trust model honestly:

- `isolated-writers` means request-serving writers use dedicated
  non-superuser, non-`BYPASSRLS` credentials that cannot impersonate an
  operator. This is the target defense-in-depth architecture.
- `co-resident-operator-writer` is accepted only for a one-bay deployment. It
  means the hub and PostgreSQL share a host/operating-system trust domain and
  the application writer has administrative database authority. A hub or host
  compromise can therefore fully alter the database. The signed manifest
  inventories the deployed writers and release, but does not claim process or
  database isolation.

For the co-resident model, put every application writer identity in
`writer_roles`, even when that role is also operationally privileged. Put other
privileged login roles that can mutate funding state in `operator_roles`; a role
must not appear in both lists. A rotation must name the previous credential
epoch and evidence for retired database and provider credentials; bootstrap is
only for a genuinely new credential inventory.

For multiple bays, include a fixed exposure allocation with one quota per bay.
Their sum cannot exceed the site ceiling. Its digest is pinned independently of
manifest renewal. Changing that allocation requires draining/fencing the previous
fleet, not a rolling increase on individual bays.

Build the server package before using the offline utility. Keep the Ed25519
private key on the operator's signing machine, never on a hub or project host:

```sh
node src/scripts/compute/funding-rollout.cjs sign \
  --manifest /operator/unsigned.json --private-key /operator/signing.pem \
  --output /operator/signed.json
node src/scripts/compute/funding-rollout.cjs verify \
  --manifest /operator/signed.json --public-key /operator/signing.pub.pem
```

Both commands validate the complete schema and signature without contacting a
hub. Signing refuses to overwrite an existing output. JSON output reports the
manifest digest, exposure-allocation digest, bay coverage, and expiration, not
release readiness. Install the signed envelope and public key as regular files
owned by the trusted operator/runtime user, not group/world writable.

Configure each hub/worker with absolute paths and matching identities:

```text
COCALC_FUNDING_ROLLOUT_MANIFEST=/operator/signed.json
COCALC_FUNDING_ROLLOUT_PUBLIC_KEY=/operator/signing.pub.pem
COCALC_FUNDING_ROLLOUT_ID=<manifest rollout_id>
COCALC_COMPUTE_DEPLOYMENT_ID=<manifest deployment_id>
COCALC_FUNDING_WRITER_ID=<this writer's manifest id>
COCALC_FUNDING_WRITER_BUILD_ID=<this writer's manifest build_id>
COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256=<reported allocation digest, when allocated>
```

Current one-bay deployments that explicitly accept the co-resident operator
trust boundary may instead set:

```text
COCALC_FUNDING_ROLLOUT_MODE=co-resident-advisory
```

In this mode the two default-off site settings, live writer protocol checks,
transaction-time admission recheck, and configured site exposure ceiling remain
enforced. A missing, expired, or mismatched signed manifest produces a deduplicated
admin alert but does not block new sponsorship. This mode refuses multi-bay
topologies. It is a temporary risk acceptance for deployments where the hub and
database operator are already one trust domain; it must not be used to weaken an
`isolated-writers` deployment.

`isolated-writers` manifests have at most 15 minutes of validity and need renewal
while admitting new work. A one-bay `co-resident-operator-writer` manifest is a
deployment attestation and may be valid for up to 366 days; replace it when the
deployed build, database, writer inventory, namespace, or provider credentials
change. It does not require an online signing loop. Renew either model only from
current verified deployment evidence; do not extend stale attestations blindly.
Install replacement files atomically. Outside explicit one-bay advisory mode, an
expired or mismatched manifest blocks new commitments; existing stop, deletion,
and settlement obligations must continue. The runtime also checks bay inventory,
actual database privileges,
compiled worker capabilities and credential identities. Exposure verification
persists an allocation policy pin: unlike the offline utility and payer audit,
runtime admission verification is not wholly read-only.

The co-resident model is a documented risk acceptance for a bounded one-bay
pilot, not completion of the database-isolation roadmap. Compensating controls
are exact writer/build inventory, retired-session fencing, transaction and
idempotency invariants, small payer/resource limits, provider reconciliation,
and the ability to disable new sponsorship while cleanup and settlement keep
running.

Do not enable a production pilot merely because offline verification succeeds.
Review the live capability results across all bays and complete the independent
review, bounded pilot authorization, and reconciliation gates first.

## Monthly Collection

Normal postpaid enrollment now has explicit account consent in Balance settings.
The application can propose consent but only the isolated financial approval
service can enable or disable it. Both actions are versioned and emit a durable
financial receipt/email event. An explicit opt-out supersedes legacy enrollment.
Existing trusted manual-collection overrides remain distinct from this opt-in.
Membership spending windows and course backing limits remain authoritative.

The existing automatic-payment maintenance loop calls the consent-aware collector.
It claims a monthly statement under account-home, spending and rehome locks before
contacting Stripe. The claim retains a UUID, consent version and amount; every
provider mutation uses that UUID as its idempotency prefix. Applicable taxes are
calculated through the normal invoice flow, which requires a billing address.
The normal payment processor records the payment and marks the statement paid.
The initial collector uses saved cards, not delayed bank-payment methods.

Failed or unknown attempts are retained, not reissued on the next sweep or hidden
by a newer cumulative statement. Failed attempts and attempts unconfirmed after
ten minutes suspend normal postpaid eligibility until settlement is confirmed.
Already-claimed work can complete after opt-out. A later deposit that partially
covers a closed statement prevents automatic collection of its stale full amount;
it remains for explicit settlement or the next statement.

For an uncertain attempt, inspect the authoritative statement's
\`monthly_collection\`, \`automatic_payment_intent_id\`, and \`paid_purchase_id\`,
then compare the matching Stripe invoice/payment. Invoice metadata includes
\`monthly_collection_attempt\`, account, site, purpose and tax-exclusive amount.
Do not clear the claim or start another invoice merely because an HTTP response
was lost. Use the existing payment-processing path for a confirmed paid invoice;
an unbound/unfinished provider attempt requires operator reconciliation first.
Account rehome is blocked while provider work is in flight or its payment identity
is unresolved. A bound payment identity and consent survive financial rehome.

The first implementation deliberately does not automatically retry failed cards
or infer that an absent local payment ID proves there is no provider invoice.
Operations must inspect and resolve these cases before a production pilot.

## Payer Audit

Use an account-authenticated administrator CLI against the payer's authoritative
bay. The explicit bay argument prevents accidentally treating a projection on
another bay as the ledger of record.

```sh
cocalc --api <payer-bay-api> computeFunding audit \
  --payer <payer-account-uuid> --bay <payer-home-bay-id>
```

The command is read-only. Its consistent database snapshot includes backing by
lane, open resource reservations, and discrepancies between:

- A pool and its account hold.
- A pool's spent/committed totals and its grants.
- Grant ceilings and the authorized pool when overcommit is disabled.
- Grant commitments and resource reservations.
- Reservation spending and purchase attribution.
- Purchase attribution and the actual purchase payer/amount.

It also reports uncertain provider work and stale active reservations. A stale
reservation needs investigation; it is not evidence that the VM is stopped.
Reports are bounded to 1,000 findings and 1,000 open reservations. A truncated
report is explicitly incomplete. Rehoming or inactive funding authority fails
closed rather than returning a misleading healthy snapshot. Audit requests and
completion are logged with the actor and payer identifiers.

This does **not** reconcile provider invoices, remote-bay worker state, pending
transfer deliveries, or actual cloud inventory. No findings in this report alone
are sufficient to declare a pilot reconciled.

## Investigating Reserved Credit

Account rehome does not move compute resources or copy disk contents. A new VM
using an existing home disk is placed on that disk's owning bay, with normal
provider/region/zone compatibility and funding checks. The account home still
authorizes the session and its personal funds; sponsored reservations still
belong to the instructor's payer bay. Inspect all three authorities when they
differ. The existing operation key is preserved across forwarding and retry.

1. Inspect the pool and student allowance in the course Compute budget view.
2. Run the payer audit and identify the reservation/resource UUID holding credit.
3. Inspect the resource on its owning bay, its current provider identity and
   generation, metering timestamp, financial stop, and storage deletion deadline.
4. Compare the provider's observed state with the durable operation and billing
   history. Resolve lost replies through the existing worker's idempotent retry
   path, not by creating a replacement VM under the same identity.
5. Allow settlement and closure workers to release backing only after the
   corresponding obligations finish. An unreachable provider is not proof that
   liability has ended.

Never repair a discrepancy by deleting a hold, zeroing reservations, editing
course-file amounts, marking an uncertain operation successful, or billing the
student instead of the committed payer. Preserve the evidence and investigate
the originating operation before attempting a correction.

## Safe Disablement And Rollback

Disable new sponsorship before a rollback. Do not roll back to an old worker
which interprets VM ownership as financial responsibility. Keep all financial
tables, metering, deadline enforcement, stop/delete work, and settlement running
until existing liabilities have been resolved. Turning off a frontend or an
admission flag does not cancel authorized obligations or refund incurred costs.

For a pilot, restrict the test payer and resource budgets, record all created VM,
disk, and network resource identifiers, and compare both the payer ledger and
provider inventory before widening access. Keep original project notebooks in
the project. Confirm cleanup of VM-only data without claiming that it was backed
up or synchronized.

## Isolated Development Cloud Resources

An isolated database is not enough when two development hubs share cloud
credentials. Set a distinct, stable `COCALC_COMPUTE_DEPLOYMENT_ID` **before**
creating any resources; provider and DNS ownership must be scoped so neither
hub's orphan reconciler can claim the other's resources. Do not change that
identifier while resources exist. It is an ownership identity, not a display
name or a per-restart token.

Do not enable cloud credentials until the inventory filters and destructive
cleanup paths for the configured namespace have been checked. Keep deployment
identity and bay identity stable across hub restarts, and retain the resource
inventory until cloud deletion has been confirmed.
