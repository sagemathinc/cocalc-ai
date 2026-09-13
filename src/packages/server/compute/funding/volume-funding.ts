/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { ComputeVmFundingBinding } from "@cocalc/util/compute-vm-funding";
import type { ComputeVolumeFundingStatus } from "@cocalc/util/compute-volume-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type { ComputeVolumeRow } from "../types";
import { getComputeVolumeById } from "../volume-db";
import {
  normalizeVmFundingSource,
  payerApi,
  requireSponsoredVmAdmission,
} from "./vm-funding";
import { fundingConflict } from "./vm-reservations";

export const volumeFunding = (v: ComputeVolumeRow) =>
  v.metadata.billing.course_funding;

export function hasCourseVolumeFunding(
  volume: Pick<ComputeVolumeRow, "metadata">,
): boolean {
  return volume.metadata?.billing?.course_funding != null;
}

export function courseVolumeBinding(
  volume: ComputeVolumeRow,
): ComputeVmFundingBinding {
  const data = volumeFunding(volume);
  const binding = data.binding as ComputeVmFundingBinding | undefined;
  if (
    !binding ||
    binding.resource_kind !== "compute-volume" ||
    binding.source.kind !== "course" ||
    binding.resource_id !== volume.id ||
    binding.owner_account_id !== volume.owner_account_id ||
    volume.owning_bay_id !== getConfiguredBayId() ||
    binding.owning_bay_id !== volume.owning_bay_id ||
    binding.funding_epoch !== data.funding_epoch
  )
    fundingConflict("Volume funding binding is pending or stale.");
  return binding;
}

export function volumeFundingBindings(
  volume: ComputeVolumeRow,
): ComputeVmFundingBinding[] {
  const base = courseVolumeBinding(volume);
  const result = [base];
  for (const slice of volumeFunding(volume).growth ?? []) {
    const binding = slice.binding as ComputeVmFundingBinding | undefined;
    if (!binding) continue;
    if (
      binding.resource_kind !== "compute-volume" ||
      binding.resource_id !== volume.id ||
      binding.owner_account_id !== volume.owner_account_id ||
      binding.owning_bay_id !== volume.owning_bay_id ||
      binding.payer_account_id !== base.payer_account_id ||
      binding.source.kind !== "course" ||
      base.source.kind !== "course" ||
      binding.source.pool_id !== base.source.pool_id ||
      binding.source.grant_id !== base.source.grant_id ||
      binding.funding_epoch !== slice.request.funding_epoch
    )
      fundingConflict(
        "Volume growth changed its independently authorized payer.",
      );
    result.push(binding);
  }
  return result;
}

export function volumeFundingDeadline(
  volume: ComputeVolumeRow,
  key: "stop_at" | "authorized_until" | "storage_delete_at",
): string {
  return new Date(
    Math.min(
      ...volumeFundingBindings(volume).map((b) => new Date(b[key]).valueOf()),
    ),
  ).toISOString();
}

export function publicVolumeFundingStatus(
  volume: ComputeVolumeRow,
): ComputeVolumeFundingStatus | undefined {
  if (!hasCourseVolumeFunding(volume)) return;
  const data = volumeFunding(volume);
  const all = data.binding ? volumeFundingBindings(volume) : [];
  const sum = (key: "authorized_usd" | "protected_usd") =>
    moneyToDbString(all.reduce((n, b) => n.plus(b[key]), toDecimal(0)));
  const spent = data.spent_usd ?? "0";
  return {
    source: {
      kind: "course",
      pool_id: data.source.pool_id,
      grant_id: data.source.grant_id,
    },
    label: "Course funding",
    funding_version: data.funding_epoch,
    state: volume.deleted_at
      ? "closed"
      : !data.binding
        ? "pending"
        : data.service_ended_at
          ? "protected"
          : "ready",
    lane: all[0]?.lane,
    spent_usd: spent,
    committed_usd: all.length ? sum("authorized_usd") : undefined,
    remaining_usd: all.length
      ? moneyToDbString(toDecimal(sum("authorized_usd")).minus(spent))
      : undefined,
    protected_storage_usd: all.length ? sum("protected_usd") : undefined,
    authorized_until: all.length
      ? volumeFundingDeadline(volume, "authorized_until")
      : undefined,
    stop_at: all.length ? volumeFundingDeadline(volume, "stop_at") : undefined,
    storage_delete_at: all.length
      ? volumeFundingDeadline(volume, "storage_delete_at")
      : undefined,
    as_of: (volume.billing_updated_at ?? volume.created_at).toISOString(),
  };
}

/** Rechecked with the volume row locked by VM attachment admission. */
export function assertCourseVolumeAttachable(volume: ComputeVolumeRow): void {
  if (!hasCourseVolumeFunding(volume)) return;
  if (
    volume.deleted_at ||
    volume.desired_state !== "ready" ||
    volumeFunding(volume).service_ended_at ||
    new Date(volumeFundingDeadline(volume, "stop_at")).valueOf() <= Date.now()
  )
    fundingConflict(
      "The home volume is in protected storage and cannot attach or start.",
    );
}

export async function reserveCourseVolume(
  volume: ComputeVolumeRow,
): Promise<ComputeVolumeRow> {
  if (!hasCourseVolumeFunding(volume) || volumeFunding(volume).binding)
    return volume;
  await requireSponsoredVmAdmission();
  if (volume.desired_state !== "ready" || volume.deleted_at)
    fundingConflict("Volume creation was cancelled.");
  const data = volumeFunding(volume);
  const source = normalizeVmFundingSource(data.source)!;
  if (!source.payer_account_id) {
    const {
      rows: [hint],
    } = await getPool().query<{ payer_account_id: string }>(
      "SELECT payer_account_id FROM compute_funding_pools WHERE id=$1",
      [source.pool_id],
    );
    if (!hint)
      fundingConflict("Volume source needs a payer routing reference.");
    source.payer_account_id = hint.payer_account_id;
  }
  const rate = volume.metadata.billing.rate;
  const binding = await (
    await payerApi(source.payer_account_id!)
  ).reserveComputeVmFunding({
    account_id: source.payer_account_id!,
    source,
    resource_kind: "compute-volume",
    resource_id: volume.id,
    resource_generation: 1,
    owner_account_id: volume.owner_account_id,
    owning_bay_id: volume.owning_bay_id,
    funding_epoch: data.funding_epoch,
    provider: volume.provider,
    hourly_cost_usd: rate?.hourly_cost_usd,
    storage_hourly_cost_usd: rate?.hourly_cost_usd,
    pricing_snapshot: rate?.pricing_snapshot,
    requested_until: new Date(
      volume.created_at.valueOf() + 25 * 60_000,
    ).toISOString(),
  });
  // Persist lost replies even after cancellation, without resurrecting intent.
  await getPool().query(
    `UPDATE compute_volumes SET funding_mode=$4,billing_state='pending',
    metadata=jsonb_set(jsonb_set(metadata,'{billing,course_funding,binding}',$3::jsonb),'{billing,funding_mode}',to_jsonb($4::text))
    WHERE id=$1 AND owning_bay_id=$5 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2`,
    [
      volume.id,
      data.funding_epoch,
      JSON.stringify(binding),
      binding.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
      volume.owning_bay_id,
    ],
  );
  return (await getComputeVolumeById(volume.id))!;
}

export async function requireCourseVolumeService(
  volume: ComputeVolumeRow,
  dispatch = false,
  renew = false,
): Promise<void> {
  if (!hasCourseVolumeFunding(volume)) return;
  assertCourseVolumeAttachable(volume);
  for (const binding of volumeFundingBindings(volume)) {
    const api = await payerApi(binding.payer_account_id);
    const request = { account_id: binding.payer_account_id, binding, dispatch };
    let updated: ComputeVmFundingBinding;
    if (
      renew &&
      new Date(binding.stop_at).valueOf() - Date.now() < 5 * 60_000
    ) {
      try {
        await requireSponsoredVmAdmission();
        updated = await api.checkComputeVmFunding({
          ...request,
          renew_until: new Date(Date.now() + 20 * 60_000).toISOString(),
        });
      } catch {
        updated = await api.checkComputeVmFunding(request);
      }
    } else updated = await api.checkComputeVmFunding(request);
    if (updated.authorized_until === binding.authorized_until) continue;
    const index = (volumeFunding(volume).growth ?? []).findIndex(
      (s) => s.binding?.reservation_id === binding.reservation_id,
    );
    const path =
      index < 0
        ? ["billing", "course_funding", "binding"]
        : ["billing", "course_funding", "growth", `${index}`, "binding"];
    await getPool().query(
      `UPDATE compute_volumes SET metadata=jsonb_set(metadata,$3::text[],$4::jsonb)
      WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
        AND metadata#>>($3::text[] || ARRAY['authorized_until'])=$5
        AND metadata#>>'{billing,course_funding,service_ended_at}' IS NULL`,
      [
        volume.id,
        volumeFunding(volume).funding_epoch,
        path,
        JSON.stringify(updated),
        binding.authorized_until,
      ],
    );
  }
}

export async function refreshCourseVolumeForProvider(
  volume: ComputeVolumeRow,
): Promise<ComputeVolumeRow> {
  if (!hasCourseVolumeFunding(volume)) return volume;
  let current = await getComputeVolumeById(volume.id);
  if (
    !current ||
    volumeFunding(current).funding_epoch !== volumeFunding(volume).funding_epoch
  )
    fundingConflict("Stale volume provider work.");
  current = await (
    await import("./volume-growth")
  ).resumeCourseVolumeGrowth(current);
  await requireCourseVolumeService(current, true);
  const pending = (volumeFunding(current).growth ?? []).find(
    (s) => !s.started_at,
  );
  if (
    pending &&
    (!pending.binding || pending.size_gb !== current.desired_size_gb)
  )
    fundingConflict("Volume growth reservation has not committed.");
  return current;
}

export async function meterCourseVolume(
  volume: ComputeVolumeRow,
): Promise<void> {
  if (!hasCourseVolumeFunding(volume)) return;
  const {
    rows: [current],
  } = await getPool().query<ComputeVolumeRow & { meter_as_of: Date }>(
    "SELECT *,clock_timestamp() AS meter_as_of FROM compute_volumes WHERE id=$1 AND owning_bay_id=$2",
    [volume.id, getConfiguredBayId()],
  );
  if (
    !current ||
    volumeFunding(current).funding_epoch !==
      volumeFunding(volume).funding_epoch ||
    !volumeFunding(current).binding
  )
    return;
  volume = current;
  const end = volume.deleted_at ?? current.meter_as_of;
  const protectedAt =
    volumeFunding(volume).service_ended_at ??
    volumeFundingDeadline(volume, "stop_at");
  const serviceEnd = new Date(
    Math.min(end.valueOf(), new Date(protectedAt).valueOf()),
  );
  let spent = toDecimal(0);
  for (const binding of volumeFundingBindings(volume)) {
    const slice = (volumeFunding(volume).growth ?? []).find(
      (s) => s.binding?.reservation_id === binding.reservation_id,
    );
    const start = slice
      ? slice.started_at
        ? new Date(slice.started_at)
        : undefined
      : volume.ready_at;
    // Disk existence, unlike running compute, continues between observations.
    // Its persisted ready/deleted boundaries exclude failed provider creation.
    const runEnd = new Date(
      Math.max(serviceEnd.valueOf(), start?.valueOf() ?? 0),
    );
    const result = await (
      await payerApi(binding.payer_account_id)
    ).settleComputeVmFunding({
      account_id: binding.payer_account_id,
      binding,
      meter_as_of: current.meter_as_of.toISOString(),
      running_started_at: start?.toISOString() ?? null,
      running_until: runEnd.toISOString(),
      stopped_until: runEnd < end ? end.toISOString() : undefined,
      deleted: volume.deleted_at != null,
    });
    spent = spent.plus(result.charged_usd);
  }
  await getPool().query(
    `UPDATE compute_volumes SET metadata=jsonb_set(metadata,'{billing,course_funding,spent_usd}',to_jsonb($3::text)),
    billing_updated_at=$4,billing_state=$5 WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
      AND (billing_updated_at IS NULL OR billing_updated_at<=$4)`,
    [
      volume.id,
      volumeFunding(volume).funding_epoch,
      moneyToDbString(spent),
      current.meter_as_of,
      volume.deleted_at ? "closed" : "course-storage",
    ],
  );
}

export async function endCourseVolumeService(
  volume: ComputeVolumeRow,
): Promise<void> {
  if (!hasCourseVolumeFunding(volume) || !volumeFunding(volume).binding) return;
  const epoch = volumeFunding(volume).funding_epoch;
  await getPool().query(
    `UPDATE compute_volumes SET
    metadata=jsonb_set(metadata,'{billing,course_funding,service_ended_at}',to_jsonb(LEAST(clock_timestamp(),$3::timestamptz))),updated_at=NOW()
    WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2
      AND metadata#>>'{billing,course_funding,service_ended_at}' IS NULL
      AND metadata#>>'{billing,course_funding,binding,authorized_until}'=$4
      AND COALESCE(metadata#>'{billing,course_funding,growth}','[]'::jsonb)=$5::jsonb`,
    [
      volume.id,
      epoch,
      volumeFundingDeadline(volume, "stop_at"),
      courseVolumeBinding(volume).authorized_until,
      JSON.stringify(volumeFunding(volume).growth ?? []),
    ],
  );
  const current = await getComputeVolumeById(volume.id);
  if (
    !current ||
    volumeFunding(current).funding_epoch !== epoch ||
    !volumeFunding(current).service_ended_at
  )
    return;
  volume = current;
  await getPool().query(
    `WITH stopped AS (UPDATE compute_vms SET desired_state='stopped',state='stopping',updated_at=NOW()
    WHERE home_volume_id=$1 AND owner_account_id=$2 AND owning_bay_id=$3 AND desired_state='running'
      AND EXISTS (SELECT 1 FROM compute_volumes WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$4
        AND metadata#>>'{billing,course_funding,service_ended_at}' IS NOT NULL) RETURNING id)
    INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
    SELECT $5,'vm',id,'stop',$6,'{}','queued',0,NOW(),NOW(),NOW() FROM stopped`,
    [
      volume.id,
      volume.owner_account_id,
      volume.owning_bay_id,
      epoch,
      randomUUID(),
      `volume-funding-stop:${volume.id}:${epoch}`,
    ],
  );
  if (
    new Date(volumeFundingDeadline(volume, "storage_delete_at")).valueOf() <=
    Date.now()
  )
    await getPool().query(
      `WITH expired AS (UPDATE compute_volumes SET desired_state='deleted',state='deleting',updated_at=NOW()
      WHERE id=$1 AND owning_bay_id=$2 AND metadata#>>'{billing,course_funding,funding_epoch}'=$3 AND deleted_at IS NULL RETURNING id)
      INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
      SELECT $4,'volume',id,'delete_volume',$5,jsonb_build_object('funding_epoch',$3::text),'queued',0,NOW(),NOW(),NOW() FROM expired
      WHERE NOT EXISTS (SELECT 1 FROM compute_resource_work WHERE resource_id=$1 AND action='delete_volume' AND state IN ('queued','in_progress'))`,
      [
        volume.id,
        volume.owning_bay_id,
        epoch,
        randomUUID(),
        `course-volume-delete:${volume.id}:${epoch}`,
      ],
    );
}

export async function enforceCourseVolumeFunding(
  volume: ComputeVolumeRow,
): Promise<void> {
  if (!volumeFunding(volume).binding) return;
  if (!volumeFunding(volume).service_ended_at) {
    try {
      await requireCourseVolumeService(volume, false, true);
    } catch {
      await endCourseVolumeService(volume);
    }
  } else await endCourseVolumeService(volume);
  await meterCourseVolume(volume);
}

/** Local deadline intents run separately from potentially unreachable payers. */
export async function enqueueCourseVolumeDeadlines(): Promise<void> {
  const { rows } = await getPool().query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes
    WHERE owning_bay_id=$1 AND deleted_at IS NULL AND metadata#>'{billing,course_funding,binding}' IS NOT NULL`,
    [getConfiguredBayId()],
  );
  for (const volume of rows)
    if (
      volumeFunding(volume).service_ended_at ||
      new Date(volumeFundingDeadline(volume, "stop_at")).valueOf() <= Date.now()
    )
      await endCourseVolumeService(volume);
}
