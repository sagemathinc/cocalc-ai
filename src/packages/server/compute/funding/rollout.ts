import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { ComputeFundingError } from "@cocalc/util/compute-funding";
import {
  FUNDING_ROLLOUT_CHECKS,
  FUNDING_WRITER_PROTOCOL_VERSION,
} from "@cocalc/util/compute-funding-rollout";
import type {
  FundingRolloutCheck,
  FundingRolloutEvidence,
  FundingRolloutCapabilities,
  SponsorshipAvailability,
} from "@cocalc/util/compute-funding-rollout";

type Verifier = () => Promise<FundingRolloutEvidence>;
const verifiers = new Map<FundingRolloutCheck, Verifier>();
const MAX_PROOF_AGE_MS = 30_000;

/** Trusted startup integration only. Providers must inspect actual writer
 * enforcement/credential fencing; feature flags and a singleton heartbeat are
 * not proof that old writers are excluded. Missing providers remain closed.
 */
export function registerFundingRolloutVerifier(
  kind: FundingRolloutCheck,
  verifier: Verifier,
): () => void {
  if (verifiers.has(kind))
    throw Error(`Funding rollout verifier already registered: ${kind}`);
  verifiers.set(kind, verifier);
  return () => {
    if (verifiers.get(kind) === verifier) verifiers.delete(kind);
  };
}

async function bounded<T>(fn: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Funding capability inspection timed out")),
          5000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function getLocalFundingRolloutCapabilities(): Promise<FundingRolloutCapabilities> {
  const checks: FundingRolloutCapabilities["checks"] = {
    "account-holds": null,
    "sponsored-resources": null,
  };
  for (const kind of FUNDING_ROLLOUT_CHECKS) {
    const verifier = verifiers.get(kind);
    if (!verifier) continue;
    try {
      checks[kind] = await bounded(verifier);
    } catch {
      /* Unverified is unavailable, never a permissive fallback. */
    }
  }
  return {
    bay_id: getConfiguredBayId(),
    protocol_version: FUNDING_WRITER_PROTOCOL_VERSION,
    checks,
    as_of: new Date().toISOString(),
  };
}

export async function sponsorshipEnabled(
  db: Pick<PoolClient, "query"> = getPool(),
  lock = false,
): Promise<boolean> {
  const { rows } = await db.query<{ value: string }>(
    `SELECT value FROM server_settings WHERE name='compute_sponsorship_enabled'${lock ? " FOR SHARE" : ""}`,
  );
  return rows.length === 1 && ["yes", "true"].includes(rows[0].value);
}

export interface SponsorshipAdmissionProof {
  expires_at: number;
  bay_ids: string[];
}
const issuedProofs = new WeakSet<SponsorshipAdmissionProof>();

async function admissionProof(): Promise<SponsorshipAdmissionProof> {
  const local = getConfiguredBayId();
  const configured = getConfiguredClusterBayCatalog().map((b) => b.bay_id);
  const multi = isMultiBayCluster() || configured.some((id) => id !== local);
  const registry = multi ? await listClusterBayRegistry() : [];
  if (multi && !registry.some((b) => b.bay_id === local))
    throw Error("Funding rollout bay registry is incomplete.");
  const bays = [
    ...new Set([local, ...configured, ...registry.map((b) => b.bay_id)]),
  ].sort();
  if (bays.length > 32)
    throw Error("Funding rollout exceeds the bounded bay limit.");
  const responses = await mapParallelLimit(
    bays,
    async (bay) =>
      bay === local
        ? await getLocalFundingRolloutCapabilities()
        : await createInterBayAccountLocalClient({
            client: getInterBayFabricClient(),
            dest_bay: bay,
            timeout: 5000,
          }).computeFundingGetRolloutCapabilities({}),
    4,
  );
  const now = Date.now();
  let expires_at = now + MAX_PROOF_AGE_MS;
  const manifestDigests = new Set<string>();
  let isolatedEvidence = false;
  responses.forEach((response, i) => {
    if (
      response.bay_id !== bays[i] ||
      response.protocol_version !== FUNDING_WRITER_PROTOCOL_VERSION ||
      !Number.isFinite(Date.parse(response.as_of)) ||
      Date.parse(response.as_of) > now + 1000 ||
      now - Date.parse(response.as_of) > MAX_PROOF_AGE_MS
    )
      throw Error("Funding rollout capability/version mismatch.");
    expires_at = Math.min(
      expires_at,
      Date.parse(response.as_of) + MAX_PROOF_AGE_MS,
    );
    for (const kind of FUNDING_ROLLOUT_CHECKS) {
      const evidence = response.checks?.[kind];
      if (
        evidence?.enforced !== true ||
        evidence.protocol_version !== FUNDING_WRITER_PROTOCOL_VERSION ||
        !evidence.evidence_id?.trim() ||
        !Number.isFinite(Date.parse(evidence.as_of)) ||
        Date.parse(evidence.as_of) > now + 1000 ||
        now - Date.parse(evidence.as_of) > MAX_PROOF_AGE_MS ||
        !Number.isFinite(Date.parse(evidence.expires_at)) ||
        Date.parse(evidence.expires_at) <= now
      )
        throw Error(
          "Hold-aware account writers and isolated sponsored-resource workers are not verified on every bay.",
        );
      expires_at = Math.min(
        expires_at,
        Date.parse(evidence.expires_at),
        Date.parse(evidence.as_of) + MAX_PROOF_AGE_MS,
      );
      if (evidence.evidence_id.startsWith("manifest:")) {
        const match =
          /^manifest:([a-f0-9]{64}):(account-holds|sponsored-resources)$/.exec(
            evidence.evidence_id,
          );
        if (!match || match[2] !== kind)
          throw Error("Invalid funding manifest evidence identity.");
        manifestDigests.add(match[1]);
      } else isolatedEvidence = true;
    }
  });
  if (manifestDigests.size > 1 || (manifestDigests.size && isolatedEvidence))
    throw Error("Funding bays do not share the same deployment attestation.");
  const proof = Object.freeze({
    expires_at,
    bay_ids: Object.freeze(bays) as unknown as string[],
  });
  issuedProofs.add(proof);
  return proof;
}

export async function getSponsorshipAvailability(): Promise<SponsorshipAvailability> {
  let enabled = false;
  try {
    enabled = await sponsorshipEnabled();
    if (!enabled)
      return {
        enabled: false,
        available: false,
        reason: "New course sponsorship is disabled.",
      };
    await admissionProof();
    return { enabled: true, available: true };
  } catch {
    return {
      enabled,
      available: false,
      reason:
        "New sponsorship is unavailable until every bay verifies hold-aware writers and isolated resource workers.",
    };
  }
}

export async function assertSponsorshipAdmission(): Promise<SponsorshipAdmissionProof> {
  if (!(await sponsorshipEnabled()))
    throw new ComputeFundingError(
      "funding_unavailable",
      "New course sponsorship is disabled.",
    );
  try {
    return await admissionProof();
  } catch {
    throw new ComputeFundingError(
      "funding_unavailable",
      "Funding writer capability verification failed; new sponsorship is unavailable.",
    );
  }
}

/** Approval executor calls this on its existing transaction after the external
 * all-bay proof, never during settlement/revoke/close. The flag is uncached and
 * row-locked through commit, so disabling admission cannot race a new hold.
 */
export async function assertSponsorshipAdmissionInTransaction(
  db: PoolClient,
  proof: SponsorshipAdmissionProof,
): Promise<void> {
  if (
    !proof ||
    !issuedProofs.has(proof) ||
    proof.expires_at <= Date.now() ||
    !proof.bay_ids.includes(getConfiguredBayId()) ||
    !(await sponsorshipEnabled(db, true))
  )
    throw new ComputeFundingError(
      "funding_unavailable",
      "Sponsorship admission changed; review a new authorization.",
    );
}
