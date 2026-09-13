/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
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
import type { ComputeVmRow } from "../types";
import { insertComputeInstance } from "../db";
import { randomUUID } from "node:crypto";
import { getLogger } from "@cocalc/backend/logger";
import { payerApi } from "./vm-funding";
import { reservePersonalVmInTransaction } from "./vm-personal-reservations";
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
import { getComputeFundingPolicyInTransaction } from "./policy";
import { loadFundingExposureBudget } from "./exposure";
import {
  quoteVmFundingAdmission,
  fundingConflict,
  VM_FUNDING_STORAGE_MS,
  VM_FUNDING_MARGIN_MS,
} from "./vm-reservations";

interface ConsentRow {
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
    stop_generation: number;
    reason?: VmPersonalFallbackReason;
    stop_requested_at?: string;
  };
}

const logger = getLogger("compute:funding:personal-handoff");
let fallbackCursor = "00000000-0000-0000-0000-000000000000";
let handoffCursor = "00000000-0000-0000-0000-000000000000";

async function fallbackDecision(
  consent: ConsentRow,
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
    vm.home_volume_id ||
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

async function reviewedFallbackStillApplies(
  db: PoolClient,
  consent: ConsentRow,
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
  const review = reviewVm(vm, consent.terms);
  return (
    consent.review.resource_generation === review.resource_generation &&
    toDecimal(consent.review.hourly_usd).eq(review.hourly_usd) &&
    toDecimal(consent.review.egress_cap_usd).eq(review.egress_cap_usd)
  );
}

/** Existing personal-funding maintenance runs this after local deadline work
 * stops compute. No exception or missing observation is treated as a reason.
 */
async function prepareAutomaticVmPersonalFallbacks(): Promise<void> {
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN compute_vms v ON v.id=c.vm_id
    WHERE c.id>$2 AND c.state='approved' AND c.terms->>'activation'='fallback' AND v.owning_bay_id=$1
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

function view(row: ConsentRow): VmPersonalFundingConsent {
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

async function ownedVm(
  payer: string,
  id: string,
  db?: PoolClient,
): Promise<ComputeVmRow> {
  fundingId(payer, "Account");
  fundingId(id, "VM");
  const {
    rows: [vm],
  } = await (db ?? getPool()).query<ComputeVmRow>(
    `SELECT * FROM compute_vms WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3 ${db ? "FOR UPDATE" : ""}`,
    [id, payer, getConfiguredBayId()],
  );
  if (!vm) fundingConflict("VM funding requires its owner on the owning bay.");
  return vm;
}

function normalize(terms: VmPersonalFundingTerms): VmPersonalFundingTerms {
  const { kind: _kind, ...normalized } = normalizePersonalVmApprovalTerms({
    ...terms,
    kind: "personalVMfallback",
  });
  return normalized;
}

function reviewVm(
  vm: ComputeVmRow,
  terms: VmPersonalFundingTerms,
): PersonalVmApprovalReview {
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
  if (terms.home_volume_ids.length || vm.home_volume_id)
    fundingConflict("Personal home-volume handoff is not yet available.");
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
  if (toDecimal(quote.authorized_usd).plus(egress).gt(terms.cap_usd))
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
    protected_storage_usd: quote.protected_usd,
    egress_cap_usd: egress,
    storage_delete_at: new Date(
      Math.min(
        end.valueOf() + VM_FUNDING_STORAGE_MS,
        vm.expires_at?.valueOf() ?? Infinity,
      ),
    ).toISOString(),
    home_volumes: [],
  };
}

export async function previewPersonalVmFunding(
  account: string,
  input: VmPersonalFundingTerms,
): Promise<VmPersonalFundingPreview> {
  await assertFundingPayerHomeBay(account);
  const terms = normalize(input);
  const review = reviewVm(await ownedVm(account, terms.vm_id), terms);
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
    as_of: new Date().toISOString(),
  };
}

let registered = false;
export function initVmPersonalFundingApprovalHandler(): void {
  if (registered) return;
  registerVmPersonalFundingApprovalHandler({
    resolveReview: async ({ payer_account_id, terms }) =>
      reviewVm(await ownedVm(payer_account_id, terms.vm_id), normalize(terms)),
    apply: async ({ db, payer_account_id, intent_id, terms, review }) => {
      const current = reviewVm(
        await ownedVm(payer_account_id, terms.vm_id, db),
        normalize(terms),
      );
      if (
        current.resource_generation !== review.resource_generation ||
        current.hourly_usd !== review.hourly_usd
      )
        fundingConflict(
          "VM quote changed; create a new personal funding intent.",
        );
      await getComputeFundingPolicyInTransaction(db, {
        payer_account_id,
        lane: terms.lane,
      });
      const { rows } = await db.query(
        `UPDATE compute_vm_personal_consents SET state='approved',version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND payer_account_id=$2 AND state='pending' RETURNING id`,
        [intent_id, payer_account_id],
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
  const review = reviewVm(
    await ownedVm(payer, preview.terms.vm_id),
    preview.terms,
  );
  const {
    rows: [row],
  } = await getPool().query<ConsentRow>(
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
}

export async function getVmPersonalFunding(
  opts: ApiOpts<"getVmPersonalFunding">,
): Promise<VmPersonalFundingConsent | null> {
  const payer = account(opts);
  await assertFundingPayerHomeBay(payer);
  await ownedVm(payer, opts.vm_id);
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
  return withFundingAccountTransaction(payer, async (db) => {
    const vm = await ownedVm(payer, opts.vm_id, db);
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
    if (["active", "preparing"].includes(row.state))
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
    reviewVm(vm, consent.terms);
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

async function enqueuePersonalTransition(
  db: PoolClient,
  vmId: string,
  action: "stop" | "start",
  epoch: string,
  operation: string,
): Promise<void> {
  await db.query(
    `UPDATE compute_vms SET desired_state=$2,state=CASE WHEN state='stopped' AND $2='stopped' THEN state ELSE $3 END,updated_at=clock_timestamp() WHERE id=$1 AND desired_state<>'deleted'`,
    [
      vmId,
      action === "stop" ? "stopped" : "running",
      action === "stop" ? "stopping" : "starting",
    ],
  );
  await db.query(
    `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
    VALUES ($1,'vm',$2,$3,$4,$5,'queued',0,NOW(),NOW(),NOW())`,
    [
      randomUUID(),
      vmId,
      action,
      `personal-${action}:${operation}`,
      { funding_epoch: epoch },
    ],
  );
}

/** Owning-bay reconciliation. No account lock or DB transaction spans provider work. */
export async function processVmPersonalFundingHandoffs(): Promise<void> {
  await prepareAutomaticVmPersonalFallbacks();
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN compute_vms v ON v.id=c.vm_id
    WHERE c.id>$2 AND c.state='preparing' AND v.owning_bay_id=$1 AND v.state='stopped' AND v.desired_state='stopped' ORDER BY c.id LIMIT 20`,
    [getConfiguredBayId(), handoffCursor],
  );
  handoffCursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const pending of rows) {
    try {
      const decision =
        pending.terms.activation === "fallback"
          ? await fallbackDecision(
              pending,
              await ownedVm(pending.payer_account_id, pending.vm_id),
            )
          : undefined;
      const exposureBudget =
        await loadFundingExposureBudget(getConfiguredBayId());
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
          reviewVm(vm, consent.terms);
          const old = vm.metadata.billing.course_funding;
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
          const history = [
            ...(old.history ?? []),
            {
              binding: old.binding,
              running_until: vm.stopped_at.toISOString(),
              transferred_at: cutover.toISOString(),
              successor_reservation_id: binding.reservation_id,
              successor_binding: binding,
              egress: oldEgress,
            },
          ];
          const course = {
            source: binding.source,
            funding_epoch: binding.funding_epoch,
            binding,
            history,
          };
          await db.query(
            `UPDATE compute_vms SET instance_generation=$2,stopped_at=NULL,accrued_cost=0,funding_mode=$3,
        metadata=jsonb_set(jsonb_set(jsonb_set(jsonb_set(metadata,'{billing,course_funding}',$4::jsonb),'{billing,egress}',$5::jsonb),'{billing,funding_mode}',to_jsonb($3::text)),'{provider_generation_provisioning}','true'::jsonb),updated_at=clock_timestamp()
        WHERE id=$1`,
            [
              vm.id,
              binding.resource_generation,
              binding.lane === "prepaid"
                ? "account-prepaid"
                : "account-postpaid",
              JSON.stringify(course),
              JSON.stringify({
                total_bytes: 0,
                metered_through_at: cutover.toISOString(),
                finalized: false,
              }),
            ],
          );
          await db.query(
            "UPDATE compute_vm_personal_consents SET state='active',version=version+1,activated_at=$2,updated_at=clock_timestamp() WHERE id=$1",
            [consent.id, cutover],
          );
          // GCP can restart its retained instance without entering provision().
          // Persist the new metering generation before queuing provider work.
          await insertComputeInstance(
            { ...vm, instance_generation: binding.resource_generation },
            db,
          );
          await enqueuePersonalTransition(
            db,
            vm.id,
            "start",
            binding.funding_epoch,
            consent.handoff_operation_id!,
          );
        },
      );
    } catch (err) {
      logger.warn("personal funding handoff remains pending", {
        consent_id: pending.id,
        err,
      });
    }
  }
}
