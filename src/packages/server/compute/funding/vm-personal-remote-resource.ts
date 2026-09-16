/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type {
  PersonalVmApprovalReview,
  PersonalVmHandoffIdentity,
  PersonalVmHandoffRequest,
  PersonalVmHandoffResult,
} from "@cocalc/util/compute-personal-funding-review";
import type { ComputeVmFundingBinding } from "@cocalc/util/compute-vm-funding";
import { fundingId } from "@cocalc/util/compute-funding";
import { toDecimal } from "@cocalc/util/money";
import type { ComputeVmRow } from "../types";
import { canonicalFundingTerms } from "./approvals";
import {
  normalizePersonalVmApprovalTerms,
  validatePersonalVmApprovalReview,
} from "./approval-personal";
import {
  fallbackDecision,
  reviewedFallbackStillApplies,
  ownedVm,
  reviewVm,
  reviewedHomeVolume,
  sameHomeVolumeReview,
} from "./vm-personal";
import { payerApi, requireSponsoredVmAdmission } from "./vm-funding";
import { fundingConflict } from "./vm-reservations";
import { withFundingResourceMeterLock } from "./resource-meter-lock";
import {
  enqueuePersonalTransition,
  installPersonalVmFunding,
} from "./vm-personal-cutover";

interface Journal {
  identity_hash: string;
  stop_generation?: number;
  stop_requested_at?: string;
  result?: PersonalVmHandoffResult;
}

export function samePersonalVmReview(
  a: PersonalVmApprovalReview,
  b: PersonalVmApprovalReview,
): boolean {
  return (
    [
      "vm_id",
      "owner_account_id",
      "owning_bay_id",
      "resource_generation",
      "funding_epoch",
      "provider",
      "stop_at",
      "expires_at",
      "stop_generation",
    ].every((key) => a[key] === b[key]) &&
    toDecimal(a.hourly_usd).eq(b.hourly_usd) &&
    toDecimal(a.egress_cap_usd).eq(b.egress_cap_usd) &&
    a.stopped_hourly_usd != null &&
    b.stopped_hourly_usd != null &&
    toDecimal(a.stopped_hourly_usd).eq(b.stopped_hourly_usd) &&
    sameHomeVolumeReview(a, b)
  );
}

const terminal = (result?: PersonalVmHandoffResult) =>
  result?.state === "committed" || result?.state === "aborted";

/** Private owning-bay protocol. Stopping is durable before funding is prepared;
 * only a checked payer reservation can reach the atomic restart cutover. */
export async function processPersonalVmHandoffOnBay(
  request: PersonalVmHandoffRequest,
): Promise<PersonalVmHandoffResult> {
  const { account_id, consent_id, operation_id, terms, review } = request;
  fundingId(account_id, "Account");
  fundingId(consent_id, "Consent");
  fundingId(operation_id, "Operation");
  validatePersonalVmApprovalReview(
    account_id,
    normalizePersonalVmApprovalTerms({ ...terms, kind: "personalVMfallback" }),
    review,
  );
  if (
    review.owning_bay_id !== getConfiguredBayId() ||
    !["prepare", "commit", "abort"].includes(request.phase)
  )
    fundingConflict("VM handoff is not on its owning bay.");
  const identity: PersonalVmHandoffIdentity = {
    account_id,
    consent_id,
    operation_id,
    terms,
    review,
  };
  const hash = createHash("sha256")
    .update(canonicalFundingTerms(identity))
    .digest("hex");
  const key = `personal-vm-handoff:${consent_id}:${operation_id}`;
  const read = async (
    db: Pick<PoolClient, "query">,
  ): Promise<Journal | undefined> => {
    const {
      rows: [row],
    } = await db.query(
      "SELECT payload FROM compute_resource_work WHERE id=$1",
      [consent_id],
    );
    if (!row) return;
    if (row.payload?.identity_hash !== hash)
      fundingConflict("VM handoff retry changed its terms.");
    return row.payload;
  };
  const existing = await read(getPool());
  if (terminal(existing?.result)) return existing!.result!;
  const {
    rows: [snapshot],
  } = await getPool().query<ComputeVmRow>(
    "SELECT * FROM compute_vms WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3",
    [terms.vm_id, account_id, getConfiguredBayId()],
  );
  const decision =
    snapshot && terms.activation === "fallback" && request.phase !== "abort"
      ? await fallbackDecision({ terms }, snapshot)
      : undefined;
  let binding: ComputeVmFundingBinding | undefined;
  let homeBinding: ComputeVmFundingBinding | undefined;
  if (request.phase === "commit") {
    const candidates = [
      request.binding,
      ...(request.home_binding ? [request.home_binding] : []),
    ];
    const switched = review.home_volumes.filter(
      (v) => v.funding_action !== "preserve",
    );
    if (
      candidates.length !== 1 + switched.length ||
      request.binding.reservation_id !== consent_id
    )
      fundingConflict("VM handoff reservation set changed.");
    const api = await payerApi(account_id);
    await requireSponsoredVmAdmission();
    for (const candidate of candidates) {
      const vmBinding = candidate === request.binding;
      const resourceId = vmBinding ? terms.vm_id : switched[0]?.id;
      const generation = vmBinding
        ? review.resource_generation
        : switched[0]?.resource_generation;
      if (
        candidate.source.kind !== "personal" ||
        candidate.source.consent_id !== consent_id ||
        candidate.resource_id !== resourceId ||
        candidate.resource_generation !== generation! + 1 ||
        (candidate.resource_kind ?? "compute-vm") !==
          (vmBinding ? "compute-vm" : "compute-volume") ||
        candidate.owner_account_id !== account_id ||
        candidate.payer_account_id !== account_id ||
        candidate.owning_bay_id !== getConfiguredBayId() ||
        candidate.lane !== terms.lane
      )
        fundingConflict("VM handoff funding authority changed.");
      const confirmed = await api.checkComputeVmFunding({
        account_id,
        binding: candidate,
        dispatch: true,
      });
      if (vmBinding) binding = confirmed;
      else homeBinding = confirmed;
    }
  }
  const apply = async (): Promise<PersonalVmHandoffResult> => {
    const db = await getPool().connect();
    try {
      await db.query("BEGIN");
      // The normal helper locks home disk before VM, matching attachment and deletion.
      const vm = snapshot
        ? await ownedVm(account_id, terms.vm_id, db)
        : undefined;
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const prior = await read(db);
      if (terminal(prior?.result)) {
        await db.query("COMMIT");
        return prior!.result!;
      }
      const journal: Journal = prior ?? { identity_hash: hash };
      const save = async (result?: PersonalVmHandoffResult) => {
        journal.result = result;
        await db.query(
          `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
           VALUES ($1,'vm',$2,'personal_funding_handoff',$3,$4,'done',0,clock_timestamp(),clock_timestamp(),clock_timestamp())
           ON CONFLICT (id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=clock_timestamp()`,
          [consent_id, terms.vm_id, key, journal],
        );
        await db.query("COMMIT");
        return result ?? { state: "waiting" as const };
      };
      const abort = () =>
        save({
          state: "aborted",
          as_of: new Date().toISOString(),
          reservation_ids: [],
        });
      if (
        request.phase === "abort" ||
        (request.phase === "commit" && prior?.stop_generation == null) ||
        !vm ||
        vm.deleted_at ||
        vm.desired_state === "deleted" ||
        vm.error ||
        Date.parse(terms.ends_at) <= Date.now() ||
        (vm.stop_at && vm.stop_at.valueOf() <= Date.now()) ||
        (vm.expires_at && vm.expires_at.valueOf() <= Date.now())
      )
        return await abort();
      let unchanged = false;
      try {
        unchanged = samePersonalVmReview(review, await reviewVm(vm, terms, db));
      } catch {
        /* A resource no longer matching approval cannot be restarted. */
      }
      if (
        !unchanged ||
        (journal.stop_generation != null &&
          (vm.stop_generation ?? 0) !== journal.stop_generation)
      )
        return await abort();
      if (terms.activation === "fallback") {
        if (
          !(await reviewedFallbackStillApplies(
            db,
            {
              terms,
              review,
              handoff: {
                stop_generation: journal.stop_generation ?? vm.stop_generation,
                stop_requested_at: journal.stop_requested_at,
              },
            },
            vm,
            decision,
          ))
        ) {
          // Before a financial stop there is no permission to activate fallback.
          await db.query("COMMIT");
          return { state: "waiting" };
        }
        journal.stop_requested_at ??=
          vm.metadata.billing.course_funding.stop_intent.requested_at;
      }
      if (journal.stop_generation == null) {
        journal.stop_generation = vm.stop_generation ?? 0;
        if (terms.activation === "immediate")
          await enqueuePersonalTransition(
            db,
            vm.id,
            "stop",
            review.funding_epoch,
            operation_id,
          );
      }
      if (
        vm.state !== "stopped" ||
        vm.desired_state !== "stopped" ||
        !vm.stopped_at ||
        (vm.provider === "gcp" &&
          (!vm.metadata.billing.egress?.metered_through_at ||
            new Date(vm.metadata.billing.egress.metered_through_at) <
              vm.stopped_at))
      )
        return await save();
      if (request.phase === "prepare")
        return await save({
          state: "ready",
          stop_generation: vm.stop_generation ?? 0,
          stopped_at: vm.stopped_at.toISOString(),
          reason: decision?.reason ?? undefined,
          as_of: new Date().toISOString(),
        });
      if (
        !binding ||
        Date.parse(binding.stop_at) <= Date.now() ||
        (homeBinding && Date.parse(homeBinding.stop_at) <= Date.now())
      )
        return await abort();
      const volume = await reviewedHomeVolume(vm, terms, db);
      const cutover = new Date();
      await installPersonalVmFunding(
        db,
        vm,
        binding,
        operation_id,
        cutover,
        volume && homeBinding ? { volume, binding: homeBinding } : undefined,
      );
      return await save({
        state: "committed",
        as_of: cutover.toISOString(),
        reservation_ids: [
          binding.reservation_id,
          ...(homeBinding ? [homeBinding.reservation_id] : []),
        ],
      });
    } catch (err) {
      await db.query("ROLLBACK");
      throw err;
    } finally {
      db.release();
    }
  };
  const result = await withFundingResourceMeterLock(
    "vm",
    terms.vm_id,
    async () => {
      const volumeId = terms.home_volume_ids[0];
      return volumeId
        ? await withFundingResourceMeterLock("volume", volumeId, apply, {
            retryContention: true,
          })
        : await apply();
    },
    { retryContention: true },
  );
  if (!result)
    fundingConflict("Resource metering is busy; retry this same handoff.");
  return result;
}
