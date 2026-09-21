import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import adminAlert from "@cocalc/server/messages/admin-alert";
import { FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION } from "@cocalc/server/purchases/lock-account-spending";
import type {
  FundingRolloutCheck,
  FundingRolloutEvidence,
} from "@cocalc/util/compute-funding-rollout";
import { FUNDING_WRITER_PROTOCOL_VERSION } from "@cocalc/util/compute-funding-rollout";
import { computeDeploymentNamespace } from "../resource-names";
import { loadProductionFundingRollout } from "./production-rollout-manifest";
import { verifyFundingAccountWriters } from "./account-writer-rollout";
import { verifySponsoredResourceWriters } from "./resource-writer-rollout";
import { verifyFundingExposureAllocation } from "./exposure";
import {
  assertCoResidentFundingAdvisoryTopology,
  isCoResidentFundingAdvisoryMode,
} from "./rollout-mode";

const logger = getLogger("compute:funding:production-rollout");
const ADVISORY_ALERT_INTERVAL_MS = 4 * 60 * 60_000;
let lastAdvisoryAlert = 0;

function reportAdvisoryMismatch(error: unknown): void {
  const now = Date.now();
  if (now - lastAdvisoryAlert < ADVISORY_ALERT_INTERVAL_MS) return;
  lastAdvisoryAlert = now;
  const detail = error instanceof Error ? error.message : `${error}`;
  logger.warn("co-resident funding rollout attestation mismatch", { detail });
  void adminAlert({
    subject: "Course funding rollout attestation mismatch",
    body: `The optional one-bay co-resident funding attestation does not match the running deployment. New sponsorship remains available because COCALC_FUNDING_ROLLOUT_MODE=co-resident-advisory. Review the deployment inventory.\n\nBay: ${getConfiguredBayId()}\nDetail: ${detail}`,
    dedupMinutes: 4 * 60,
    dedupBySubject: true,
  });
}

async function advisoryEvidence(
  check: FundingRolloutCheck,
): Promise<FundingRolloutEvidence> {
  assertCoResidentFundingAdvisoryTopology();
  if (
    FUNDING_ACCOUNT_WRITER_PROTOCOL_VERSION !== FUNDING_WRITER_PROTOCOL_VERSION
  ) {
    throw Error("This account writer does not implement the funding protocol.");
  }
  if (check === "sponsored-resources") {
    const { SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION } =
      await import("../worker");
    if (
      SPONSORED_RESOURCE_WRITER_PROTOCOL_VERSION !==
        FUNDING_WRITER_PROTOCOL_VERSION ||
      !process.env.COCALC_COMPUTE_DEPLOYMENT_ID?.trim() ||
      !computeDeploymentNamespace()
    ) {
      throw Error(
        "The sponsored resource writer protocol or deployment identity is unavailable.",
      );
    }
  }
  const now = new Date();
  return {
    protocol_version: FUNDING_WRITER_PROTOCOL_VERSION,
    enforced: true,
    evidence_id: `co-resident-advisory:${getConfiguredBayId()}:${check}`,
    as_of: now.toISOString(),
    expires_at: new Date(now.valueOf() + 30_000).toISOString(),
  };
}

async function verifyStrictProductionFundingRollout(
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

function hasConfiguredFundingRolloutAttestation(): boolean {
  return [
    process.env.COCALC_FUNDING_ROLLOUT_MANIFEST,
    process.env.COCALC_FUNDING_ROLLOUT_PUBLIC_KEY,
    process.env.COCALC_FUNDING_ROLLOUT_ID,
  ].some((value) => value?.trim());
}

export async function verifyProductionFundingRollout(
  check: FundingRolloutCheck,
): Promise<FundingRolloutEvidence> {
  if (!isCoResidentFundingAdvisoryMode()) {
    return await verifyStrictProductionFundingRollout(check);
  }
  if (!hasConfiguredFundingRolloutAttestation()) {
    return await advisoryEvidence(check);
  }
  try {
    return await verifyStrictProductionFundingRollout(check);
  } catch (error) {
    reportAdvisoryMismatch(error);
    return await advisoryEvidence(check);
  }
}
