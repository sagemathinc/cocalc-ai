/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { isBillingAuthorityEnabled } from "@cocalc/server/purchases/billing-authority/config";
import { billingAccountsTable } from "@cocalc/server/purchases/billing-account";
import { fundingId } from "@cocalc/util/compute-funding";
import { moneyToDbString, toDecimal } from "@cocalc/util/money";
import type {
  VmPersonalFundingApi,
  VmPersonalFundingConsent,
  VmPersonalFundingTerms,
  VmPersonalFundingPreview,
  ComputeVmFallbackDecision,
  VmPersonalFallbackReason,
} from "@cocalc/util/compute-vm-funding";
import type { ComputeVmRow, ComputeVolumeRow } from "../types";
import type { PersonalVmRemoteHandoff } from "@cocalc/util/compute-personal-funding-review";
import {
  enqueuePersonalTransition,
  installPersonalVmFunding,
} from "./vm-personal-cutover";
import { randomUUID } from "node:crypto";
import { getLogger } from "@cocalc/backend/logger";
import { payerApi } from "./vm-funding";
import {
  reservePersonalVmInTransaction,
  reservePersonalVolumeInTransaction,
} from "./vm-personal-reservations";
import {
  assertFundingPayerHomeBay,
  proposeVmPersonalFundingApproval,
} from "./approvals";
import {
  normalizePersonalVmApprovalTerms,
  registerVmPersonalFundingApprovalHandler,
} from "./approval-personal";
import type { PersonalVmApprovalReview } from "./approval-personal";
import { withFundingAccountTransaction } from "./backing";
import { withFundingResourceMeterLock } from "./resource-meter-lock";
import { getComputeFundingPolicyInTransaction } from "./policy";
import { loadFundingExposureBudget } from "./exposure";
import { resolvePersonalResourceReview } from "./resource-review";
import {
  quoteVmFundingAdmission,
  fundingConflict,
  VM_FUNDING_STORAGE_MS,
  VM_FUNDING_MARGIN_MS,
} from "./vm-reservations";

export interface ConsentRow {
  id: string;
  payer_account_id: string;
  vm_id: string;
  operation_id: string;
  terms: VmPersonalFundingTerms;
  review: PersonalVmApprovalReview;
  state: VmPersonalFundingConsent["state"];
  version: number;
  spent_usd: string;
  committed_usd: string;
  approval_url: string;
  approval_expires_at: Date;
  activated_at?: Date;
  updated_at: Date;
  cleared_operation_id?: string;
  handoff_operation_id?: string;
  handoff?: {
    stop_generation?: number;
    reason?: VmPersonalFallbackReason;
    stop_requested_at?: string;
    remote_vm?: PersonalVmRemoteHandoff;
  };
}

const logger = getLogger("compute:funding:personal-handoff");
let fallbackCursor = "00000000-0000-0000-0000-000000000000";
let handoffCursor = "00000000-0000-0000-0000-000000000000";
let closedConsentCursor = "00000000-0000-0000-0000-000000000000";

export async function fallbackDecision(
  consent: Pick<ConsentRow, "terms">,
  vm: ComputeVmRow,
): Promise<ComputeVmFallbackDecision | undefined> {
  const course = vm.metadata?.billing?.course_funding;
  const stop = course?.stop_intent;
  if (
    consent.terms.activation !== "fallback" ||
    course?.source?.kind !== "course" ||
    course.funding_epoch !== consent.terms.expected_funding_version ||
    !stop?.requested_at ||
    stop.stop_generation !== vm.stop_generation ||
    vm.state !== "stopped" ||
    vm.desired_state !== "stopped" ||
    !vm.stopped_at ||
    vm.deleted_at ||
    vm.error ||
    (vm.stop_at && vm.stop_at.valueOf() <= Date.now()) ||
    (vm.expires_at && vm.expires_at.valueOf() <= Date.now())
  )
    return;
  return await (
    await payerApi(course.binding.payer_account_id)
  ).getComputeVmFallbackDecision({
    account_id: course.binding.payer_account_id,
    binding: course.binding,
  });
}

export async function reviewedFallbackStillApplies(
  db: PoolClient,
  consent: Pick<ConsentRow, "terms" | "review" | "handoff">,
  vm: ComputeVmRow,
  decision?: ComputeVmFallbackDecision,
): Promise<boolean> {
  const course = vm.metadata?.billing?.course_funding;
  const stop = course?.stop_intent;
  if (
    !decision?.reason ||
    !consent.terms.fallback_reasons.includes(decision.reason) ||
    !Number.isFinite(Date.parse(decision.as_of)) ||
    Date.parse(decision.as_of) < Date.now() - 5_000 ||
    Date.parse(decision.as_of) > Date.now() + 1_000 ||
    decision.funding_epoch !== course?.funding_epoch ||
    decision.reservation_id !== course?.binding?.reservation_id ||
    decision.resource_generation !== vm.instance_generation ||
    !stop?.requested_at ||
    stop.stop_generation !== vm.stop_generation ||
    (consent.handoff?.stop_requested_at &&
      consent.handoff.stop_requested_at !== stop.requested_at) ||
    vm.state !== "stopped" ||
    vm.desired_state !== "stopped" ||
    vm.deleted_at ||
    vm.error ||
    (vm.stop_at && vm.stop_at.valueOf() <= Date.now())
  )
    return false;
  const { rows } = await db.query(
    `SELECT 1 FROM compute_resource_events WHERE resource_id=$1
    AND actor_kind<>'worker' AND action IN ('stop','delete') AND status='requested' AND created_at>=$2 LIMIT 1`,
    [vm.id, stop.requested_at],
  );
  if (rows.length) return false;
  const review = await reviewVm(vm, consent.terms, db);
  return (
    consent.review.resource_generation === review.resource_generation &&
    toDecimal(consent.review.hourly_usd).eq(review.hourly_usd) &&
    toDecimal(consent.review.egress_cap_usd).eq(review.egress_cap_usd) &&
    sameHomeVolumeReview(consent.review, review)
  );
}

/** Existing personal-funding maintenance runs this after local deadline work
 * stops compute. No exception or missing observation is treated as a reason.
 */
async function prepareAutomaticVmPersonalFallbacks(): Promise<void> {
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN compute_vms v ON v.id=c.vm_id
    WHERE c.id>$2 AND c.state='approved' AND c.terms->>'activation'='fallback' AND v.owning_bay_id=$1
      AND EXISTS (SELECT 1 FROM ${billingAccountsTable()} a
        WHERE a.account_id=c.payer_account_id AND a.deleted IS NOT TRUE
          ${isBillingAuthorityEnabled() ? "" : "AND a.home_bay_id=$1"})
      AND v.state='stopped' AND v.desired_state='stopped' AND v.metadata#>'{billing,course_funding,stop_intent}' IS NOT NULL
    ORDER BY c.id LIMIT 20`,
    [getConfiguredBayId(), fallbackCursor],
  );
  fallbackCursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const pending of rows) {
    try {
      const decision = await fallbackDecision(
        pending,
        await ownedVm(pending.payer_account_id, pending.vm_id),
      );
      if (!decision?.reason) continue;
      await withFundingAccountTransaction(
        pending.payer_account_id,
        async (db) => {
          const vm = await ownedVm(pending.payer_account_id, pending.vm_id, db);
          const {
            rows: [consent],
          } = await db.query<ConsentRow>(
            "SELECT * FROM compute_vm_personal_consents WHERE id=$1 FOR UPDATE",
            [pending.id],
          );
          if (
            !consent ||
            consent.state !== "approved" ||
            consent.version !== pending.version ||
            !(await reviewedFallbackStillApplies(db, consent, vm, decision))
          )
            return;
          await db.query(
            `UPDATE compute_vm_personal_consents SET state='preparing',version=version+1,
          handoff_operation_id=$2,handoff=$3,updated_at=clock_timestamp() WHERE id=$1`,
            [
              consent.id,
              randomUUID(),
              {
                reason: decision.reason,
                stop_generation: vm.stop_generation,
                stop_requested_at:
                  vm.metadata.billing.course_funding.stop_intent.requested_at,
              },
            ],
          );
        },
      );
    } catch (err) {
      logger.warn("automatic personal fallback remains inactive", {
        consent_id: pending.id,
        err,
      });
    }
  }
}

export function personalVmConsentView(
  row: ConsentRow,
): VmPersonalFundingConsent {
  const expired =
    row.state === "pending"
      ? row.approval_expires_at.valueOf() <= Date.now()
      : new Date(row.terms.ends_at).valueOf() <= Date.now();
  return {
    id: row.id,
    version: row.version,
    terms: row.terms,
    state:
      expired && ["pending", "approved"].includes(row.state)
        ? "expired"
        : row.state === "active" && row.handoff?.remote_vm?.state === "pending"
          ? "preparing"
          : row.state,
    spent_usd: row.spent_usd,
    committed_usd: row.committed_usd,
    remaining_usd: moneyToDbString(
      toDecimal(row.terms.cap_usd)
        .minus(row.spent_usd)
        .minus(row.committed_usd),
    ),
    approval_url:
      row.state === "pending" && !expired ? row.approval_url : undefined,
    approval_expires_at: row.approval_expires_at.toISOString(),
    activated_at: row.activated_at?.toISOString(),
    as_of: row.updated_at.toISOString(),
  };
}
const view = personalVmConsentView;

export async function ownedVm(
  payer: string,
  id: string,
  db?: PoolClient,
): Promise<ComputeVmRow> {
  fundingId(payer, "Account");
  fundingId(id, "VM");
  // Volume deletion/attachment locks volume before VM. Use that same order
  // before changing a multi-resource funding agreement.
  let homeId: string | null | undefined;
  if (db) {
    const {
      rows: [snapshot],
    } = await db.query<ComputeVmRow>(
      "SELECT * FROM compute_vms WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3",
      [id, payer, getConfiguredBayId()],
    );
    homeId = snapshot?.home_volume_id;
    if (homeId)
      await db.query("SELECT id FROM compute_volumes WHERE id=$1 FOR UPDATE", [
        homeId,
      ]);
  }
  const {
    rows: [vm],
  } = await (db ?? getPool()).query<ComputeVmRow>(
    `SELECT * FROM compute_vms WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3 ${db ? "FOR UPDATE" : ""}`,
    [id, payer, getConfiguredBayId()],
  );
  if (!vm) fundingConflict("VM funding requires its owner on the owning bay.");
  if (db && (vm.home_volume_id ?? null) !== (homeId ?? null))
    fundingConflict("Home volume changed; retry the funding operation.");
  return vm;
}

function normalize(terms: VmPersonalFundingTerms): VmPersonalFundingTerms {
  const { kind: _kind, ...normalized } = normalizePersonalVmApprovalTerms({
    ...terms,
    kind: "personalVMfallback",
  });
  return normalized;
}

export async function reviewedHomeVolume(
  vm: ComputeVmRow,
  terms: VmPersonalFundingTerms,
  db?: PoolClient,
): Promise<ComputeVolumeRow | undefined> {
  if (!vm.home_volume_id && !terms.home_volume_ids.length) return;
  if (
    terms.home_volume_ids.length !== 1 ||
    terms.home_volume_ids[0] !== vm.home_volume_id
  )
    fundingConflict(
      "Include the attached home volume in the personal funding review.",
    );
  const {
    rows: [volume],
  } = await (db ?? getPool()).query<ComputeVolumeRow>(
    "SELECT * FROM compute_volumes WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3",
    [vm.home_volume_id, vm.owner_account_id, vm.owning_bay_id],
  );
  if (
    !volume ||
    volume.deleted_at ||
    volume.desired_state !== "ready" ||
    !volume.ready_at ||
    volume.attached_vm_id !== vm.id ||
    volume.desired_size_gb !== volume.size_gb ||
    volume.state !== "ready" ||
    volume.attachment_state !== "attached" ||
    (volume.metadata.billing.course_funding?.growth ?? []).some(
      (s) => !s.started_at,
    )
  )
    fundingConflict(
      "Home volume is changing or unavailable; wait for storage work and review again.",
    );
  const funding = volume.metadata.billing.course_funding;
  const binding = funding?.binding;
  if (binding?.source.kind !== "course") {
    if (
      !["account-prepaid", "account-postpaid"].includes(volume.funding_mode) ||
      (funding != null && !binding) ||
      (binding &&
        (binding.source.kind !== "personal" ||
          binding.payer_account_id !== vm.owner_account_id ||
          volume.funding_mode !== `account-${binding.lane}`))
    )
      fundingConflict(
        "Home volume funding is unknown; review its independent agreement first.",
      );
    return volume;
  }
  const vmSource = vm.metadata.billing.course_funding.binding.source;
  if (
    terms.activation === "fallback" &&
    (vmSource.kind !== "course" ||
      binding.source.pool_id !== vmSource.pool_id ||
      binding.source.grant_id !== vmSource.grant_id)
  )
    fundingConflict(
      "Automatic fallback requires the VM and home disk to use the same course allowance. Use an immediate reviewed switch for separate sources.",
    );
  return volume;
}

export function sameHomeVolumeReview(
  a: PersonalVmApprovalReview,
  b: PersonalVmApprovalReview,
): boolean {
  const identity = (review: PersonalVmApprovalReview) =>
    (review.home_volumes ?? []).map(
      ({
        id,
        funding_epoch,
        resource_generation,
        attachment_generation,
        size_gb,
        hourly_usd,
        funding_action,
        funding_mode,
        storage_delete_at,
      }) => ({
        id,
        funding_epoch,
        resource_generation,
        attachment_generation,
        size_gb,
        hourly_usd,
        funding_action: funding_action ?? "switch",
        funding_mode,
        storage_delete_at:
          funding_action === "preserve" ? storage_delete_at : undefined,
      }),
    );
  return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
}

export async function reviewVm(
  vm: ComputeVmRow,
  terms: VmPersonalFundingTerms,
  db?: PoolClient,
): Promise<PersonalVmApprovalReview> {
  const binding = vm.metadata?.billing?.course_funding?.binding;
  if (
    !binding ||
    vm.deleted_at ||
    vm.desired_state === "deleted" ||
    binding.funding_epoch !== terms.expected_funding_version
  )
    fundingConflict(
      "VM funding changed; refresh the personal funding proposal.",
    );
  const volume = await reviewedHomeVolume(vm, terms, db);
  const end = new Date(terms.ends_at);
  const now = new Date();
  if (end <= now || (vm.expires_at && end > vm.expires_at))
    fundingConflict(
      "Personal funding must end within the VM deletion deadline.",
    );
  const running =
    vm.metadata.billing.running_rates?.[vm.effective_pricing_model];
  const storage = vm.metadata.billing.stopped_rate;
  const quote = quoteVmFundingAdmission(
    {
      hourly_cost_usd: running?.hourly_cost_usd,
      storage_hourly_cost_usd: storage?.hourly_cost_usd,
      requested_until: new Date(now.valueOf() + 25 * 60_000).toISOString(),
      requested_stop_at: new Date(
        Math.min(
          vm.stop_at?.valueOf() ?? Infinity,
          end.valueOf() - VM_FUNDING_MARGIN_MS,
        ),
      ).toISOString(),
      requested_delete_at: vm.expires_at?.toISOString(),
    },
    now,
  );
  const egress =
    vm.provider === "gcp"
      ? (process.env.COCALC_COURSE_VM_EGRESS_RESERVE_USD ?? "1.00")
      : "0";
  const changeVolumeFunding =
    volume?.metadata.billing.course_funding?.binding?.source.kind === "course";
  const volumeQuote =
    volume && changeVolumeFunding
      ? quoteVmFundingAdmission(
          {
            hourly_cost_usd: volume.metadata.billing.rate.hourly_cost_usd,
            storage_hourly_cost_usd:
              volume.metadata.billing.rate.hourly_cost_usd,
            requested_until: new Date(
              now.valueOf() + 25 * 60_000,
            ).toISOString(),
            requested_stop_at: new Date(
              end.valueOf() - VM_FUNDING_MARGIN_MS,
            ).toISOString(),
          },
          now,
        )
      : undefined;
  if (
    toDecimal(quote.authorized_usd)
      .plus(egress)
      .plus(volumeQuote?.authorized_usd ?? 0)
      .gt(terms.cap_usd)
  )
    fundingConflict(
      "Personal cap cannot cover the initial service and protected storage.",
    );
  return {
    vm_id: vm.id,
    vm_name: vm.name,
    owner_account_id: vm.owner_account_id,
    owning_bay_id: vm.owning_bay_id,
    resource_generation: vm.instance_generation,
    funding_epoch: binding.funding_epoch,
    hourly_usd: running.hourly_cost_usd,
    protected_storage_usd: moneyToDbString(
      toDecimal(quote.protected_usd).plus(volumeQuote?.protected_usd ?? 0),
    ),
    egress_cap_usd: egress,
    storage_delete_at: new Date(
      Math.min(
        end.valueOf() + VM_FUNDING_STORAGE_MS,
        vm.expires_at?.valueOf() ?? Infinity,
      ),
    ).toISOString(),
    provider: vm.provider,
    stopped_hourly_usd: storage.hourly_cost_usd,
    stop_generation: vm.stop_generation ?? 0,
    ...(vm.stop_at ? { stop_at: vm.stop_at.toISOString() } : {}),
    ...(vm.expires_at ? { expires_at: vm.expires_at.toISOString() } : {}),
    home_volumes: volume
      ? [
          {
            id: volume.id,
            name: volume.name,
            funding_action: changeVolumeFunding ? "switch" : "preserve",
            ...(!changeVolumeFunding
              ? { funding_mode: volume.funding_mode }
              : {}),
            ...(volume.metadata.billing.course_funding?.binding
              ? {
                  funding_epoch:
                    volume.metadata.billing.course_funding.binding
                      .funding_epoch,
                  resource_generation:
                    volume.metadata.billing.course_funding.binding
                      .resource_generation,
                }
              : {}),
            attachment_generation: volume.attachment_generation,
            size_gb: volume.size_gb,
            hourly_usd: volume.metadata.billing.rate.hourly_cost_usd,
            ...(changeVolumeFunding
              ? {
                  storage_delete_at: new Date(
                    end.valueOf() + VM_FUNDING_STORAGE_MS,
                  ).toISOString(),
                }
              : volume.metadata.billing.course_funding?.binding
                    ?.storage_delete_at
                ? {
                    storage_delete_at:
                      volume.metadata.billing.course_funding.binding
                        .storage_delete_at,
                  }
                : {}),
          },
        ]
      : [],
  };
}

export async function previewPersonalVmFunding(
  account: string,
  input: VmPersonalFundingTerms,
): Promise<VmPersonalFundingPreview> {
  await assertFundingPayerHomeBay(account);
  const terms = normalize(input);
  const review = await resolvePersonalVmReview(account, terms);
  const policy = await withFundingAccountTransaction(account, (db) =>
    getComputeFundingPolicyInTransaction(db, {
      payer_account_id: account,
      lane: terms.lane,
    }),
  );
  return {
    terms,
    hourly_usd: review.hourly_usd,
    protected_storage_usd: review.protected_storage_usd,
    egress_cap_usd: review.egress_cap_usd,
    available_usd: policy.available_backing_usd,
    home_volumes: review.home_volumes,
    as_of: new Date().toISOString(),
  };
}

let registered = false;
export async function reviewPersonalVmFundingOnBay(
  payer: string,
  input: VmPersonalFundingTerms,
): Promise<PersonalVmApprovalReview> {
  const terms = normalize(input);
  return reviewVm(await ownedVm(payer, terms.vm_id), terms);
}

async function resolvePersonalVmReview(
  payer: string,
  terms: VmPersonalFundingTerms,
): Promise<PersonalVmApprovalReview> {
  const result = await resolvePersonalResourceReview({
    account_id: payer,
    kind: "vm",
    terms,
  });
  if (result.kind !== "vm") throw Error("VM review unavailable.");
  return result.review;
}

export function initVmPersonalFundingApprovalHandler(): void {
  if (registered) return;
  registerVmPersonalFundingApprovalHandler({
    resolveReview: async ({ payer_account_id, terms }) =>
      resolvePersonalVmReview(payer_account_id, normalize(terms)),
    apply: async ({ db, payer_account_id, intent_id, terms, review }) => {
      // Approval records consent, not service. Remote resource changes are
      // fenced at handoff; no inter-bay call may run under this account lock.
      const current =
        review.owning_bay_id === getConfiguredBayId()
          ? await reviewVm(
              await ownedVm(payer_account_id, terms.vm_id, db),
              normalize(terms),
              db,
            )
          : review;
      if (
        current.resource_generation !== review.resource_generation ||
        current.hourly_usd !== review.hourly_usd ||
        !sameHomeVolumeReview(current, review)
      )
        fundingConflict(
          "VM quote changed; create a new personal funding intent.",
        );
      await getComputeFundingPolicyInTransaction(db, {
        payer_account_id,
        lane: terms.lane,
      });
      const { rows } = await db.query(
        `UPDATE compute_vm_personal_consents SET state='approved',review=$5::jsonb,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND payer_account_id=$2 AND vm_id=$3 AND terms=$4::jsonb AND state='pending' RETURNING id`,
        [
          intent_id,
          payer_account_id,
          terms.vm_id,
          JSON.stringify(normalize(terms)),
          JSON.stringify(review),
        ],
      );
      if (rows.length !== 1)
        fundingConflict("Personal funding intent was cancelled or changed.");
      return { consent_id: intent_id };
    },
  });
  registered = true;
}

type ApiOpts<K extends keyof VmPersonalFundingApi> = Parameters<
  VmPersonalFundingApi[K]
>[0] & { account_id?: string };
function account(opts: { account_id?: string }): string {
  return fundingId(opts.account_id ?? "", "Account");
}

export async function previewVmPersonalFunding(
  opts: ApiOpts<"previewVmPersonalFunding">,
) {
  return previewPersonalVmFunding(account(opts), opts.terms);
}

export async function proposeVmPersonalFunding(
  opts: ApiOpts<"proposeVmPersonalFunding">,
): Promise<VmPersonalFundingConsent> {
  const payer = account(opts);
  const preview = await previewPersonalVmFunding(payer, opts.terms);
  initVmPersonalFundingApprovalHandler();
  const intent = await proposeVmPersonalFundingApproval({
    payer_account_id: payer,
    operation_id: fundingId(opts.operation_id, "Operation"),
    terms: preview.terms,
  });
  const review = await resolvePersonalVmReview(payer, preview.terms);
  return withFundingAccountTransaction(payer, async (db) => {
    const {
      rows: [row],
    } = await db.query<ConsentRow>(
      `INSERT INTO compute_vm_personal_consents
    (id,payer_account_id,vm_id,operation_id,terms,review,state,approval_url,approval_expires_at)
    VALUES ($1,$2,$3,$4,$5,$6,'pending',$7,$8) ON CONFLICT (payer_account_id,operation_id) DO UPDATE SET operation_id=EXCLUDED.operation_id RETURNING *`,
      [
        intent.intent_id,
        payer,
        preview.terms.vm_id,
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

export async function getVmPersonalFunding(
  opts: ApiOpts<"getVmPersonalFunding">,
): Promise<VmPersonalFundingConsent | null> {
  const payer = account(opts);
  await assertFundingPayerHomeBay(payer);
  fundingId(opts.vm_id, "VM");
  const {
    rows: [row],
  } = await getPool().query<ConsentRow>(
    `SELECT * FROM compute_vm_personal_consents
    WHERE payer_account_id=$1 AND vm_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
    [payer, opts.vm_id],
  );
  return row ? view(row) : null;
}

export async function clearVmPersonalFunding(
  opts: ApiOpts<"clearVmPersonalFunding">,
): Promise<VmPersonalFundingConsent> {
  const payer = account(opts);
  await assertFundingPayerHomeBay(payer);
  fundingId(opts.operation_id, "Operation");
  fundingId(opts.consent_id, "Consent");
  fundingId(opts.vm_id, "VM");
  return withFundingAccountTransaction(payer, async (db) => {
    // Consent follows the payer on rehome; the VM stays at its owning bay.
    // Preserve the immediate local stop without making withdrawal depend on
    // resource locality. A remote meter sees the authoritative cancellation
    // and refuses further service; existing cleanup liabilities remain held.
    const { rows: local } = await db.query(
      "SELECT id FROM compute_vms WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3",
      [opts.vm_id, payer, getConfiguredBayId()],
    );
    const vm = local.length ? await ownedVm(payer, opts.vm_id, db) : undefined;
    const {
      rows: [row],
    } = await db.query<ConsentRow>(
      "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND vm_id=$3 FOR UPDATE",
      [opts.consent_id, payer, opts.vm_id],
    );
    if (!row) fundingConflict("Personal funding consent not found.");
    if (row.cleared_operation_id === opts.operation_id) return view(row);
    if (row.version !== opts.expected_version)
      fundingConflict("Personal funding consent changed.");
    if (vm && ["active", "preparing"].includes(row.state))
      await enqueuePersonalTransition(
        db,
        row.vm_id,
        "stop",
        vm.metadata.billing.course_funding.funding_epoch,
        opts.operation_id,
      );
    const {
      rows: [updated],
    } = await db.query<ConsentRow>(
      `UPDATE compute_vm_personal_consents SET state='cancelled',version=version+1,cleared_operation_id=$2,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [row.id, opts.operation_id],
    );
    return view(updated);
  });
}

export async function switchVmPersonalFunding(
  opts: ApiOpts<"switchVmPersonalFunding">,
): Promise<VmPersonalFundingConsent> {
  const payer = account(opts);
  await assertFundingPayerHomeBay(payer);
  fundingId(opts.operation_id, "Operation");
  fundingId(opts.consent_id, "Consent");
  const remote = await (
    await import("./vm-personal-remote")
  ).switchRemotePersonalVm(payer, opts);
  if (remote) return remote;
  return withFundingAccountTransaction(payer, async (db) => {
    const vm = await ownedVm(payer, opts.vm_id, db);
    const {
      rows: [consent],
    } = await db.query<ConsentRow>(
      "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND vm_id=$3 FOR UPDATE",
      [opts.consent_id, payer, vm.id],
    );
    if (consent?.handoff_operation_id === opts.operation_id)
      return view(consent);
    if (
      !consent ||
      consent.version !== opts.expected_version ||
      consent.state !== "approved" ||
      consent.terms.activation !== "immediate" ||
      consent.terms.expected_funding_version !== opts.expected_funding_version
    )
      fundingConflict(
        "An unchanged, isolated-approved immediate personal consent is required.",
      );
    const review = await reviewVm(vm, consent.terms, db);
    if (!sameHomeVolumeReview(consent.review, review))
      fundingConflict(
        "Home volume quote changed; create a new personal funding intent.",
      );
    await enqueuePersonalTransition(
      db,
      vm.id,
      "stop",
      vm.metadata.billing.course_funding.funding_epoch,
      opts.operation_id,
    );
    const {
      rows: [row],
    } = await db.query<ConsentRow>(
      "UPDATE compute_vm_personal_consents SET state='preparing',version=version+1,handoff_operation_id=$2,handoff=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [consent.id, opts.operation_id, { stop_generation: vm.stop_generation }],
    );
    return view(row);
  });
}

/** Owning-bay reconciliation. No account lock or DB transaction spans provider work. */
export async function processVmPersonalFundingHandoffs(): Promise<void> {
  if (
    isBillingAuthorityEnabled() &&
    getConfiguredBayId() !== getConfiguredClusterSeedBayId()
  ) {
    return;
  }
  await (await import("./personal-expiry")).expirePersonalFundingConsents();
  await (
    await import("./vm-personal-remote")
  ).processRemotePersonalVmHandoffs();
  await (await import("./volume-personal")).closeEndedVolumePersonalConsents();
  await closeEndedPersonalConsents();
  await prepareAutomaticVmPersonalFallbacks();
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN compute_vms v ON v.id=c.vm_id
    WHERE c.id>$2 AND c.state='preparing' AND v.owning_bay_id=$1 AND v.state='stopped' AND v.desired_state='stopped'
      AND EXISTS (SELECT 1 FROM ${billingAccountsTable()} a
        WHERE a.account_id=c.payer_account_id AND a.deleted IS NOT TRUE
          ${isBillingAuthorityEnabled() ? "" : "AND a.home_bay_id=$1"})
    ORDER BY c.id LIMIT 20`,
    [getConfiguredBayId(), handoffCursor],
  );
  handoffCursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const pending of rows) {
    try {
      await assertFundingPayerHomeBay(pending.payer_account_id);
      const decision =
        pending.terms.activation === "fallback"
          ? await fallbackDecision(
              pending,
              await ownedVm(pending.payer_account_id, pending.vm_id),
            )
          : undefined;
      const exposureBudget =
        await loadFundingExposureBudget(getConfiguredBayId());
      const handoff = () =>
        withFundingAccountTransaction(pending.payer_account_id, async (db) => {
          const vm = await ownedVm(pending.payer_account_id, pending.vm_id, db);
          const {
            rows: [consent],
          } = await db.query<ConsentRow>(
            "SELECT * FROM compute_vm_personal_consents WHERE id=$1 FOR UPDATE",
            [pending.id],
          );
          if (
            consent.state !== "preparing" ||
            consent.version !== pending.version
          )
            return;
          if (
            consent.terms.activation === "fallback" &&
            !(await reviewedFallbackStillApplies(db, consent, vm, decision))
          )
            return;
          if (
            vm.state !== "stopped" ||
            vm.desired_state !== "stopped" ||
            !vm.stopped_at ||
            vm.stop_generation !== consent.handoff?.stop_generation
          )
            return;
          const review = await reviewVm(vm, consent.terms, db);
          if (!sameHomeVolumeReview(consent.review, review))
            fundingConflict(
              "Home volume quote changed; create a new personal funding intent.",
            );
          const oldEgress = vm.metadata.billing.egress ?? {};
          // Do not move a GCP run until the measured watermark covers its confirmed stop.
          if (
            vm.provider === "gcp" &&
            (!oldEgress.metered_through_at ||
              new Date(oldEgress.metered_through_at) < vm.stopped_at)
          )
            return;
          const cutover = new Date();
          const until = new Date(
            Math.min(
              cutover.valueOf() + 25 * 60_000,
              new Date(consent.terms.ends_at).valueOf(),
              vm.expires_at?.valueOf() ?? Infinity,
              vm.stop_at ? vm.stop_at.valueOf() + 5 * 60_000 : Infinity,
            ),
          );
          const binding = await reservePersonalVmInTransaction(
            db,
            vm,
            consent.id,
            until,
            exposureBudget,
          );
          const volume = await reviewedHomeVolume(vm, consent.terms, db);
          let home: Parameters<typeof installPersonalVmFunding>[5];
          if (
            volume?.metadata.billing.course_funding?.binding?.source.kind ===
            "course"
          ) {
            const volumeUntil = new Date(
              Math.min(
                cutover.valueOf() + 25 * 60_000,
                new Date(consent.terms.ends_at).valueOf(),
              ),
            );
            const successor = await reservePersonalVolumeInTransaction(
              db,
              vm,
              volume,
              consent.id,
              randomUUID(),
              volumeUntil,
              exposureBudget,
              cutover,
            );
            home = { volume, binding: successor };
          }
          await installPersonalVmFunding(
            db,
            vm,
            binding,
            consent.handoff_operation_id!,
            cutover,
            home,
          );
          await db.query(
            "UPDATE compute_vm_personal_consents SET state='active',version=version+1,activated_at=$2,updated_at=clock_timestamp() WHERE id=$1",
            [consent.id, cutover],
          );
        });
      await withFundingResourceMeterLock(
        "vm",
        pending.vm_id,
        async () => {
          const volumeId = pending.terms.home_volume_ids[0];
          if (volumeId) {
            await withFundingResourceMeterLock("volume", volumeId, handoff, {
              retryContention: true,
            });
          } else {
            await handoff();
          }
        },
        { retryContention: true },
      );
    } catch (err) {
      if (
        !isBillingAuthorityEnabled() &&
        (err as { code?: unknown })?.code === "funding_home_bay_required"
      ) {
        continue;
      }
      logger.warn("personal funding handoff remains pending", {
        consent_id: pending.id,
        err,
      });
    }
  }
}

/** End future authority without releasing any unsettled resource obligation. */
async function closeEndedPersonalConsents(): Promise<void> {
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN compute_vms v ON v.id=c.vm_id
    WHERE c.id>$2 AND v.owning_bay_id=$1 AND c.state IN ('pending','approved','preparing','active')
      AND EXISTS (SELECT 1 FROM ${billingAccountsTable()} a
        WHERE a.account_id=c.payer_account_id AND a.deleted IS NOT TRUE
          ${isBillingAuthorityEnabled() ? "" : "AND a.home_bay_id=$1"})
      AND (v.desired_state='deleted' OR v.deleted_at IS NOT NULL OR (c.terms->>'ends_at')::timestamptz<=clock_timestamp())
    ORDER BY c.id LIMIT 20`,
    [getConfiguredBayId(), closedConsentCursor],
  );
  closedConsentCursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const consent of rows) {
    try {
      await assertFundingPayerHomeBay(consent.payer_account_id);
      await withFundingAccountTransaction(
        consent.payer_account_id,
        async (db) => {
          const vm = await ownedVm(consent.payer_account_id, consent.vm_id, db);
          const { rows: retainedVolumes } = await db.query(
            `SELECT id FROM compute_volumes WHERE owner_account_id=$1 AND owning_bay_id=$2 AND deleted_at IS NULL AND desired_state='ready'
              AND metadata#>>'{billing,course_funding,source,kind}'='personal'
              AND metadata#>>'{billing,course_funding,source,consent_id}'=$3 LIMIT 1`,
            [consent.payer_account_id, getConfiguredBayId(), consent.id],
          );
          await db.query(
            `UPDATE compute_vm_personal_consents SET state=CASE WHEN $3 THEN 'cancelled' ELSE 'expired' END,
          version=version+1,updated_at=clock_timestamp()
          WHERE id=$1 AND version=$2 AND state IN ('pending','approved','preparing','active')
            AND ($3 OR (terms->>'ends_at')::timestamptz<=clock_timestamp())`,
            [
              consent.id,
              consent.version,
              (vm.desired_state === "deleted" || vm.deleted_at != null) &&
                !retainedVolumes.length,
            ],
          );
        },
      );
    } catch (err) {
      if (
        !isBillingAuthorityEnabled() &&
        (err as { code?: unknown })?.code === "funding_home_bay_required"
      ) {
        continue;
      }
      logger.warn("ended personal consent remains pending", {
        consent_id: consent.id,
        err,
      });
    }
  }
}
