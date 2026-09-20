import type { PoolClient } from "@cocalc/database/pool";
import type { CourseFundingRuntimeSummary } from "@cocalc/conat/hub/api/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { ComputeFundingLane } from "@cocalc/util/compute-funding";
import { withFundingAccountTransaction } from "./backing";
import { getComputeFundingPolicyInTransaction } from "./policy";

type Observation = {
  state: string;
  resource_kind: string;
  updated_at: string;
  running_until?: string;
  stopped_until?: string;
  hourly_cost_usd?: string;
  storage_hourly_cost_usd?: string;
  terminal?: boolean;
  remaining_usd?: string;
  protected_usd?: string;
  egress_usd?: string;
};

export function projectFundingUsage(opts: {
  as_of: Date;
  remaining_usd: string;
  ends_at: Date;
  observations: Observation[];
  window_headroom_usd?: string;
  window_ends_at?: Date;
}): CourseFundingRuntimeSummary {
  const result: CourseFundingRuntimeSummary = {
    usage_as_of: opts.as_of.toISOString(),
    active_reservations: opts.observations.length,
  };
  let rate = toDecimal(0),
    runtimeBacking = toDecimal(0),
    forecastKnown = true,
    running = 0,
    oldest = opts.as_of.valueOf();
  for (const row of opts.observations) {
    // Provider-confirmed terminal events are irreversible for this reservation.
    // Pending egress settlement is financial exposure, not a running disk/VM.
    if (row.terminal === true) continue;
    const observed = Date.parse(row.stopped_until ?? row.running_until ?? "");
    if (Number.isFinite(observed)) {
      oldest = Math.min(oldest, observed);
      result.usage_as_of = new Date(oldest).toISOString();
    } else {
      result.usage_as_of = undefined;
    }
    // Dispatch is not evidence of a running VM. Unknown or stale observations
    // omit counts/rates instead of silently reporting zero.
    if (
      !["compute-vm", "compute-volume"].includes(row.resource_kind) ||
      !["consuming", "settling"].includes(row.state) ||
      !Number.isFinite(observed) ||
      observed > opts.as_of.valueOf() ||
      opts.as_of.valueOf() - observed > 90_000
    ) {
      result.forecast_unavailable_reason =
        "Waiting for a usage report from every active resource within the last 90 seconds. A missing estimate does not mean the credit is exhausted.";
      return result;
    }
    const stopped =
      !!row.stopped_until || row.resource_kind === "compute-volume";
    const value = stopped ? row.storage_hourly_cost_usd : row.hourly_cost_usd;
    if (value === undefined) return result;
    try {
      const cost = toDecimal(value);
      if (cost.lt(0)) return result;
      rate = rate.plus(cost);
    } catch {
      return result;
    }
    if (!stopped) running++;
    if (!stopped) {
      if (
        row.remaining_usd == null ||
        row.protected_usd == null ||
        row.egress_usd == null
      ) {
        forecastKnown = false;
      } else {
        try {
          // Keep the complete egress envelope excluded until reconciliation;
          // metered bytes are not permission to repurpose that commitment.
          const available = toDecimal(row.remaining_usd)
            .minus(row.protected_usd)
            .minus(row.egress_usd);
          if (available.gt(0)) runtimeBacking = runtimeBacking.plus(available);
        } catch {
          forecastKnown = false;
        }
      }
    }
    oldest = Math.min(oldest, observed);
  }
  result.usage_as_of = new Date(oldest).toISOString();
  result.running_vms = running;
  result.hourly_usd = moneyToDbString(rate);
  result.forecast_unavailable_reason =
    running === 0
      ? undefined
      : "A current resource price, reservation, or payer spending-limit report is unavailable. A missing estimate does not mean the credit is exhausted.";
  if (
    running > 0 &&
    rate.gt(0) &&
    forecastKnown &&
    opts.window_headroom_usd != null &&
    opts.window_ends_at
  ) {
    const poolHeadroom = toDecimal(opts.remaining_usd).plus(runtimeBacking);
    const windowHeadroom = toDecimal(opts.window_headroom_usd).plus(
      runtimeBacking,
    );
    const remaining = poolHeadroom.lt(windowHeadroom)
      ? poolHeadroom
      : windowHeadroom;
    const milliseconds = remaining.gt(0)
      ? remaining.div(rate).mul(3600000).toNumber()
      : 0;
    const exhaustion = Math.max(
      opts.as_of.valueOf(),
      Math.min(opts.as_of.valueOf() + milliseconds, opts.ends_at.valueOf()),
    );
    if (Number.isFinite(exhaustion)) {
      result.forecast_exhausts_at = new Date(exhaustion).toISOString();
      result.forecast_unavailable_reason = undefined;
    }
  }
  return result;
}

/** Server-only projection: authorize/scopingly select grant IDs before calling.
 * Only one principal scope is allowed, so beneficiary forecasts cannot expose
 * classmates' runtime observations. All input budgets and meters share a single
 * SQL snapshot. Current payer window limits are read under the funding lock;
 * unavailable policy omits only the forecast, never the financial history.
 */
export async function getCourseFundingUsageProjection(
  db: Pick<PoolClient, "query">,
  opts: {
    grant_ids: string[];
  } & (
    | { payer_account_id: string; beneficiary_account_id?: never }
    | { beneficiary_account_id: string; payer_account_id?: never }
  ),
): Promise<Map<string, CourseFundingRuntimeSummary>> {
  if (!opts.grant_ids.length) return new Map();
  if (!!opts.payer_account_id === !!opts.beneficiary_account_id)
    throw Error("One funding projection principal is required");
  const { rows } = await db.query<{
    id: string;
    as_of: Date;
    remaining_usd: string;
    ends_at: Date;
    observations: Observation[];
    payer_account_id: string;
    lane: ComputeFundingLane;
  }>(
    `SELECT g.id,p.payer_account_id,p.lane,statement_timestamp() AS as_of,
       GREATEST(0,LEAST(g.authorized_usd-g.spent_usd-g.reserved_usd-g.released_usd,
                       p.authorized_usd-p.spent_usd-p.reserved_usd-p.released_usd))::text AS remaining_usd,
       LEAST(g.ends_at,p.ends_at) AS ends_at,
       COALESCE((SELECT jsonb_agg(jsonb_build_object(
         'state',r.state,'resource_kind',r.resource_kind,'updated_at',r.updated_at,
         'remaining_usd',(r.authorized_usd-r.spent_usd-r.released_usd)::text,
         'protected_usd',r.protected_usd::text,
         'egress_usd',r.pricing_snapshot#>>'{binding,egress_usd}',
         'terminal',(r.pricing_snapshot#>>'{meter,transferred_at}' IS NOT NULL OR EXISTS (
           SELECT 1 FROM compute_funding_events e WHERE e.reservation_id=r.id
             AND e.payer_account_id=r.payer_account_id AND e.kind IN ('charged','uncertain')
             AND e.details @> '{"deleted":true}'::jsonb)),
         'running_until',r.pricing_snapshot#>>'{meter,running_until}',
         'stopped_until',r.pricing_snapshot#>>'{meter,stopped_until}',
         'hourly_cost_usd',r.pricing_snapshot#>>'{request,hourly_cost_usd}',
         'storage_hourly_cost_usd',r.pricing_snapshot#>>'{request,storage_hourly_cost_usd}'))
         FROM compute_funding_reservations r WHERE r.grant_id=g.id AND r.state<>'settled'), '[]'::jsonb) AS observations
     FROM compute_funding_grants g JOIN compute_funding_pools p ON p.id=g.pool_id
     WHERE g.id=ANY($1::uuid[]) AND ($2::uuid IS NULL OR p.payer_account_id=$2)
       AND ($3::uuid IS NULL OR g.beneficiary_account_id=$3)`,
    [
      opts.grant_ids,
      opts.payer_account_id ?? null,
      opts.beneficiary_account_id ?? null,
    ],
  );
  const policies = new Map<
    string,
    { window_headroom_usd: string; window_ends_at: Date } | undefined
  >();
  for (const row of rows) {
    const key = `${row.payer_account_id}:${row.lane}`;
    if (
      policies.has(key) ||
      !row.observations.some((r) => !r.terminal && r.state === "consuming")
    )
      continue;
    try {
      const readPolicy = async (client: PoolClient) => {
        const policy = await getComputeFundingPolicyInTransaction(client, {
          payer_account_id: row.payer_account_id,
          lane: row.lane,
          for_service: false,
        });
        if (!policy.backing_valid) return undefined;
        const {
          rows: [exposure],
        } = await client.query<{ outstanding: string }>(
          `SELECT COALESCE(SUM(r.authorized_usd-r.spent_usd-r.released_usd),0)::text AS outstanding
           FROM compute_funding_reservations r LEFT JOIN compute_funding_pools p ON p.id=r.pool_id
           LEFT JOIN account_funding_holds h ON h.payer_account_id=r.payer_account_id
             AND h.source_kind='resource' AND h.source_id=r.id
           WHERE r.payer_account_id=$1 AND COALESCE(p.lane,h.lane)=$2`,
          [row.payer_account_id, row.lane],
        );
        const windows = Object.values(policy.windows);
        if (windows.some((w) => !w.window)) return undefined;
        const amounts = windows.map((w) =>
          toDecimal(w.limit_usd).minus(w.used_usd).minus(exposure.outstanding),
        );
        return {
          window_headroom_usd: moneyToDbString(
            amounts.reduce((a, b) => (a.lt(b) ? a : b)),
          ),
          window_ends_at: new Date(
            Math.min(...windows.map((w) => w.window!.resets_at.valueOf())),
          ),
        };
      };
      policies.set(
        key,
        opts.payer_account_id
          ? await readPolicy(db as PoolClient)
          : await withFundingAccountTransaction(
              row.payer_account_id,
              readPolicy,
            ),
      );
    } catch {
      policies.set(key, undefined);
    }
  }
  return new Map(
    rows.map((row) => [
      row.id,
      projectFundingUsage({
        ...row,
        ...policies.get(`${row.payer_account_id}:${row.lane}`),
      }),
    ]),
  );
}
