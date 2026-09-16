/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import type {
  CourseFundingSources,
  CourseFundingSourceSummary,
} from "@cocalc/conat/hub/api/compute-funding";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { isMultiBayCluster } from "@cocalc/server/cluster-config";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import {
  getClusterAccountById,
  getClusterAccountsByIds,
} from "@cocalc/server/inter-bay/accounts";
import { ComputeFundingError, fundingId } from "@cocalc/util/compute-funding";
import { attachSourceVmRecommendations } from "./source-vm-recommendations";
import { getCourseFundingUsageProjection } from "./usage-projection";

const MAX_SOURCES_PER_BAY = 1000;

/** Internal bay service only. The public caller binds the beneficiary to its
 * authenticated account and initiates discovery at that account's home bay.
 * These projections never authorize spending. Resource admission must resolve
 * the payer home again and validate the grant under its funding lock.
 */
export async function listCourseFundingSourcesOnBay({
  beneficiary_account_id,
  beneficiary_home_bay_id,
  include_inactive = false,
}: {
  beneficiary_account_id: string;
  beneficiary_home_bay_id: string;
  include_inactive?: boolean;
}): Promise<CourseFundingSources & { payer_home_bay_ids: string[] }> {
  const beneficiary = fundingId(beneficiary_account_id, "Beneficiary account");
  const local = getConfiguredBayId();
  const central = isBillingAuthorityEnabled();
  const home = (account: { home_bay_id?: string } | null | undefined) => {
    if (!account) return;
    return account.home_bay_id || (!isMultiBayCluster() ? local : undefined);
  };
  const account = await getClusterAccountById(beneficiary);
  if (!beneficiary_home_bay_id || home(account) !== beneficiary_home_bay_id) {
    throw new ComputeFundingError(
      "funding_unavailable",
      "Funding source discovery must originate at the beneficiary's current home bay.",
    );
  }
  const {
    rows: [row],
  } = await getPool().query<{
    as_of: Date;
    sources: (CourseFundingSourceSummary & {
      course_project_id: string;
      course_instance_id: string;
    })[];
  }>(
    `WITH candidates AS (
       SELECT jsonb_build_object(
         'pool_id', p.id, 'grant_id', g.id, 'payer_account_id', p.payer_account_id,
         'course_project_id', p.course_project_id, 'course_instance_id', p.course_instance_id,
         'label', COALESCE(NULLIF(pr.title, ''), 'Course compute allowance'),
         'lane', p.lane, 'authorized_usd', g.authorized_usd::text,
         'spent_usd', g.spent_usd::text, 'reserved_usd', g.reserved_usd::text,
         'released_usd', g.released_usd::text,
         'starts_at', GREATEST(g.starts_at,p.starts_at),
         'ends_at', LEAST(g.ends_at,p.ends_at), 'state', g.state,
         'pool_state', p.state,
         'available_usd', GREATEST(0, LEAST(
           g.authorized_usd-g.spent_usd-g.reserved_usd-g.released_usd,
           p.authorized_usd-p.spent_usd-p.reserved_usd-p.released_usd))::text,
         'available_for_new_resources', (
           g.state IN ('active','scheduled') AND p.state IN ('active','scheduled')
           AND GREATEST(g.starts_at,p.starts_at)<=statement_timestamp()
           AND LEAST(g.ends_at,p.ends_at)>statement_timestamp()
           AND g.authorized_usd-g.spent_usd-g.reserved_usd-g.released_usd>0
           AND p.authorized_usd-p.spent_usd-p.reserved_usd-p.released_usd>0)
       ) AS source
     FROM compute_funding_grants g
     JOIN compute_funding_pools p ON p.id=g.pool_id
     LEFT JOIN projects pr ON pr.project_id=p.course_project_id
     WHERE g.beneficiary_account_id=$1 AND ($3::boolean OR (g.state IN ('active','scheduled')
       AND g.ends_at>statement_timestamp() AND p.state IN ('active','scheduled')
       AND p.ends_at>statement_timestamp()))
     ORDER BY p.starts_at, g.id LIMIT $2)
     SELECT statement_timestamp() AS as_of,
       COALESCE(jsonb_agg(source), '[]'::jsonb) AS sources FROM candidates`,
    [beneficiary, MAX_SOURCES_PER_BAY + 1, include_inactive === true],
  );
  if (row.sources.length > MAX_SOURCES_PER_BAY) {
    throw new ComputeFundingError(
      "funding_unavailable",
      "Too many funding sources for complete bounded discovery.",
    );
  }
  const payers = new Map(
    (
      await getClusterAccountsByIds([
        ...new Set(row.sources.map((source) => source.payer_account_id)),
      ])
    ).map((payer) => [payer.account_id, payer]),
  );
  const sources: CourseFundingSourceSummary[] = [];
  const recommendations: Parameters<typeof attachSourceVmRecommendations>[0] =
    [];
  const payerHomes = new Set<string>();
  for (const source of row.sources) {
    const payerHome = home(payers.get(source.payer_account_id));
    if (!payerHome) {
      throw new ComputeFundingError(
        "funding_unavailable",
        "A funding payer's current home bay could not be resolved.",
      );
    }
    payerHomes.add(payerHome);
    // Before seed billing, payer-home data is authoritative and stale copies
    // left by rehome must not be advertised. With seed billing all financial
    // source rows are authoritative here regardless of the payer's account home.
    if (!central && payerHome !== local) continue;
    sources.push({
      pool_id: source.pool_id,
      grant_id: source.grant_id,
      payer_account_id: source.payer_account_id,
      label: source.label,
      lane: source.lane,
      authorized_usd: source.authorized_usd,
      spent_usd: source.spent_usd,
      reserved_usd: source.reserved_usd,
      released_usd: source.released_usd,
      starts_at: new Date(source.starts_at).toISOString(),
      ends_at: new Date(source.ends_at).toISOString(),
      state: source.state,
      pool_state: source.pool_state,
      available_usd: source.available_usd,
      available_for_new_resources: source.available_for_new_resources === true,
    });
    recommendations.push({
      source: sources[sources.length - 1],
      course: {
        course_project_id: source.course_project_id,
        course_instance_id: source.course_instance_id,
      },
    });
  }
  await attachSourceVmRecommendations(recommendations);
  const usage = await getCourseFundingUsageProjection(getPool(), {
    beneficiary_account_id: beneficiary,
    grant_ids: sources.map((source) => source.grant_id),
  });
  for (const source of sources)
    Object.assign(source, usage.get(source.grant_id));
  return {
    as_of: row.as_of.toISOString(),
    sources,
    payer_home_bay_ids: [...payerHomes].sort(),
  };
}
