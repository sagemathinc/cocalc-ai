/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import type {
  PersonalVmHandoffIdentity,
  PersonalVmHandoffRequest,
  PersonalVmHandoffResult,
  PersonalVmRemoteHandoff,
} from "@cocalc/util/compute-personal-funding-review";
import type {
  VmPersonalFundingApi,
  VmPersonalFundingConsent,
} from "@cocalc/util/compute-vm-funding";
import { fundingId } from "@cocalc/util/compute-funding";
import { toDecimal } from "@cocalc/util/money";
import { withFundingAccountTransaction } from "./backing";
import { assertFundingPayerHomeBay } from "./approvals";
import { fundingConflict } from "./vm-reservations";
import { loadFundingExposureBudget } from "./exposure";
import {
  reservePersonalVmInTransaction,
  reserveUndispatchedPersonalVolumeInTransaction,
} from "./vm-personal-reservations";
import type { PersonalVmReservationInput } from "./vm-personal-reservations";
import type { ConsentRow } from "./vm-personal";
import { personalVmConsentView } from "./vm-personal";
import { settleComputeVmFundingLocal } from "./vm-settlement";

type Switch = Parameters<VmPersonalFundingApi["switchVmPersonalFunding"]>[0];
const logger = getLogger("compute:funding:remote-personal-vm");
let cursor = "00000000-0000-0000-0000-000000000000";

function identity(row: ConsentRow): PersonalVmHandoffIdentity {
  return {
    account_id: row.payer_account_id,
    consent_id: row.id,
    operation_id: row.handoff_operation_id ?? row.id,
    terms: row.terms,
    review: row.review,
  };
}
async function callResource(request: PersonalVmHandoffRequest) {
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: request.review.owning_bay_id,
    timeout: 5_000,
  }).computeFundingPersonalVmHandoff(request);
}

export async function switchRemotePersonalVm(
  payer: string,
  opts: Switch,
): Promise<VmPersonalFundingConsent | undefined> {
  const {
    rows: [snapshot],
  } = await getPool().query<ConsentRow>(
    "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND vm_id=$3",
    [fundingId(opts.consent_id, "Consent"), payer, fundingId(opts.vm_id, "VM")],
  );
  if (
    !snapshot ||
    !snapshot.review.owning_bay_id ||
    (snapshot.review.owning_bay_id === getConfiguredBayId() &&
      !snapshot.handoff?.remote_vm)
  )
    return;
  const row = await withFundingAccountTransaction(payer, async (db) => {
    const {
      rows: [consent],
    } = await db.query<ConsentRow>(
      "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND vm_id=$3 FOR UPDATE",
      [snapshot.id, payer, opts.vm_id],
    );
    if (consent?.handoff_operation_id === opts.operation_id) return consent;
    if (
      !consent ||
      consent.state !== "approved" ||
      consent.version !== opts.expected_version ||
      consent.terms.activation !== "immediate" ||
      consent.terms.expected_funding_version !== opts.expected_funding_version
    )
      fundingConflict(
        "An unchanged, isolated-approved immediate personal consent is required.",
      );
    const command = { ...identity(consent), operation_id: opts.operation_id };
    const {
      rows: [pending],
    } = await db.query<ConsentRow>(
      "UPDATE compute_vm_personal_consents SET state='preparing',version=version+1,handoff_operation_id=$2,handoff=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *",
      [
        consent.id,
        opts.operation_id,
        { remote_vm: { identity: command, state: "pending" } },
      ],
    );
    return pending;
  });
  await reconcileRemoteVm(row);
  const {
    rows: [current],
  } = await getPool().query<ConsentRow>(
    "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2",
    [row.id, payer],
  );
  return personalVmConsentView(current);
}

async function reserveRemoteVm(
  row: ConsentRow,
  ready: Extract<PersonalVmHandoffResult, { state: "ready" }>,
): Promise<ConsentRow> {
  const budget = await loadFundingExposureBudget(row.review.owning_bay_id);
  return withFundingAccountTransaction(row.payer_account_id, async (db) => {
    const {
      rows: [consent],
    } = await db.query<ConsentRow>(
      "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 FOR UPDATE",
      [row.id, row.payer_account_id],
    );
    if (
      !consent ||
      consent.handoff?.remote_vm?.binding ||
      !["approved", "preparing"].includes(consent.state)
    )
      return consent;
    if (
      consent.version !== row.version ||
      !Number.isFinite(Date.parse(ready.as_of)) ||
      Date.parse(ready.as_of) < Date.now() - 5_000 ||
      Date.parse(ready.as_of) > Date.now() + 1_000 ||
      !Number.isFinite(Date.parse(ready.stopped_at)) ||
      ready.stop_generation !== consent.review.stop_generation ||
      (consent.terms.activation === "fallback" &&
        (!ready.reason ||
          !consent.terms.fallback_reasons.includes(ready.reason))) ||
      (consent.terms.activation === "immediate" &&
        consent.state !== "preparing")
    )
      fundingConflict(
        "Personal VM handoff readiness changed; retry its review.",
      );
    const review = consent.review;
    if (!review.provider || review.stopped_hourly_usd == null)
      fundingConflict(
        "Create a new personal VM approval with current resource pricing.",
      );
    const vm: PersonalVmReservationInput = {
      id: consent.vm_id,
      owner_account_id: consent.payer_account_id,
      owning_bay_id: review.owning_bay_id,
      provider: review.provider,
      instance_generation: review.resource_generation,
      stop_at: review.stop_at ? new Date(review.stop_at) : null,
      expires_at: review.expires_at ? new Date(review.expires_at) : null,
      effective_pricing_model: "on_demand",
      metadata: {
        billing: {
          running_rates: {
            on_demand: {
              hourly_cost_usd: review.hourly_usd,
              pricing_snapshot: {
                provider: review.provider,
                personal_approval_id: consent.id,
              },
            },
          },
          stopped_rate: { hourly_cost_usd: review.stopped_hourly_usd },
        },
      },
    };
    const until = new Date(
      Math.min(
        Date.now() + 25 * 60_000,
        Date.parse(consent.terms.ends_at),
        vm.expires_at?.valueOf() ?? Infinity,
        vm.stop_at ? vm.stop_at.valueOf() + 5 * 60_000 : Infinity,
      ),
    );
    await db.query(
      "UPDATE compute_vm_personal_consents SET state='preparing' WHERE id=$1",
      [consent.id],
    );
    const binding = await reservePersonalVmInTransaction(
      db,
      vm,
      consent.id,
      until,
      budget,
    );
    if (!toDecimal(binding.egress_usd).eq(review.egress_cap_usd))
      fundingConflict("VM egress policy changed; request a new approval.");
    const command: PersonalVmRemoteHandoff = {
      identity: identity(consent),
      state: "pending",
      binding,
    };
    const home = review.home_volumes.find(
      (v) => v.funding_action !== "preserve",
    );
    if (home) {
      command.home_binding =
        await reserveUndispatchedPersonalVolumeInTransaction(
          db,
          {
            id: home.id,
            owner_account_id: consent.payer_account_id,
            owning_bay_id: review.owning_bay_id,
            provider: review.provider,
            metadata: {
              billing: {
                rate: {
                  hourly_cost_usd: home.hourly_usd,
                  pricing_snapshot: {
                    provider: review.provider,
                    personal_approval_id: consent.id,
                  },
                },
                course_funding: {
                  binding: { resource_generation: home.resource_generation },
                },
              },
            },
          },
          consent.id,
          randomUUID(),
          new Date(
            Math.min(
              Date.now() + 25 * 60_000,
              Date.parse(consent.terms.ends_at),
            ),
          ),
          budget,
          vm,
        );
    }
    const {
      rows: [updated],
    } = await db.query<ConsentRow>(
      `UPDATE compute_vm_personal_consents SET state='active',version=version+1,handoff_operation_id=$2,handoff=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
      [consent.id, command.identity.operation_id, { remote_vm: command }],
    );
    return updated;
  });
}

async function finishRemoteVm(
  row: ConsentRow,
  result: PersonalVmHandoffResult,
): Promise<void> {
  if (result.state !== "committed" && result.state !== "aborted") return;
  if (!Number.isFinite(Date.parse(result.as_of)))
    fundingConflict("Invalid VM handoff receipt.");
  const handoff = row.handoff?.remote_vm ?? {
    identity: identity(row),
    state: "pending" as const,
  };
  const bindings = [handoff.binding, handoff.home_binding].filter(
    (b) => b != null,
  );
  if (result.state === "committed") {
    const expected = bindings.map((b) => b.reservation_id).sort();
    if (
      !expected.length ||
      JSON.stringify(expected) !==
        JSON.stringify([...result.reservation_ids].sort())
    )
      fundingConflict("VM handoff receipt has different reservations.");
  } else {
    for (const binding of bindings)
      await settleComputeVmFundingLocal({
        account_id: row.payer_account_id,
        binding,
        running_until: result.as_of,
        meter_as_of: result.as_of,
        deleted: true,
        public_egress_bytes: 0,
        egress_finalized: true,
        egress_complete_through: result.as_of,
      });
  }
  await withFundingAccountTransaction(row.payer_account_id, async (db) => {
    await db.query(
      `UPDATE compute_vm_personal_consents SET handoff=$3,handoff_operation_id=$4,
        state=CASE WHEN state IN ('approved','preparing','active') AND $5='aborted' THEN 'rejected' ELSE state END,
        activated_at=CASE WHEN $5='committed' THEN $6::timestamptz ELSE activated_at END,version=version+1,updated_at=clock_timestamp()
        WHERE id=$1 AND payer_account_id=$2 AND (handoff_operation_id IS NULL OR handoff_operation_id=$4)
          AND COALESCE(handoff#>>'{remote_vm,state}','pending')='pending' AND version=$7`,
      [
        row.id,
        row.payer_account_id,
        { remote_vm: { ...handoff, state: result.state, receipt: result } },
        handoff.identity.operation_id,
        result.state,
        result.as_of,
        row.version,
      ],
    );
  });
}

async function reconcileRemoteVm(initial: ConsentRow): Promise<void> {
  await assertFundingPayerHomeBay(initial.payer_account_id);
  if (
    initial.handoff?.remote_vm?.state &&
    initial.handoff.remote_vm.state !== "pending"
  )
    return;
  let row = initial;
  let handoff = row.handoff?.remote_vm;
  const command = handoff?.identity ?? identity(row);
  const ended = (consent: ConsentRow) =>
    !["approved", "preparing", "active"].includes(consent.state) ||
    Date.parse(consent.terms.ends_at) <= Date.now() ||
    (consent.handoff?.remote_vm?.binding &&
      Date.parse(consent.handoff.remote_vm.binding.stop_at) <= Date.now());
  if (!ended(row) && !handoff?.binding) {
    const prepared = await callResource({ ...command, phase: "prepare" });
    if (prepared.state === "waiting") return;
    if (prepared.state !== "ready") {
      await finishRemoteVm(row, prepared);
      return;
    }
    row = await reserveRemoteVm(row, prepared);
    if (!row) return;
    handoff = row.handoff?.remote_vm;
  }
  const result = await callResource(
    ended(row) || !handoff?.binding
      ? { ...command, phase: "abort" }
      : {
          ...command,
          phase: "commit",
          binding: handoff.binding,
          home_binding: handoff.home_binding,
        },
  );
  await finishRemoteVm(row, result);
}

/** Payer-home coordinator; commands and reservations follow financial rehome. */
export async function processRemotePersonalVmHandoffs(): Promise<void> {
  const { rows } = await getPool().query<ConsentRow>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN accounts a ON a.account_id=c.payer_account_id
      WHERE c.id>$1 AND COALESCE(a.home_bay_id,$2)=$2 AND c.vm_id IS NOT NULL AND
      (c.handoff#>>'{remote_vm,state}'='pending' OR
        (c.review->>'owning_bay_id'<>$2 AND (c.state='preparing' OR (c.state='approved' AND c.terms->>'activation'='fallback'))))
      ORDER BY c.id LIMIT 20`,
    [cursor, getConfiguredBayId()],
  );
  cursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      await reconcileRemoteVm(row);
    } catch (err) {
      logger.warn("remote VM handoff awaits reconciliation", {
        consent_id: row.id,
        err,
      });
    }
  }
}
