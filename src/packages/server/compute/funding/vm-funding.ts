/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { withFundingResourceMeterLock } from "./resource-meter-lock";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import {
  getConfiguredClusterRole,
  getConfiguredClusterSeedBayId,
} from "@cocalc/server/cluster-config";
import { executeBillingAuthorityCommand } from "@cocalc/server/purchases/billing-authority/client";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import { ComputeFundingError, fundingId } from "@cocalc/util/compute-funding";
import type {
  CourseVmFundingSource,
  ComputeVmFundingBinding,
  CheckComputeVmFundingRequest,
  LookupComputeVmFundingRequest,
  ReserveComputeVmFundingRequest,
  SettleComputeVmFundingRequest,
  ComputeVmFundingSettlement,
  ComputeVmFundingStatus,
  ComputeVmFallbackDecision,
} from "@cocalc/util/compute-vm-funding";
import type { ComputeVmRow } from "../types";
import { getComputeVmById } from "../db";
import { randomUUID } from "node:crypto";
import { computeDeploymentNamespace } from "../resource-names";
import {
  fundingConflict,
  checkComputeVmFundingLocal,
  reserveComputeVmFundingLocal,
  VM_FUNDING_MARGIN_MS,
  VM_FUNDING_RUN_MS,
} from "./vm-reservations";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import { lookupComputeVmFundingLocal } from "./vm-lookup";
import { getComputeVmFallbackDecisionLocal } from "./vm-fallback-reason";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";

export {
  checkComputeVmFundingLocal,
  reserveComputeVmFundingLocal,
  settleComputeVmFundingLocal,
  lookupComputeVmFundingLocal,
  getComputeVmFallbackDecisionLocal,
};

interface VmFundingInternalApi {
  getComputeVmFallbackDecision(
    opts: Pick<CheckComputeVmFundingRequest, "account_id" | "binding">,
  ): Promise<ComputeVmFallbackDecision>;
  lookupComputeVmFunding(
    opts: LookupComputeVmFundingRequest,
  ): Promise<ComputeVmFundingBinding | null>;
  reserveComputeVmFunding(
    opts: ReserveComputeVmFundingRequest,
  ): Promise<ComputeVmFundingBinding>;
  checkComputeVmFunding(
    opts: CheckComputeVmFundingRequest,
  ): Promise<ComputeVmFundingBinding>;
  settleComputeVmFunding(
    opts: SettleComputeVmFundingRequest,
  ): Promise<ComputeVmFundingSettlement>;
}

const local: VmFundingInternalApi = {
  getComputeVmFallbackDecision: getComputeVmFallbackDecisionLocal,
  lookupComputeVmFunding: lookupComputeVmFundingLocal,
  reserveComputeVmFunding: reserveComputeVmFundingLocal,
  checkComputeVmFunding: checkComputeVmFundingLocal,
  settleComputeVmFunding: settleComputeVmFundingLocal,
};

export async function payerApi(payer: string): Promise<VmFundingInternalApi> {
  if (isBillingAuthorityEnabled()) {
    const role = getConfiguredClusterRole();
    if (
      role === "standalone" ||
      (role === "seed" &&
        getConfiguredBayId() === getConfiguredClusterSeedBayId())
    ) {
      return local;
    }
    const execute = async <T>(operation: string, input: object): Promise<T> =>
      await executeBillingAuthorityCommand<T>({
        kind: "account-local",
        operation: operation as any,
        input: input as Record<string, unknown>,
      });
    return {
      getComputeVmFallbackDecision: async (opts) =>
        await execute("compute-funding-fallback", opts),
      lookupComputeVmFunding: async (opts) =>
        await execute("compute-funding-lookup", opts),
      reserveComputeVmFunding: async (opts) =>
        await execute("compute-funding-reserve", opts),
      checkComputeVmFunding: async (opts) =>
        await execute("compute-funding-check", opts),
      settleComputeVmFunding: async (opts) =>
        await execute("compute-funding-settle", opts),
    };
  }
  const location = await resolveAccountHomeBay({
    account_id: payer,
    user_account_id: payer,
  });
  const home = location.home_bay_id;
  if (!home) fundingConflict("The payer home bay could not be resolved.");
  if (home === getConfiguredBayId()) return local;
  // The existing authenticated account-local transport, not browser hub RPC.
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home,
  });
}

export function normalizeVmFundingSource(
  source: unknown,
): CourseVmFundingSource | undefined {
  if (source == null) return;
  if (typeof source !== "object" || Array.isArray(source))
    fundingConflict("Invalid VM funding source.");
  const value = source as CourseVmFundingSource;
  if (value.kind !== "course")
    fundingConflict("Unsupported VM funding source.");
  return {
    kind: "course",
    pool_id: fundingId(value.pool_id, "Pool"),
    grant_id: fundingId(value.grant_id, "Grant"),
    payer_account_id:
      value.payer_account_id == null
        ? undefined
        : fundingId(value.payer_account_id, "Payer routing reference"),
  };
}

/** Disabled-by-default rollout policy. Operators must deploy the funding schema,
 * hold-aware billing writers and enforcement workers before enabling admission.
 * Disabling admission does not disable settlement, stopping or cleanup.
 */
export async function requireSponsoredVmAdmission() {
  if (!computeDeploymentNamespace())
    fundingConflict(
      "Sponsored VM launch requires an explicit compute deployment identity.",
    );
  const settings = await getServerSettings();
  const enabled = settings.compute_vm_course_funding_enabled;
  if (
    enabled !== true &&
    `${enabled}` !== "yes" &&
    !(
      process.env.NODE_ENV !== "production" &&
      process.env.COCALC_COURSE_FUNDING_DEV_VM_ENABLED === "yes"
    )
  )
    fundingConflict(
      "Sponsored VM launch is disabled pending funding deployment prerequisites.",
    );
}

export function hasCourseVmFunding(
  vm: Pick<ComputeVmRow, "metadata">,
): boolean {
  return vm.metadata?.billing?.course_funding != null;
}

export function publicVmFundingStatus(
  vm: ComputeVmRow,
): ComputeVmFundingStatus | undefined {
  if (!hasCourseVmFunding(vm)) return;
  const course = vm.metadata.billing.course_funding;
  const binding = course.binding as ComputeVmFundingBinding | undefined;
  const spent = vm.accrued_cost ?? "0";
  const committed = course.committed_usd ?? undefined;
  return {
    source:
      course.source.kind === "personal"
        ? { kind: "personal", consent_id: course.source.consent_id }
        : {
            kind: "course",
            pool_id: course.source.pool_id,
            grant_id: course.source.grant_id,
          },
    label:
      course.source.kind === "personal" ? "Personal funding" : "Course funding",
    funding_version: course.funding_epoch,
    state: !binding
      ? "pending"
      : vm.deleted_at
        ? committed != null && toDecimal(committed).eq(0)
          ? "closed"
          : "settling"
        : vm.stopped_at
          ? "stopped"
          : "running",
    lane: binding?.lane,
    stopped_at: vm.stopped_at?.toISOString(),
    committed_usd: committed,
    remaining_usd: committed,
    spent_usd: spent,
    protected_storage_usd:
      binding && committed != null
        ? moneyToDbString(
            toDecimal(binding.protected_usd).lt(committed)
              ? binding.protected_usd
              : committed,
          )
        : undefined,
    egress_cap_usd: binding?.egress_usd,
    authorized_until: binding?.authorized_until,
    stop_at: binding?.stop_at,
    storage_delete_at: binding?.storage_delete_at,
    as_of: (vm.billing_updated_at ?? vm.created_at).toISOString(),
  };
}

export function courseVmBinding(vm: ComputeVmRow): ComputeVmFundingBinding {
  const binding = vm.metadata?.billing?.course_funding?.binding as
    | ComputeVmFundingBinding
    | undefined;
  if (
    !binding ||
    binding.resource_id !== vm.id ||
    binding.owner_account_id !== vm.owner_account_id ||
    binding.owning_bay_id !== vm.owning_bay_id ||
    vm.owning_bay_id !== getConfiguredBayId() ||
    binding.resource_generation !== vm.instance_generation
  )
    fundingConflict(
      "Sponsored VM funding is pending or its resource generation changed.",
    );
  return binding;
}

export function denyCourseVmMutation(
  vm: Pick<ComputeVmRow, "metadata">,
  operation: string,
) {
  if (hasCourseVmFunding(vm))
    fundingConflict(
      `${operation} requires a new sponsored reservation or explicit personal funding consent.`,
    );
}

export async function reserveCourseVmLaunch(
  vm: ComputeVmRow,
): Promise<ComputeVmRow> {
  if (!hasCourseVmFunding(vm)) return vm;
  await requireSponsoredVmAdmission();
  const course = vm.metadata.billing.course_funding;
  if (course.binding) return vm;
  const source = normalizeVmFundingSource(course.source)!;
  if (!source.payer_account_id) {
    // A local copy may supply a routing hint, never spending authority. The
    // directory and payer-home pool validation below still decide authority.
    const {
      rows: [hint],
    } = await getPool().query<{ payer_account_id: string }>(
      "SELECT payer_account_id FROM compute_funding_pools WHERE id=$1",
      [source.pool_id],
    );
    if (!hint)
      fundingConflict(
        "The funding source needs a payer routing reference from source discovery.",
      );
    source.payer_account_id = hint.payer_account_id;
  }
  if (vm.allow_on_demand_fallback)
    fundingConflict(
      "Sponsored volumes and automatic price fallback need separate reservations.",
    );
  const rate = vm.metadata.billing.running_rates?.[vm.effective_pricing_model];
  const storage = vm.metadata.billing.stopped_rate;
  const requestedUntil = new Date(
    vm.created_at.valueOf() + VM_FUNDING_RUN_MS + 2 * VM_FUNDING_MARGIN_MS,
  );
  const api = await payerApi(source.payer_account_id!);
  const binding = await api
    .reserveComputeVmFunding({
      account_id: source.payer_account_id!,
      source,
      resource_id: vm.id,
      resource_generation: vm.instance_generation,
      owner_account_id: vm.owner_account_id,
      owning_bay_id: vm.owning_bay_id,
      funding_epoch: course.funding_epoch,
      provider: vm.provider,
      hourly_cost_usd: rate?.hourly_cost_usd,
      storage_hourly_cost_usd: storage?.hourly_cost_usd,
      pricing_snapshot: rate?.pricing_snapshot,
      requested_until: requestedUntil.toISOString(),
      requested_stop_at: vm.stop_at?.toISOString(),
      requested_delete_at: vm.expires_at?.toISOString(),
    })
    .catch(async (err) => {
      // A local validation denial rolls back its transaction. Unknown transport
      // or database outcomes remain pending for lookup-only recovery instead.
      if (api === local && err instanceof ComputeFundingError) {
        await getPool().query(
          `UPDATE compute_vms SET desired_state='stopped',state='failed',
        billing_state='admission-rejected',error=$3,updated_at=NOW()
        WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
          AND metadata#>'{billing,course_funding,binding}' IS NULL AND desired_state='running'`,
          [vm.id, course.funding_epoch, err.message],
        );
      }
      throw err;
    });
  // Preserve concurrently edited stop schedules and metadata. A reservation
  // reply alone cannot replace the resource's funding epoch or desired state.
  const {
    rows: [updated],
  } = await getPool().query<ComputeVmRow>(
    `UPDATE compute_vms SET
    funding_mode=$4, metadata=jsonb_set(jsonb_set(metadata,'{billing,course_funding,binding}',$3::jsonb),'{billing,funding_mode}',to_jsonb($4::text)),updated_at=NOW()
    WHERE id=$1 AND owning_bay_id=$5 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
      AND instance_generation=$6 AND deleted_at IS NULL RETURNING *`,
    [
      vm.id,
      course.funding_epoch,
      JSON.stringify(binding),
      binding.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
      vm.owning_bay_id,
      vm.instance_generation,
    ],
  );
  if (!updated)
    fundingConflict(
      "VM changed while reserving funding; its commitment requires reconciliation.",
    );
  return updated;
}

export async function requireCourseVmService(
  vm: ComputeVmRow,
  dispatch = false,
  renew = false,
) {
  if (!hasCourseVmFunding(vm)) return;
  const binding = courseVmBinding(vm);
  if (vm.stopped_at || vm.deleted_at || vm.desired_state !== "running")
    fundingConflict("Restart requires a new sponsored reservation.");
  if (Date.now() >= new Date(binding.stop_at).valueOf())
    fundingConflict("Sponsored service deadline reached.");
  const request =
    vm.metadata.billing.running_rates?.[vm.effective_pricing_model];
  if (!request?.hourly_cost_usd || vm.allow_on_demand_fallback)
    fundingConflict("Unsupported sponsored VM configuration.");
  const api = await payerApi(binding.payer_account_id);
  const opts: CheckComputeVmFundingRequest = {
    account_id: binding.payer_account_id,
    binding,
    dispatch,
  };
  let updated: ComputeVmFundingBinding;
  if (
    renew &&
    new Date(binding.stop_at).valueOf() - Date.now() < VM_FUNDING_MARGIN_MS
  ) {
    const until = Math.min(
      Date.now() + VM_FUNDING_RUN_MS + VM_FUNDING_MARGIN_MS,
      vm.stop_at ? vm.stop_at.valueOf() + VM_FUNDING_MARGIN_MS : Infinity,
      vm.expires_at?.valueOf() ?? Infinity,
    );
    try {
      await requireSponsoredVmAdmission();
      updated = await api.checkComputeVmFunding({
        ...opts,
        renew_until: new Date(until).toISOString(),
      });
    } catch {
      // Already reserved work remains available even if a new commitment fails.
      updated = await api.checkComputeVmFunding(opts);
    }
  } else updated = await api.checkComputeVmFunding(opts);
  if (updated.authorized_until !== binding.authorized_until) {
    await getPool().query(
      `UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,course_funding,binding}',$3::jsonb),updated_at=NOW()
      WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
        AND instance_generation=$4 AND desired_state='running' AND owning_bay_id=$5`,
      [
        vm.id,
        binding.funding_epoch,
        JSON.stringify(updated),
        vm.instance_generation,
        vm.owning_bay_id,
      ],
    );
  }
}

export async function meterCourseVm(
  vm: ComputeVmRow,
  _deleted = false,
  egress?: { bytes: number; complete_through: string; finalized: boolean },
) {
  if (!hasCourseVmFunding(vm)) return;
  return withFundingResourceMeterLock("vm", vm.id, () =>
    meterLockedVm(vm, egress),
  );
}

async function meterLockedVm(
  vm: ComputeVmRow,
  egress?: { bytes: number; complete_through: string; finalized: boolean },
) {
  const expectedEpoch = vm.metadata.billing.course_funding.funding_epoch;
  // Read state and all generation boundaries in one database snapshot. Callers
  // routinely hold a VM object from before provider creation or shutdown.
  const {
    rows: [snapshot],
  } = await getPool().query<
    ComputeVmRow & {
      meter_as_of: Date;
      meter_instances: {
        generation: number;
        running_at: string | null;
        stopped_at: string | null;
        deleted_at: string | null;
      }[];
    }
  >(
    `SELECT v.*, clock_timestamp() AS meter_as_of,
    COALESCE((SELECT jsonb_agg(i) FROM
      (SELECT generation, MIN(running_at) AS running_at, MIN(stopped_at) AS stopped_at,
        MIN(deleted_at) AS deleted_at FROM compute_vm_instances
        WHERE vm_id=v.id GROUP BY generation) i), '[]'::jsonb) AS meter_instances
    FROM compute_vms v WHERE v.id=$1 AND v.owning_bay_id=$2`,
    [vm.id, getConfiguredBayId()],
  );
  if (
    !snapshot ||
    snapshot.instance_generation !== vm.instance_generation ||
    snapshot.metadata?.billing?.course_funding?.funding_epoch !== expectedEpoch
  )
    return;
  vm = snapshot;
  // A pending reservation is not billable, and its unknown provider outcome
  // must not release the authorization until recovery binds it.
  if (!vm.metadata.billing.course_funding.binding) return;
  const binding = courseVmBinding(vm);
  const asOf = snapshot.meter_as_of;
  const interval = (generation: number, historicalEnd?: string) => {
    const instance = snapshot.meter_instances.find(
      (i) => i.generation === generation,
    );
    const start = instance?.running_at
      ? new Date(instance.running_at)
      : undefined;
    const ends = [
      instance?.stopped_at,
      instance?.deleted_at,
      historicalEnd,
      ...(generation === vm.instance_generation
        ? [vm.stopped_at, vm.deleted_at]
        : []),
    ]
      .filter((value) => value != null)
      .map((value) => new Date(value!));
    const closedAt = ends.length
      ? new Date(Math.min(...ends.map((d) => d.valueOf())))
      : undefined;
    const observed = vm.metadata.provider_observation;
    const observedAt =
      observed?.state === "running" && observed.observed_at
        ? new Date(observed.observed_at)
        : start;
    const end =
      closedAt ??
      (start && observedAt
        ? new Date(Math.max(start.valueOf(), observedAt.valueOf()))
        : undefined);
    return { start, closedAt, end: end ?? asOf };
  };
  for (const prior of vm.metadata.billing.course_funding.history ?? []) {
    const timing = interval(
      prior.binding.resource_generation,
      prior.running_until,
    );
    await (
      await payerApi(prior.binding.payer_account_id)
    ).settleComputeVmFunding({
      account_id: prior.binding.payer_account_id,
      binding: prior.binding,
      running_started_at: timing.start?.toISOString() ?? null,
      meter_as_of: asOf.toISOString(),
      running_until: timing.end.toISOString(),
      stopped_until: prior.transferred_at,
      transferred_at: prior.transferred_at,
      successor_reservation_id: prior.successor_reservation_id,
      successor_binding: prior.successor_binding,
      public_egress_bytes: Number(prior.egress.total_bytes ?? 0),
      egress_complete_through: prior.egress.metered_through_at,
      egress_finalized:
        vm.provider === "nebius" ||
        new Date(prior.egress.metered_through_at) >=
          new Date(prior.running_until),
    });
  }
  const timing = interval(vm.instance_generation);
  const result = await (
    await payerApi(binding.payer_account_id)
  ).settleComputeVmFunding({
    account_id: binding.payer_account_id,
    binding,
    running_started_at: timing.start?.toISOString() ?? null,
    meter_as_of: asOf.toISOString(),
    running_until: timing.end.toISOString(),
    stopped_until: timing.closedAt
      ? (vm.deleted_at ?? asOf).toISOString()
      : undefined,
    deleted: vm.deleted_at != null,
    public_egress_bytes: egress?.bytes,
    egress_complete_through: egress?.complete_through,
    egress_finalized: egress?.finalized,
  });
  await getPool().query(
    `UPDATE compute_vms SET accrued_cost=$3,billing_updated_at=$5,billing_state=$4,
    metadata=jsonb_set(metadata,'{billing,course_funding,committed_usd}',$6::jsonb)
    WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
      AND (billing_updated_at IS NULL OR billing_updated_at <= $5)`,
    [
      vm.id,
      binding.funding_epoch,
      result.charged_usd,
      vm.deleted_at
        ? "closed"
        : timing.closedAt
          ? "course-stopped"
          : "course-running",
      asOf,
      JSON.stringify(result.committed_usd ?? null),
    ],
  );
  return result;
}

export async function meterCourseVmEgress(
  vm: ComputeVmRow,
  opts: { bytes: number; start: Date; end: Date; finalize: boolean },
) {
  const current = await getComputeVmById(vm.id);
  if (!current) return;
  if (
    current.instance_generation !== vm.instance_generation ||
    current.metadata?.billing?.course_funding?.funding_epoch !==
      vm.metadata?.billing?.course_funding?.funding_epoch
  )
    return;
  const previous = current.metadata?.billing?.egress ?? {};
  const through = previous.metered_through_at
    ? new Date(previous.metered_through_at)
    : current.created_at;
  if (through.valueOf() !== opts.start.valueOf()) {
    if (through >= opts.end) return;
    fundingConflict(
      "Egress interval has changed; retry from the persisted watermark.",
    );
  }
  const bytes = Number(previous.total_bytes ?? 0) + opts.bytes;
  const result = await meterCourseVm(current, current.deleted_at != null, {
    bytes,
    complete_through: opts.end.toISOString(),
    finalized: opts.finalize,
  });
  if (!result) return;
  const measuredCost = toDecimal(bytes)
    .div(1_000_000_000)
    .mul(current.provider === "gcp" ? "0.1" : "0");
  const metadata = {
    ...previous,
    error: null,
    total_bytes: bytes,
    metered_through_at: opts.end.toISOString(),
    finalized: opts.finalize,
    total_cost_usd: moneyToDbString(measuredCost),
    unit_cost_usd_per_gb: current.provider === "gcp" ? "0.1" : "0",
  };
  // pg timestamps may include microseconds, but the interval returned to the
  // worker is a JavaScript Date. Compare the initial watermark at that precision.
  await getPool().query(
    `UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,egress}',$2::jsonb)
    WHERE id=$1 AND owning_bay_id=$3 AND COALESCE((metadata#>>'{billing,egress,metered_through_at}')::timestamptz,date_trunc('milliseconds',created_at))=$4
      AND metadata#>>'{billing,course_funding,funding_epoch}'=$5`,
    [
      current.id,
      JSON.stringify(metadata),
      current.owning_bay_id,
      opts.start,
      current.metadata.billing.course_funding.funding_epoch,
    ],
  );
}

/** Persist a current best-effort observation without advancing the finalized
 * billing watermark. Provider monitoring data can still arrive late, so this
 * is an enforcement signal only; the delayed pass remains authoritative for
 * charges and reconciliation.
 */
export async function observeCourseVmLiveEgress(
  vm: ComputeVmRow,
  opts: { bytes: number; start: Date; end: Date },
): Promise<{ total_bytes: number; threshold_reached: boolean } | undefined> {
  const current = await getComputeVmById(vm.id);
  if (
    !current ||
    current.provider !== "gcp" ||
    current.instance_generation !== vm.instance_generation ||
    current.metadata?.billing?.course_funding?.funding_epoch !==
      vm.metadata?.billing?.course_funding?.funding_epoch
  )
    return;
  const previous = current.metadata?.billing?.egress ?? {};
  const through = previous.metered_through_at
    ? new Date(previous.metered_through_at)
    : current.created_at;
  if (through.valueOf() !== opts.start.valueOf()) return;
  const totalBytes = Number(previous.total_bytes ?? 0) + opts.bytes;
  const live = {
    live_total_bytes: totalBytes,
    live_observed_at: new Date().toISOString(),
    live_complete_through: opts.end.toISOString(),
    live_error: null,
  };
  const result = await getPool().query(
    `UPDATE compute_vms SET metadata=jsonb_set(metadata,'{billing,egress}',
      COALESCE(metadata#>'{billing,egress}','{}'::jsonb) || $2::jsonb)
    WHERE id=$1 AND owning_bay_id=$3
      AND COALESCE((metadata#>>'{billing,egress,metered_through_at}')::timestamptz,date_trunc('milliseconds',created_at))=$4
      AND metadata#>>'{billing,course_funding,funding_epoch}'=$5`,
    [
      current.id,
      JSON.stringify(live),
      current.owning_bay_id,
      opts.start,
      current.metadata.billing.course_funding.funding_epoch,
    ],
  );
  if (!result.rowCount) return;
  return {
    total_bytes: totalBytes,
    threshold_reached: toDecimal(totalBytes)
      .div(1_000_000_000)
      .mul("0.1")
      .gte(courseVmBinding(current).egress_usd),
  };
}

export async function queueCourseVmEnforcement(
  vm: ComputeVmRow,
  action: "stop" | "delete",
) {
  const epoch = vm.metadata?.billing?.course_funding?.funding_epoch;
  if (!epoch) fundingConflict("Missing sponsored VM epoch.");
  const key = `course-${action}:${vm.id}:${epoch}`;
  // The generation/epoch comparison is at mutation time, not just when the
  // sweep read the VM. Queue insertion and intent mutation commit together.
  await getPool().query(
    `WITH changed AS (
    UPDATE compute_vms SET desired_state=$4,state=$5,updated_at=NOW(),
      metadata=CASE WHEN $8='stop' AND desired_state='running' THEN
        jsonb_set(metadata,'{billing,course_funding,stop_intent}',jsonb_build_object('stop_generation',stop_generation,'requested_at',clock_timestamp()))
        ELSE metadata END
    WHERE id=$1 AND owning_bay_id=$2 AND metadata#>>'{billing,course_funding,funding_epoch}'=$3
      AND instance_generation=$6 AND deleted_at IS NULL AND desired_state<>'deleted'
      AND metadata#>>'{billing,course_funding,binding,authorized_until}' IS NOT DISTINCT FROM $10::text
    RETURNING id
  ) INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
    SELECT $7,'vm',id,$8,$9,jsonb_build_object('funding_epoch',$3::text),'queued',0,NOW(),NOW(),NOW() FROM changed
    WHERE NOT EXISTS (SELECT 1 FROM compute_resource_work WHERE resource_id=$1 AND action=$8 AND state IN ('queued','in_progress'))`,
    [
      vm.id,
      vm.owning_bay_id,
      epoch,
      action === "delete" ? "deleted" : "stopped",
      action === "delete"
        ? "deleting"
        : vm.state === "stopped"
          ? "stopped"
          : "stopping",
      vm.instance_generation,
      randomUUID(),
      action,
      key,
      vm.metadata?.billing?.course_funding?.binding?.authorized_until ?? null,
    ],
  );
}

export async function enqueueCourseFundingDeadlines(): Promise<void> {
  const { rows } = await getPool().query<ComputeVmRow>(
    `SELECT * FROM compute_vms
    WHERE owning_bay_id=$1 AND deleted_at IS NULL AND metadata#>'{billing,course_funding,binding}' IS NOT NULL
      AND (metadata#>>'{billing,course_funding,binding,resource_generation}')::integer=instance_generation
      AND ((metadata#>>'{billing,course_funding,binding,storage_delete_at}')::timestamptz<=NOW()
        OR (desired_state='running' AND (metadata#>>'{billing,course_funding,binding,stop_at}')::timestamptz<=NOW())) LIMIT 100`,
    [getConfiguredBayId()],
  );
  for (const vm of rows) {
    const binding = courseVmBinding(vm);
    await queueCourseVmEnforcement(
      vm,
      Date.now() >= new Date(binding.storage_delete_at).valueOf()
        ? "delete"
        : "stop",
    );
  }
}

/** Called before the owner's personal funding policy. A payer outage cannot
 * prevent stopping, and it never authorizes falling back to the owner's money.
 */
export async function enforceCourseVmFunding(
  vm: ComputeVmRow,
): Promise<"stop" | "delete" | undefined> {
  if (
    !vm.metadata?.billing?.course_funding?.binding &&
    Date.now() - vm.created_at.valueOf() < VM_FUNDING_MARGIN_MS
  )
    return;
  const binding = courseVmBinding(vm);
  if (Date.now() >= new Date(binding.storage_delete_at).valueOf())
    return "delete";
  if (vm.stopped_at || vm.desired_state === "stopped") return;
  try {
    await requireCourseVmService(vm, false, true);
  } catch {
    return "stop";
  }
}

export async function refreshCourseVmForProvider(
  vm: ComputeVmRow,
): Promise<void> {
  if (vm.home_volume_id) {
    const { getComputeVolumeById } = await import("../volume-db");
    const volume = await getComputeVolumeById(vm.home_volume_id);
    if (!volume || volume.owner_account_id !== vm.owner_account_id)
      fundingConflict("VM home volume is unavailable.");
    await (await import("./volume-funding")).requireCourseVolumeService(volume);
  }
  if (!hasCourseVmFunding(vm)) return;
  const current = await getComputeVmById(vm.id);
  if (!current || current.instance_generation !== vm.instance_generation)
    fundingConflict("Stale sponsored VM provider work.");
  await requireCourseVmService(current, true);
}
