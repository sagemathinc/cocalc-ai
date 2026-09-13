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
Application writers must not be database superusers. A rotation must name the
previous credential epoch and evidence for retired database and provider credentials;
bootstrap is only for a genuinely new credential inventory.

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

Manifests have at most 15 minutes of validity and need renewal while admitting
new work. Renew from current verified deployment evidence; do not extend stale
attestations blindly. Install renewed files atomically. An expired or mismatched
manifest blocks new commitments; existing stop, deletion, and settlement obligations
must continue. The runtime also checks bay inventory, actual database privileges,
compiled worker capabilities and credential identities. Exposure verification
persists an allocation policy pin: unlike the offline utility and payer audit,
runtime admission verification is not wholly read-only.

Do not enable a production pilot merely because offline verification succeeds.
Review the live capability results across all bays and complete the independent
review, bounded pilot authorization, and reconciliation gates first.

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
