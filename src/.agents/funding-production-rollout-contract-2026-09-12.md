# Production Funding Rollout Contract

Live freeze started 2026-09-12 21:48 UTC. Do not compile or restart during Main's
CPU/approval run. Existing isolated-QA APIs and verifier remain unchanged.

## Consumed Evidence

The production startup path will consume an Ed25519-signed deployment manifest,
not a singleton heartbeat or enable flag. Reuse `canonicalFundingTerms` and Node
crypto as in the repository's software-license verifier. Deployment tooling,
not the hub, owns the signing key and attests completed rollout/revocation.

The document must cover exactly all configured/registered bays. Each bay checks
its actual PG cluster system identifier, database and login role; its explicit
compute deployment namespace; its named writer/build/protocol; and the signed
coverage inventory. All bay responses must reference the same manifest digest.
Unknown bay, omitted role, old protocol, wrong credential identity, invalid
signature, expired document or failed bay RPC blocks new commitments only.

## Owner Coordination

Current source checkpoint: baseline concrete `account-writer-rollout.ts` and
`resource-writer-rollout.ts` are implemented and consumed by startup. Lagrange
and Nietzsche should review/refine those modules, not create duplicate providers.
Main fixed the canonical JSON imports; preserve that change. No build or PG tests
during Main's hub restart/readiness check.

### Multi-Bay Exposure (API Owner / Nietzsche)

API owner supplies `getProductionFundingExposureAllocation()` from
`production-rollout-manifest.ts`. It validates the operator signature, exact bay
inventory and pinned deployment, and returns:
`{allocation_id,manifest_digest,bay_id,quota_usd,site_ceiling_usd,expires_at}`.
Manifest `exposure_allocation` is mandatory for multiple bays, with
`{id,site_ceiling_usd,bay_quotas:[{bay_id,amount_usd}]}`. All bays must appear once;
nonnegative exact decimal quotas sum to at most the signed positive site ceiling.
`COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256` pins
`fundingExposureAllocationDigest(manifest)` independently of manifest renewal.

Nietzsche owns consumption in actual reservation/renewal/resize admission:
resolve outside the money transaction, then check expiry, local payer-home bay,
and signed site ceiling against the current configured site ceiling inside the
existing bay exposure advisory lock. Compare _all_ local outstanding resource
obligations plus the increment against quota_usd. Do not touch settlement cleanup.
This replaces the unconditional multi-bay denial; one-bay QA remains unchanged.
No duplicate edits to vm-reservations.ts by API owner.

Quotas are static for the pinned allocation lifetime. Redistribution is an
operator drain/fence deployment: stop admission under the old allocation on all
bays, preserve/count every existing reservation (including account rehomes),
then activate the new pins. A signed document is NOT permission to roll quota
changes independently across still-active old workers. No automatic quota move.

Lagrange: please review the implemented `account-writer-rollout.ts` export
`verifyFundingAccountWriters(manifest, bay): Promise<void>`.
The consumer passes a signature-validated `FundingRolloutManifest` and the local
`FundingRolloutBay`. Check actual database writer-role privileges/current role,
retired roles disabled/no remaining sessions, and complete role coverage for
purchase/refund/membership/renewal/top-up/transfer/project-admission writers.
Do not accept an inventory with omitted active writer credentials. Named
operator DB roles may be explicitly inventoried; they remain an operator trust
boundary, not application worker credentials. Preserve the independent transfer
feature flag.

Nietzsche: please review the implemented `resource-writer-rollout.ts` export
`verifySponsoredResourceWriters(manifest, bay): Promise<void>`.
Validate the actual namespace and configured cloud/DNS credential identities
against the signed inventory. Require old queue workers and orphan/DNS sweep
credentials excluded by the deployment rollout, not simply renamed new VMs.
Signed revocation receipts are operator attestation, never a claim that this hub
queried the provider's IAM control plane when it did not. Identify missing
credential identity accessors now so the startup path can consume them.

API owner owns signed parsing, bounded freshness, exact bay coverage, identity
binding, startup selection, common-manifest fanout check and registered caller
tests. The concrete manifest TypeScript contract is in
`server/compute/funding/production-rollout-contract.ts`. Production is usable once an
operator configures a valid manifest; missing configuration remains closed.

## Safety Boundaries

- The deployment operator is trusted to attest the completed fleet rollout and
  provider credential revocations. Hubs verify signed claims plus observable
  identities/DB fencing; they do not mint their own production proof.
- Short-lived manifests, pinned operator public key and expected rollout ID
  prevent unrelated deployment documents and stale epochs being accepted.
- Providers return the existing `FundingRolloutEvidence` shape; no public API
  changes are needed. Evidence IDs include the manifest digest for same-rollout
  validation across bays.
- Reads/status/stop/delete/settlement/closure continue when proofs expire or the
  feature is disabled. No credential mutation, repair or automatic revocation
  is performed by the verifier.

## Operator Configuration

Set absolute, operator-owned, non-group/world-writable file paths for
`COCALC_FUNDING_ROLLOUT_MANIFEST` and `COCALC_FUNDING_ROLLOUT_PUBLIC_KEY`.
Pin `COCALC_FUNDING_ROLLOUT_ID` and `COCALC_COMPUTE_DEPLOYMENT_ID` to the
signed document. Set each process's `COCALC_FUNDING_WRITER_ID` and
`COCALC_FUNDING_WRITER_BUILD_ID` to its attested inventory entry. Build ID can
also come from the existing Launchpad artifact or Star release environment.

Deployment tooling signs `Buffer.from(canonicalFundingTerms(manifest))` using
Node `crypto.sign(null, bytes, ed25519PrivateKey)`; envelope signature is base64.
Only the public key is installed in hubs. `isolated-writers` manifests use a
15-minute maximum validity, with every bay reporting the same manifest digest
before new admission. A one-bay `co-resident-operator-writer` deployment may use
a deployment-bound attestation valid for up to 366 days and replaces it whenever
the attested build or configuration changes; it does not require an online
signer. The DB verifier needs read permission for `pg_control_system()` and
role/activity catalogs, not permission to revoke credentials. The manifest
declares either `isolated-writers`, where application writers use dedicated
non-superuser/non-`BYPASSRLS` credentials, or
`co-resident-operator-writer`, which is limited to one bay and explicitly
accepts that hub/host compromise includes full database authority. Inventory
every actual writer and other trusted administrative login; the co-resident
model is release attestation and writer fencing, not process isolation.

Multiple bays also pin `COCALC_FUNDING_EXPOSURE_ALLOCATION_SHA256` as above.
The verifier never repairs credentials or silently enables sponsorship.
`compute_sponsorship_enabled` remains independently default off.
