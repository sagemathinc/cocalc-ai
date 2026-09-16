/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { PoolClient } from "@cocalc/database/pool";
import getPool from "@cocalc/database/pool";
import {
  getConfiguredBayId,
  getConfiguredClusterBayCatalog,
} from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import {
  ComputeFundingError,
  fundingAmount,
} from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { FundingRolloutManifest } from "./production-rollout-contract";
import type { SponsorshipAdmissionProof } from "./rollout";

type Allocation = NonNullable<FundingRolloutManifest["exposure_allocation"]>;
export interface FundingExposureBudget {
  limit_usd: string;
  allocation?: Allocation;
  expires_at?: number;
  proof?: SponsorshipAdmissionProof;
}
function unavailable(message: string): never {
  throw new ComputeFundingError("funding_unavailable", message);
}

export function validateFundingExposureAllocation(
  allocation: Allocation,
  bayIds: string[],
  ceiling: string,
): Allocation {
  if (!allocation?.id?.trim() || !Array.isArray(allocation.bay_quotas))
    unavailable("Missing static exposure allocation.");
  const site = fundingAmount(allocation.site_ceiling_usd, { positive: true });
  if (toDecimal(site).gt(ceiling))
    unavailable(
      "Manifest exposure ceiling exceeds the configured site ceiling.",
    );
  const quotas = allocation.bay_quotas
    .map((q) => ({ bay_id: q.bay_id, amount_usd: fundingAmount(q.amount_usd) }))
    .sort((a, b) => a.bay_id.localeCompare(b.bay_id));
  if (
    new Set(quotas.map((q) => q.bay_id)).size !== quotas.length ||
    JSON.stringify(quotas.map((q) => q.bay_id)) !==
      JSON.stringify([...bayIds].sort())
  )
    unavailable(
      "Static exposure quotas must cover every authoritative bay exactly once.",
    );
  if (quotas.reduce((sum, q) => sum.plus(q.amount_usd), toDecimal(0)).gt(site))
    unavailable("Static exposure quotas exceed the site ceiling.");
  return { id: allocation.id, site_ceiling_usd: site, bay_quotas: quotas };
}

/** External attestations are collected before taking financial locks. */
export async function loadFundingExposureBudget(
  owningBay?: string,
): Promise<FundingExposureBudget> {
  const ceiling = fundingAmount(
    process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD ?? "100.00",
    { positive: true },
  );
  const local = getConfiguredBayId();
  const multi =
    isMultiBayCluster() ||
    getConfiguredClusterBayCatalog().some((b) => b.bay_id !== local);
  if (!multi && !process.env.COCALC_FUNDING_ROLLOUT_MANIFEST) {
    if (owningBay && owningBay !== local)
      unavailable("The resource owning bay is not in this deployment.");
    return { limit_usd: ceiling };
  }
  const { loadProductionFundingRollout } =
    await import("./production-rollout-manifest");
  const { manifest } = await loadProductionFundingRollout();
  if (!manifest.exposure_allocation) {
    if (multi)
      unavailable(
        "Multi-bay admission requires a signed static exposure allocation.",
      );
    return { limit_usd: ceiling };
  }
  const allocation = validateFundingExposureAllocation(
    manifest.exposure_allocation,
    manifest.bays.map((b) => b.bay_id),
    ceiling,
  );
  if (owningBay && !manifest.bays.some((b) => b.bay_id === owningBay))
    unavailable("The resource owning bay is not attested.");
  const proof = await (await import("./rollout")).assertSponsorshipAdmission();
  return {
    allocation,
    limit_usd: allocation.bay_quotas.find((q) => q.bay_id === local)!
      .amount_usd,
    expires_at: Date.parse(manifest.expires_at),
    proof,
  };
}

/** Each payer-home database owns one static portion of the site exposure.
 * Policy is durably pinned: applications cannot reallocate quota while old
 * obligations may remain elsewhere. Operator migration must reconcile all bays.
 */
export async function assertFundingExposureAvailable(
  db: PoolClient,
  budget: FundingExposureBudget,
  additional: string,
): Promise<void> {
  await db.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('course-vm-site-exposure',0))",
  );
  // Lock contention can outlive the manifest or short-lived admission proof.
  if (budget.expires_at != null && budget.expires_at <= Date.now())
    unavailable("Exposure allocation attestation expired.");
  if (budget.proof)
    await (
      await import("./rollout")
    ).assertSponsorshipAdmissionInTransaction(db, budget.proof);
  if (budget.allocation) {
    await db.query(
      "INSERT INTO compute_funding_exposure_policy (bay_id,allocation) VALUES ($1,$2) ON CONFLICT DO NOTHING",
      [getConfiguredBayId(), budget.allocation],
    );
    const {
      rows: [row],
    } = await db.query<{ matches: boolean }>(
      "SELECT allocation=$2::jsonb AS matches FROM compute_funding_exposure_policy WHERE bay_id=$1",
      [getConfiguredBayId(), budget.allocation],
    );
    if (!row?.matches)
      unavailable(
        "Exposure quotas cannot be reassigned without a reconciled operator migration.",
      );
  }
  const {
    rows: [exposure],
  } = await db.query<{ amount: string }>(`SELECT COALESCE(SUM(
    authorized_usd-spent_usd-released_usd + COALESCE((pricing_snapshot#>>'{meter,platform_overrun_usd}')::numeric,0)),0)::text AS amount
    FROM compute_funding_reservations`);
  if (
    toDecimal(exposure.amount)
      .plus(fundingAmount(additional))
      .gt(budget.limit_usd)
  )
    unavailable(
      `Sponsored resource exposure quota reached for payer bay '${getConfiguredBayId()}'; outstanding exposure is ${moneyToDbString(exposure.amount)} USD.`,
    );
}

/** Resource-writer attestation checks this on every bay before issuing proof.
 * In particular, an existing one-bay liability cannot be hidden by splitting
 * its former quota across a newly enabled fleet.
 */
export async function verifyFundingExposureAllocation(
  manifest: FundingRolloutManifest,
): Promise<void> {
  if (!manifest.exposure_allocation) {
    if (manifest.bays.length > 1)
      unavailable(
        "Multi-bay resource writers need a static exposure allocation.",
      );
    return;
  }
  const allocation = validateFundingExposureAllocation(
    manifest.exposure_allocation,
    manifest.bays.map((b) => b.bay_id),
    fundingAmount(process.env.COCALC_COURSE_VM_SITE_EXPOSURE_USD ?? "100.00", {
      positive: true,
    }),
  );
  const db = await getPool().connect();
  try {
    await db.query("BEGIN");
    await assertFundingExposureAvailable(
      db,
      {
        allocation,
        limit_usd: allocation.bay_quotas.find(
          (q) => q.bay_id === getConfiguredBayId(),
        )!.amount_usd,
      },
      "0",
    );
    await db.query("COMMIT");
  } catch (err) {
    await db.query("ROLLBACK");
    throw err;
  } finally {
    db.release();
  }
}
