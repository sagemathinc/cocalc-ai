/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import { getLogger } from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { fundingId } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type {
  VolumePersonalFundingApi,
  VolumePersonalFundingConsent,
  VolumePersonalFundingTerms,
} from "@cocalc/util/compute-volume-personal-funding";
import type { ComputeVolumeRow } from "../types";
import type { ComputeVmFundingBinding } from "@cocalc/util/compute-vm-funding";
import {
  assertFundingPayerHomeBay,
  proposeVolumePersonalFundingApproval,
} from "./approvals";
import {
  normalizePersonalVolumeApprovalTerms,
  validatePersonalVolumeApprovalReview,
} from "./approval-volume-personal";
import type { PersonalVolumeApprovalReview } from "./approval-volume-personal";
import { withFundingAccountTransaction } from "./backing";
import { getComputeFundingPolicyInTransaction } from "./policy";
import { loadFundingExposureBudget } from "./exposure";
import {
  fundingConflict,
  quoteVmFundingAdmission,
  VM_FUNDING_MARGIN_MS,
  VM_FUNDING_STORAGE_MS,
} from "./vm-reservations";
import { reservePersonalVolumeInTransaction } from "./vm-personal-reservations";
import { withFundingResourceMeterLock } from "./resource-meter-lock";
import {
  courseVolumeBinding,
  volumeFunding,
  volumeFundingBindings,
  volumeFundingDeadline,
} from "./volume-funding";
import { requireSponsoredVmAdmission } from "./vm-funding";
import { resolvePersonalResourceReview } from "./resource-review";

type Opts<K extends keyof VolumePersonalFundingApi> = Parameters<
  VolumePersonalFundingApi[K]
>[0] & { account_id?: string };
export interface PersonalVolumeConsentRow extends Omit<
  VolumePersonalFundingConsent,
  "as_of" | "approval_expires_at" | "activated_at"
> {
  payer_account_id: string;
  volume_id: string;
  review: PersonalVolumeApprovalReview;
  updated_at: Date;
  approval_expires_at: Date;
  activated_at?: Date;
  handoff_operation_id?: string;
  cleared_operation_id?: string;
  handoff?: { remote_volume?: { state: "pending" | "committed" | "aborted" } };
}
type ConsentRow = PersonalVolumeConsentRow;

const normalize = (
  input: VolumePersonalFundingTerms,
): VolumePersonalFundingTerms => {
  const { kind: _kind, ...terms } = normalizePersonalVolumeApprovalTerms({
    ...input,
    kind: "personalVolumeFunding",
  });
  return terms;
};
export const personalVolumeConsentView = (
  row: ConsentRow,
): VolumePersonalFundingConsent => ({
  id: row.id,
  version: row.version,
  state:
    row.state === "active" && row.handoff?.remote_volume?.state === "pending"
      ? "preparing"
      : row.state,
  terms: row.terms,
  spent_usd: row.spent_usd,
  committed_usd: row.committed_usd,
  remaining_usd: moneyToDbString(
    toDecimal(row.terms.cap_usd).minus(row.spent_usd).minus(row.committed_usd),
  ),
  approval_url: row.approval_url,
  approval_expires_at: row.approval_expires_at.toISOString(),
  activated_at: row.activated_at?.toISOString(),
  as_of: row.updated_at.toISOString(),
});
const view = personalVolumeConsentView;

export async function ownedPersonalVolume(
  payer: string,
  id: string,
  db?: PoolClient,
): Promise<ComputeVolumeRow> {
  const {
    rows: [volume],
  } = await (db ?? getPool()).query<ComputeVolumeRow>(
    `SELECT * FROM compute_volumes WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3 ${db ? "FOR UPDATE" : ""}`,
    [fundingId(id, "Volume"), payer, getConfiguredBayId()],
  );
  if (!volume)
    fundingConflict("Personal storage requires its owner on the owning bay.");
  return volume;
}
const ownedVolume = ownedPersonalVolume;

export function reviewPersonalVolumeRow(
  volume: ComputeVolumeRow,
  terms: VolumePersonalFundingTerms,
): PersonalVolumeApprovalReview {
  if (!volume.metadata?.billing?.course_funding?.binding)
    fundingConflict(
      "This disk does not have a bounded funding agreement to replace.",
    );
  if (
    volume.deleted_at ||
    volume.desired_state !== "ready" ||
    volume.state !== "ready" ||
    !volume.ready_at ||
    volume.attached_vm_id ||
    volume.attachment_state !== "detached" ||
    volume.size_gb !== volume.desired_size_gb ||
    (volumeFunding(volume)?.growth ?? []).some((s) => !s.started_at)
  )
    fundingConflict(
      "Detach the home volume and finish pending storage work before changing its funding.",
    );
  const binding = courseVolumeBinding(volume);
  if (binding.funding_epoch !== terms.expected_funding_version)
    fundingConflict("Storage funding changed; review again.");
  const now = new Date();
  const end = new Date(terms.ends_at);
  const deletion = new Date(
    end.valueOf() + VM_FUNDING_STORAGE_MS,
  ).toISOString();
  const rate = volume.metadata.billing.rate.hourly_cost_usd;
  const quote = quoteVmFundingAdmission(
    {
      requested_until: new Date(now.valueOf() + 25 * 60_000).toISOString(),
      requested_stop_at: new Date(
        end.valueOf() - VM_FUNDING_MARGIN_MS,
      ).toISOString(),
      requested_delete_at: deletion,
      hourly_cost_usd: rate,
      storage_hourly_cost_usd: rate,
    },
    now,
  );
  if (toDecimal(quote.authorized_usd).gt(terms.cap_usd))
    fundingConflict(
      "Personal limit cannot cover storage and protected cleanup.",
    );
  return {
    volume_id: volume.id,
    volume_name: volume.name,
    owner_account_id: volume.owner_account_id,
    owning_bay_id: volume.owning_bay_id,
    funding_epoch: binding.funding_epoch,
    resource_generation: binding.resource_generation,
    attachment_generation: volume.attachment_generation,
    size_gb: volume.size_gb,
    hourly_usd: rate,
    protected_storage_usd: quote.protected_usd,
    storage_delete_at: deletion,
    provider: volume.provider,
  };
}
const reviewVolume = reviewPersonalVolumeRow;

export async function reviewPersonalVolumeFunding(
  payer: string,
  input: VolumePersonalFundingTerms,
) {
  await assertFundingPayerHomeBay(payer);
  const result = await resolvePersonalResourceReview({
    account_id: payer,
    kind: "volume",
    terms: normalize(input),
  });
  if (result.kind !== "volume") throw Error("Storage review unavailable.");
  return result.review;
}

export async function reviewPersonalVolumeFundingOnBay(
  payer: string,
  input: VolumePersonalFundingTerms,
) {
  return reviewVolume(
    await ownedVolume(payer, input.volume_id),
    normalize(input),
  );
}

export function samePersonalVolumeReview(
  a: PersonalVolumeApprovalReview,
  b: PersonalVolumeApprovalReview,
) {
  return [
    "volume_id",
    "owner_account_id",
    "owning_bay_id",
    "funding_epoch",
    "resource_generation",
    "attachment_generation",
    "size_gb",
    "hourly_usd",
    "storage_delete_at",
    "provider",
  ].every((k) => a[k] === b[k]);
}
const sameReview = samePersonalVolumeReview;

export async function approvePersonalVolumeFunding(opts: {
  db: PoolClient;
  payer_account_id: string;
  intent_id: string;
  terms: VolumePersonalFundingTerms;
  review: PersonalVolumeApprovalReview;
}): Promise<{ consent_id: string }> {
  const { db, payer_account_id: payer, terms } = opts;
  validatePersonalVolumeApprovalReview(payer, terms, opts.review);
  // Saving a remote consent does not dispatch or reserve service. The owning
  // bay must compare this approved generation/quote again before a handoff.
  const current =
    opts.review.owning_bay_id === getConfiguredBayId()
      ? reviewVolume(await ownedVolume(payer, terms.volume_id, db), terms)
      : opts.review;
  if (!sameReview(current, opts.review))
    fundingConflict("Storage changed; request a new approval.");
  const {
    rows: [row],
  } = await db.query(
    "UPDATE compute_vm_personal_consents SET state='approved',review=$5::jsonb,version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND payer_account_id=$2 AND volume_id=$3 AND state='pending' AND terms=$4::jsonb RETURNING id",
    [
      opts.intent_id,
      payer,
      terms.volume_id,
      JSON.stringify(normalize(terms)),
      JSON.stringify(opts.review),
    ],
  );
  if (!row) fundingConflict("Storage approval is no longer pending.");
  return { consent_id: row.id };
}

export async function previewVolumePersonalFunding(
  opts: Opts<"previewVolumePersonalFunding">,
) {
  const payer = fundingId(opts.account_id, "Account");
  const terms = normalize(opts.terms);
  const review = await reviewPersonalVolumeFunding(payer, terms);
  const policy = await withFundingAccountTransaction(payer, (db) =>
    getComputeFundingPolicyInTransaction(db, {
      payer_account_id: payer,
      lane: terms.lane,
      for_service: true,
    }),
  );
  return {
    terms,
    volume_name: review.volume_name,
    size_gb: review.size_gb,
    hourly_usd: review.hourly_usd,
    protected_storage_usd: review.protected_storage_usd,
    storage_delete_at: review.storage_delete_at,
    available_usd: policy.available_backing_usd,
    as_of: new Date().toISOString(),
  };
}

export async function proposeVolumePersonalFunding(
  opts: Opts<"proposeVolumePersonalFunding">,
) {
  const payer = fundingId(opts.account_id, "Account");
  const preview = await previewVolumePersonalFunding(opts);
  const intent = await proposeVolumePersonalFundingApproval({
    payer_account_id: payer,
    operation_id: fundingId(opts.operation_id, "Operation"),
    terms: preview.terms,
  });
  const review = await reviewPersonalVolumeFunding(payer, preview.terms);
  return withFundingAccountTransaction(payer, async (db) => {
    const {
      rows: [row],
    } = await db.query<ConsentRow>(
      `INSERT INTO compute_vm_personal_consents (id,payer_account_id,volume_id,operation_id,terms,review,state,approval_url,approval_expires_at)
      VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8)
      ON CONFLICT (payer_account_id,operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id RETURNING *`,
      [
        intent.intent_id,
        payer,
        preview.terms.volume_id,
        opts.operation_id,
        preview.terms,
        review,
        intent.approval_url,
        intent.expires_at,
      ],
    );
    return view(row);
  });
}

export async function getVolumePersonalFunding(
  opts: Opts<"getVolumePersonalFunding">,
) {
  const payer = fundingId(opts.account_id, "Account");
  await assertFundingPayerHomeBay(payer);
  fundingId(opts.volume_id, "Volume");
  const {
    rows: [row],
  } = await getPool().query<ConsentRow>(
    "SELECT * FROM compute_vm_personal_consents WHERE payer_account_id=$1 AND volume_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
    [payer, opts.volume_id],
  );
  return row ? view(row) : null;
}

export async function switchVolumePersonalFunding(
  opts: Opts<"switchVolumePersonalFunding">,
) {
  const payer = fundingId(opts.account_id, "Account");
  await assertFundingPayerHomeBay(payer);
  await requireSponsoredVmAdmission();
  fundingId(opts.operation_id, "Operation");
  const remote = await (
    await import("./volume-personal-remote")
  ).switchRemotePersonalVolume(payer, opts);
  if (remote) return remote;
  const budget = await loadFundingExposureBudget(getConfiguredBayId());
  const result = await withFundingResourceMeterLock(
    "volume",
    fundingId(opts.volume_id, "Volume"),
    () =>
      withFundingAccountTransaction(payer, async (db) => {
        const volume = await ownedVolume(payer, opts.volume_id, db);
        const {
          rows: [consent],
        } = await db.query<ConsentRow>(
          "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND volume_id=$3 FOR UPDATE",
          [fundingId(opts.consent_id, "Consent"), payer, volume.id],
        );
        if (!consent) fundingConflict("Storage consent not found.");
        if (consent.handoff_operation_id === opts.operation_id)
          return view(consent);
        if (
          consent.state !== "approved" ||
          consent.version !== opts.expected_version ||
          !sameReview(consent.review, reviewVolume(volume, consent.terms))
        )
          fundingConflict(
            "Unchanged, separately approved storage funding is required.",
          );
        const cutover = new Date();
        const until = new Date(
          Math.min(
            cutover.valueOf() + 25 * 60_000,
            Date.parse(consent.terms.ends_at),
          ),
        );
        await db.query(
          "UPDATE compute_vm_personal_consents SET state='preparing' WHERE id=$1",
          [consent.id],
        );
        const binding = await reservePersonalVolumeInTransaction(
          db,
          undefined,
          volume,
          consent.id,
          randomUUID(),
          until,
          budget,
          cutover,
        );
        await applyPersonalVolumeBinding(db, volume, binding, cutover);
        const {
          rows: [updated],
        } = await db.query<ConsentRow>(
          "UPDATE compute_vm_personal_consents SET state='active',version=version+1,activated_at=$2,handoff_operation_id=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
          [consent.id, cutover, opts.operation_id],
        );
        return view(updated);
      }),
  );
  if (!result)
    fundingConflict("Storage metering is busy; retry this same request.");
  return result;
}

/** Called only under the owning volume's row and metering locks. */
export async function applyPersonalVolumeBinding(
  db: PoolClient,
  volume: ComputeVolumeRow,
  binding: ComputeVmFundingBinding,
  cutover: Date,
): Promise<void> {
  const previous = volumeFunding(volume);
  const history = volumeFundingBindings(volume).map((old) => {
    const slice = (previous.growth ?? []).find(
      (s) => s.binding?.reservation_id === old.reservation_id,
    );
    return {
      binding: old,
      started_at: new Date(
        slice ? slice.started_at : (previous.started_at ?? volume.ready_at!),
      ).toISOString(),
      service_ended_at:
        previous.service_ended_at ?? volumeFundingDeadline(volume, "stop_at"),
      transferred_at: cutover.toISOString(),
      successor_binding: binding,
    };
  });
  await db.query(
    `UPDATE compute_volumes SET funding_mode=$2,billing_state='pending',billing_updated_at=NULL,
    metadata=jsonb_set(jsonb_set(metadata,'{billing,course_funding}',$3::jsonb),'{billing,funding_mode}',to_jsonb($2::text)),updated_at=clock_timestamp() WHERE id=$1`,
    [
      volume.id,
      binding.lane === "prepaid" ? "account-prepaid" : "account-postpaid",
      {
        source: binding.source,
        funding_epoch: binding.funding_epoch,
        binding,
        started_at: cutover.toISOString(),
        history: [...(previous.history ?? []), ...history],
      },
    ],
  );
}

export async function clearVolumePersonalFunding(
  opts: Opts<"clearVolumePersonalFunding">,
) {
  const payer = fundingId(opts.account_id, "Account");
  await assertFundingPayerHomeBay(payer);
  fundingId(opts.operation_id, "Operation");
  fundingId(opts.volume_id, "Volume");
  return withFundingAccountTransaction(payer, async (db) => {
    // Revoking a payer's own consent must also work after account rehome.
    // Resource enforcement consults this authority; cancellation releases no
    // storage backing and never deletes a disk here.
    const {
      rows: [row],
    } = await db.query<ConsentRow>(
      "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND volume_id=$3 FOR UPDATE",
      [fundingId(opts.consent_id, "Consent"), payer, opts.volume_id],
    );
    if (!row) fundingConflict("Storage consent not found.");
    if (row.cleared_operation_id === opts.operation_id) return view(row);
    if (row.version !== opts.expected_version)
      fundingConflict("Storage consent changed.");
    const {
      rows: [updated],
    } = await db.query<ConsentRow>(
      "UPDATE compute_vm_personal_consents SET state='cancelled',version=version+1,cleared_operation_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [row.id, opts.operation_id],
    );
    return view(updated);
  });
}

const logger = getLogger("compute:funding:personal-storage");
let closingCursor = "00000000-0000-0000-0000-000000000000";
export async function closeEndedVolumePersonalConsents(): Promise<void> {
  await (
    await import("./volume-personal-remote")
  ).processRemotePersonalVolumeHandoffs();
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN compute_volumes v ON v.id=c.volume_id
      WHERE c.id>$2 AND v.owning_bay_id=$1 AND c.state IN ('pending','approved','active')
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.account_id=c.payer_account_id AND COALESCE(a.home_bay_id,$1)=$1)
        AND (v.desired_state='deleted' OR v.deleted_at IS NOT NULL OR (c.terms->>'ends_at')::timestamptz<=clock_timestamp()
          OR (c.state='active' AND v.metadata#>>'{billing,course_funding,source,consent_id}' IS DISTINCT FROM c.id::text))
      ORDER BY c.id LIMIT 20`,
    [getConfiguredBayId(), closingCursor],
  );
  closingCursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      await withFundingAccountTransaction(row.payer_account_id, async (db) => {
        const volume = await ownedVolume(
          row.payer_account_id,
          row.volume_id,
          db,
        );
        const cancelled =
          volume.desired_state === "deleted" ||
          volume.deleted_at != null ||
          (row.state === "active" &&
            volumeFunding(volume).source.consent_id !== row.id);
        await db.query(
          `UPDATE compute_vm_personal_consents SET state=CASE WHEN $3 THEN 'cancelled' ELSE 'expired' END,
        version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND version=$2
        AND ($3 OR (terms->>'ends_at')::timestamptz<=clock_timestamp())`,
          [row.id, row.version, cancelled],
        );
      });
    } catch (err) {
      logger.warn("ended storage consent remains pending", {
        consent_id: row.id,
        err,
      });
    }
  }
}
