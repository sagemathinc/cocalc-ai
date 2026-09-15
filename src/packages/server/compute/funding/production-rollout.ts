import type {
  FundingRolloutCheck,
  FundingRolloutEvidence,
} from "@cocalc/util/compute-funding-rollout";
import { FUNDING_WRITER_PROTOCOL_VERSION } from "@cocalc/util/compute-funding-rollout";
import { loadProductionFundingRollout } from "./production-rollout-manifest";
import { verifyFundingAccountWriters } from "./account-writer-rollout";
import { verifySponsoredResourceWriters } from "./resource-writer-rollout";
import { verifyFundingExposureAllocation } from "./exposure";

export async function verifyProductionFundingRollout(
  check: FundingRolloutCheck,
): Promise<FundingRolloutEvidence> {
  const { manifest, bay, digest } = await loadProductionFundingRollout();
  await verifyFundingAccountWriters(manifest, bay);
  if (check === "sponsored-resources") {
    await verifySponsoredResourceWriters(manifest, bay);
    await verifyFundingExposureAllocation(manifest);
  }
  const now = Date.now();
  const expires = Math.min(now + 30_000, Date.parse(manifest.expires_at));
  if (expires <= now)
    throw Error("Funding deployment attestation expired during inspection.");
  return {
    protocol_version: FUNDING_WRITER_PROTOCOL_VERSION,
    enforced: true,
    evidence_id: `manifest:${digest}:${check}`,
    as_of: new Date(now).toISOString(),
    expires_at: new Date(expires).toISOString(),
  };
}
