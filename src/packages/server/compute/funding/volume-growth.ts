/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type {
  ComputeVmFundingBinding,
  ReserveComputeVmFundingRequest,
} from "@cocalc/util/compute-vm-funding";
import type { ComputeVolumeRow } from "../types";
import { getComputeVolumeById } from "../volume-db";
import { payerApi, requireSponsoredVmAdmission } from "./vm-funding";
import { fundingConflict } from "./vm-reservations";
import {
  courseVolumeBinding,
  hasCourseVolumeFunding,
  requireCourseVolumeService,
  volumeFunding,
} from "./volume-funding";

export interface VolumeGrowthSlice {
  operation_id: string;
  size_gb: number;
  rate: Record<string, any>;
  request: ReserveComputeVmFundingRequest;
  binding?: ComputeVmFundingBinding;
  started_at?: string;
}
export const volumeGrowth = (v: ComputeVolumeRow): VolumeGrowthSlice[] =>
  volumeFunding(v).growth ?? [];

/** Resume the durable user intent, including a lost payer reply. A cancelled
 * volume uses lookup-only recovery instead and never creates more backing.
 */
export async function resumeCourseVolumeGrowth(
  volume: ComputeVolumeRow,
): Promise<ComputeVolumeRow> {
  if (
    !hasCourseVolumeFunding(volume) ||
    volume.deleted_at ||
    volume.desired_state !== "ready" ||
    volumeFunding(volume).service_ended_at
  )
    return volume;
  const slice = volumeGrowth(volume).find((s) => !s.started_at);
  if (!slice || (slice.binding && volume.desired_size_gb === slice.size_gb))
    return volume;
  return await reserveCourseVolumeGrowth(volume, {
    operation_id: slice.operation_id,
    expected_funding_version: volumeFunding(volume).funding_epoch,
    size_gb: slice.size_gb,
    rate: slice.rate,
  });
}

/** Incremental storage has a frozen rate and provider-confirmed starting time.
 * All slices retain the parent volume's payer; existing usage is never repriced.
 */
export async function reserveCourseVolumeGrowth(
  volume: ComputeVolumeRow,
  opts: {
    operation_id: string;
    expected_funding_version?: string;
    size_gb: number;
    rate: Record<string, any>;
  },
): Promise<ComputeVolumeRow> {
  await requireSponsoredVmAdmission();
  if (opts.expected_funding_version !== volumeFunding(volume).funding_epoch)
    fundingConflict("Volume funding version changed.");
  await requireCourseVolumeService(volume);
  if (!volume.ready_at || opts.size_gb < volume.size_gb)
    fundingConflict("Only a ready volume can grow.");
  let slice = volumeGrowth(volume).find(
    (s) => s.operation_id === opts.operation_id,
  );
  if (slice && slice.size_gb !== opts.size_gb)
    fundingConflict("Volume growth retry changed size.");
  if (!slice && opts.size_gb === volume.size_gb) return volume;
  const base = courseVolumeBinding(volume);
  if (base.source.kind !== "course")
    fundingConflict(
      "This personal approval covers the current disk size only. A larger disk needs a new storage authorization.",
    );
  if (!slice) {
    if (
      volumeGrowth(volume).some((s) => !s.started_at) ||
      volume.desired_size_gb !== volume.size_gb
    )
      fundingConflict("Another volume growth is pending.");
    const delta = toDecimal(opts.rate.hourly_cost_usd).minus(
      volume.metadata.billing.rate.hourly_cost_usd,
    );
    if (!delta.gt(0))
      fundingConflict(
        "Volume growth requires a positive incremental storage quote.",
      );
    slice = {
      operation_id: opts.operation_id,
      size_gb: opts.size_gb,
      rate: opts.rate,
      request: {
        account_id: base.payer_account_id,
        source: { ...base.source, payer_account_id: base.payer_account_id },
        resource_kind: "compute-volume",
        resource_id: volume.id,
        resource_generation: 1,
        owner_account_id: volume.owner_account_id,
        owning_bay_id: volume.owning_bay_id,
        funding_epoch: randomUUID(),
        provider: volume.provider,
        hourly_cost_usd: moneyToDbString(delta),
        storage_hourly_cost_usd: moneyToDbString(delta),
        pricing_snapshot: opts.rate.pricing_snapshot,
        requested_until: new Date(Date.now() + 25 * 60_000).toISOString(),
      },
    };
    const { rowCount } = await getPool().query(
      `UPDATE compute_volumes SET
      metadata=jsonb_set(metadata,'{billing,course_funding,growth}',COALESCE(metadata#>'{billing,course_funding,growth}','[]'::jsonb) || $3::jsonb)
      WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2 AND desired_state='ready' AND deleted_at IS NULL
        AND desired_size_gb=size_gb AND metadata#>>'{billing,course_funding,service_ended_at}' IS NULL
        AND COALESCE(metadata#>'{billing,course_funding,growth}','[]'::jsonb)=$4::jsonb`,
      [
        volume.id,
        base.funding_epoch,
        JSON.stringify([slice]),
        JSON.stringify(volumeGrowth(volume)),
      ],
    );
    if (!rowCount)
      fundingConflict("Volume changed while reserving growth; retry.");
    volume = (await getComputeVolumeById(volume.id))!;
    // Use the persisted request for both first dispatch and retry. JSONB key
    // ordering must not change the reservation's immutable request hash.
    slice = volumeGrowth(volume).find(
      (s) => s.operation_id === opts.operation_id,
    )!;
  }
  if (slice.started_at) return volume;
  const binding =
    slice.binding ??
    (await (
      await payerApi(base.payer_account_id)
    ).reserveComputeVmFunding(slice.request));
  const index = volumeGrowth(volume).findIndex(
    (s) => s.operation_id === opts.operation_id,
  );
  await getPool().query(
    `UPDATE compute_volumes SET billing_state='pending',metadata=jsonb_set(metadata,$3::text[],$4::jsonb)
    WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2`,
    [
      volume.id,
      base.funding_epoch,
      ["billing", "course_funding", "growth", `${index}`, "binding"],
      JSON.stringify(binding),
    ],
  );
  await getPool().query(
    `UPDATE compute_volumes SET desired_size_gb=$3,state='resizing',error=NULL,
    metadata=jsonb_set(metadata,'{billing,rate}',$4::jsonb),authorized_monthly_cost=$5,monthly_price_per_gb=$6,updated_at=NOW()
    WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2 AND desired_state='ready' AND deleted_at IS NULL
      AND metadata#>>'{billing,course_funding,service_ended_at}' IS NULL`,
    [
      volume.id,
      base.funding_epoch,
      slice.size_gb,
      JSON.stringify(slice.rate),
      toDecimal(slice.rate.hourly_cost_usd).mul(730).toFixed(6),
      toDecimal(slice.rate.hourly_cost_usd)
        .mul(730)
        .div(slice.size_gb)
        .toFixed(6),
    ],
  );
  return (await getComputeVolumeById(volume.id))!;
}

/** Called only after a successful provider resize or disk inspection. */
export async function recordCourseVolumeGrowth(
  volume: ComputeVolumeRow,
  observedSize: number,
): Promise<void> {
  if (!hasCourseVolumeFunding(volume)) return;
  const index = volumeGrowth(volume).findIndex(
    (s) => !s.started_at && s.binding && s.size_gb <= observedSize,
  );
  if (index < 0) return;
  await getPool().query(
    `UPDATE compute_volumes SET metadata=jsonb_set(metadata,$3::text[],to_jsonb(clock_timestamp()))
    WHERE id=$1 AND metadata#>>'{billing,course_funding,funding_epoch}'=$2 AND metadata#>>$3::text[] IS NULL`,
    [
      volume.id,
      volumeFunding(volume).funding_epoch,
      ["billing", "course_funding", "growth", `${index}`, "started_at"],
    ],
  );
}
