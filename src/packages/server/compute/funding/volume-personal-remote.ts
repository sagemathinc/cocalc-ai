/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { createHash } from "node:crypto";
import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { fundingId } from "@cocalc/util/compute-funding";
import type {
  ApplyPersonalVolumeHandoffRequest,
  PersonalVolumeHandoffReceipt,
} from "@cocalc/util/compute-personal-funding-review";
import type {
  VolumePersonalFundingApi,
  VolumePersonalFundingConsent,
} from "@cocalc/util/compute-volume-personal-funding";
import type { ComputeVolumeRow } from "../types";
import { canonicalFundingTerms } from "./approvals";
import { withFundingAccountTransaction } from "./backing";
import { loadFundingExposureBudget } from "./exposure";
import { reserveUndispatchedPersonalVolumeInTransaction } from "./vm-personal-reservations";
import { fundingConflict } from "./vm-reservations";
import { payerApi, requireSponsoredVmAdmission } from "./vm-funding";
import { withFundingResourceMeterLock } from "./resource-meter-lock";
import { settleComputeVmFundingLocal } from "./vm-settlement";
import {
  applyPersonalVolumeBinding,
  personalVolumeConsentView,
  reviewPersonalVolumeFunding,
  reviewPersonalVolumeRow,
  samePersonalVolumeReview,
} from "./volume-personal";
import type { PersonalVolumeConsentRow } from "./volume-personal";

type Handoff = {
  request: ApplyPersonalVolumeHandoffRequest;
  state: "pending" | "committed" | "aborted";
  receipt?: PersonalVolumeHandoffReceipt;
};
type Row = PersonalVolumeConsentRow & { handoff?: { remote_volume?: Handoff } };
type Switch = Parameters<
  VolumePersonalFundingApi["switchVolumePersonalFunding"]
>[0];
const logger = getLogger("compute:funding:remote-personal-storage");
let cursor = "00000000-0000-0000-0000-000000000000";

export async function switchRemotePersonalVolume(
  payer: string,
  opts: Switch,
): Promise<VolumePersonalFundingConsent | undefined> {
  const {
    rows: [snapshot],
  } = await getPool().query<Row>(
    "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND volume_id=$3",
    [
      fundingId(opts.consent_id, "Consent"),
      payer,
      fundingId(opts.volume_id, "Volume"),
    ],
  );
  if (!snapshot || snapshot.review.owning_bay_id === getConfiguredBayId())
    return;
  if (snapshot.handoff_operation_id === opts.operation_id) {
    await reconcileRemotePersonalVolume(snapshot);
  } else {
    const review = await reviewPersonalVolumeFunding(payer, snapshot.terms);
    const budget = await loadFundingExposureBudget(review.owning_bay_id);
    const prepared = await withFundingAccountTransaction(payer, async (db) => {
      const {
        rows: [consent],
      } = await db.query<Row>(
        "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2 AND volume_id=$3 FOR UPDATE",
        [snapshot.id, payer, opts.volume_id],
      );
      if (consent?.handoff_operation_id === opts.operation_id) return consent;
      if (
        !consent ||
        consent.state !== "approved" ||
        consent.version !== opts.expected_version ||
        !samePersonalVolumeReview(consent.review, review) ||
        !["gcp", "nebius"].includes(review.provider ?? "")
      )
        fundingConflict(
          "Unchanged, separately approved storage funding is required.",
        );
      const until = new Date(
        Math.min(Date.now() + 25 * 60_000, Date.parse(consent.terms.ends_at)),
      );
      await db.query(
        "UPDATE compute_vm_personal_consents SET state='preparing' WHERE id=$1",
        [consent.id],
      );
      const binding = await reserveUndispatchedPersonalVolumeInTransaction(
        db,
        {
          id: consent.volume_id,
          owner_account_id: payer,
          owning_bay_id: review.owning_bay_id,
          provider: review.provider!,
          metadata: {
            billing: {
              rate: {
                hourly_cost_usd: review.hourly_usd,
                pricing_snapshot: {
                  provider: review.provider,
                  personal_approval_id: consent.id,
                },
              },
              course_funding: {
                binding: { resource_generation: review.resource_generation },
              },
            },
          },
        },
        consent.id,
        consent.id,
        until,
        budget,
      );
      const request: ApplyPersonalVolumeHandoffRequest = {
        account_id: payer,
        operation_id: opts.operation_id,
        consent_id: consent.id,
        terms: consent.terms,
        review: consent.review,
        binding,
      };
      const {
        rows: [updated],
      } = await db.query<Row>(
        `UPDATE compute_vm_personal_consents SET state='active',version=version+1,handoff_operation_id=$2,handoff=$3,updated_at=clock_timestamp() WHERE id=$1 RETURNING *`,
        [
          consent.id,
          opts.operation_id,
          { remote_volume: { request, state: "pending" } },
        ],
      );
      return updated;
    });
    await reconcileRemotePersonalVolume(prepared);
  }
  const {
    rows: [current],
  } = await getPool().query<Row>(
    "SELECT * FROM compute_vm_personal_consents WHERE id=$1 AND payer_account_id=$2",
    [snapshot.id, payer],
  );
  return personalVolumeConsentView(current);
}

/** The receipt is a durable owning-bay decision, not a guess based on timeout.
 * A committed cutover and an abort tombstone are mutually exclusive. */
export async function applyRemotePersonalVolumeHandoff(
  request: ApplyPersonalVolumeHandoffRequest,
): Promise<PersonalVolumeHandoffReceipt> {
  const { binding, review, terms } = request;
  fundingId(request.account_id, "Account");
  fundingId(request.operation_id, "Operation");
  fundingId(request.consent_id, "Consent");
  if (
    binding.resource_kind !== "compute-volume" ||
    binding.source.kind !== "personal" ||
    binding.source.consent_id !== request.consent_id ||
    binding.owner_account_id !== request.account_id ||
    binding.payer_account_id !== request.account_id ||
    binding.owning_bay_id !== getConfiguredBayId() ||
    review.owning_bay_id !== getConfiguredBayId() ||
    review.owner_account_id !== request.account_id ||
    binding.resource_id !== terms.volume_id ||
    review.volume_id !== terms.volume_id ||
    binding.resource_generation !== review.resource_generation + 1 ||
    binding.lane !== terms.lane ||
    review.funding_epoch !== terms.expected_funding_version
  )
    fundingConflict("Personal storage handoff authority changed.");
  const key = `personal-volume-handoff:${request.consent_id}:${request.operation_id}`;
  // Abort must use the same immutable command identity as a delayed commit.
  const { abort: _abort, ...identity } = request;
  const hash = createHash("sha256")
    .update(canonicalFundingTerms(identity))
    .digest("hex");
  const read = async (db: Pick<PoolClient, "query">) => {
    const {
      rows: [work],
    } = await db.query(
      "SELECT payload FROM compute_resource_work WHERE id=$1",
      [binding.reservation_id],
    );
    if (!work) return;
    if (work.payload?.request_hash !== hash)
      fundingConflict("Storage handoff retry changed its terms.");
    return work.payload.receipt as PersonalVolumeHandoffReceipt;
  };
  const existing = await read(getPool());
  if (existing) return existing;
  let confirmed = binding;
  if (!request.abort) {
    await requireSponsoredVmAdmission();
    confirmed = await (
      await payerApi(request.account_id)
    ).checkComputeVmFunding({
      account_id: request.account_id,
      binding,
      dispatch: true,
    });
  }
  const result = await withFundingResourceMeterLock(
    "volume",
    binding.resource_id,
    async () => {
      const db = await getPool().connect();
      try {
        await db.query("BEGIN");
        const {
          rows: [volume],
        } = await db.query<ComputeVolumeRow>(
          "SELECT * FROM compute_volumes WHERE id=$1 AND owner_account_id=$2 AND owning_bay_id=$3 FOR UPDATE",
          [binding.resource_id, request.account_id, getConfiguredBayId()],
        );
        // Serialize even when a deleted resource row no longer exists.
        await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
        const prior = await read(db);
        if (prior) {
          await db.query("COMMIT");
          return prior;
        }
        let unchanged = false;
        if (volume && !request.abort) {
          try {
            unchanged = samePersonalVolumeReview(
              review,
              reviewPersonalVolumeRow(volume, terms),
            );
          } catch {
            /* A changed resource aborts this command, never its replacement. */
          }
        }
        const cutover = new Date();
        unchanged = unchanged && cutover < new Date(confirmed.stop_at);
        const receipt: PersonalVolumeHandoffReceipt = {
          operation_id: request.operation_id,
          reservation_id: binding.reservation_id,
          outcome: unchanged ? "committed" : "aborted",
          as_of: cutover.toISOString(),
        };
        if (unchanged)
          await applyPersonalVolumeBinding(db, volume!, confirmed, cutover);
        await db.query(
          `INSERT INTO compute_resource_work (id,resource_kind,resource_id,action,idempotency_key,payload,state,attempt,not_before,created_at,updated_at)
        VALUES ($1,'volume',$2,'personal_funding_handoff',$3,$4,'done',0,clock_timestamp(),clock_timestamp(),clock_timestamp())`,
          [
            binding.reservation_id,
            binding.resource_id,
            key,
            { request_hash: hash, receipt },
          ],
        );
        await db.query("COMMIT");
        return receipt;
      } catch (err) {
        await db.query("ROLLBACK");
        throw err;
      } finally {
        db.release();
      }
    },
    { retryContention: true },
  );
  if (!result)
    fundingConflict("Storage metering is busy; retry this same request.");
  return result;
}

async function reconcileRemotePersonalVolume(row: Row): Promise<void> {
  const handoff = row.handoff?.remote_volume;
  if (!handoff || handoff.state !== "pending") return;
  const request = handoff.request;
  const abort =
    row.state !== "active" ||
    Date.parse(row.terms.ends_at) <= Date.now() ||
    Date.parse(request.binding.stop_at) <= Date.now();
  const receipt = await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: request.review.owning_bay_id,
    timeout: 5_000,
  }).computeFundingApplyPersonalVolumeHandoff({
    ...request,
    ...(abort ? { abort: true } : {}),
  });
  if (
    receipt.operation_id !== request.operation_id ||
    receipt.reservation_id !== request.binding.reservation_id ||
    !["committed", "aborted"].includes(receipt.outcome) ||
    !Number.isFinite(Date.parse(receipt.as_of))
  )
    fundingConflict("Storage handoff receipt identity changed.");
  if (receipt.outcome === "aborted") {
    // No resource interval was installed. Keep the reserve until this durable
    // owning-bay tombstone exists; late delivery cannot resurrect the command.
    await settleComputeVmFundingLocal({
      account_id: row.payer_account_id,
      binding: request.binding,
      running_until: receipt.as_of,
      meter_as_of: receipt.as_of,
      deleted: true,
      public_egress_bytes: 0,
      egress_finalized: true,
      egress_complete_through: receipt.as_of,
    });
  }
  await withFundingAccountTransaction(row.payer_account_id, async (db) => {
    await db.query(
      `UPDATE compute_vm_personal_consents SET handoff=jsonb_set(handoff,'{remote_volume}',$3::jsonb),
      state=CASE WHEN state='active' AND $4='aborted' THEN 'rejected' ELSE state END,
      activated_at=CASE WHEN $4='committed' THEN $5::timestamptz ELSE activated_at END,version=version+1,updated_at=clock_timestamp()
      WHERE id=$1 AND payer_account_id=$2 AND handoff#>>'{remote_volume,state}'='pending' AND handoff_operation_id=$6`,
      [
        row.id,
        row.payer_account_id,
        { ...handoff, state: receipt.outcome, receipt },
        receipt.outcome,
        receipt.as_of,
        request.operation_id,
      ],
    );
  });
}

/** Payer-home durable retry; financial rehome carries this pending command. */
export async function processRemotePersonalVolumeHandoffs(): Promise<void> {
  const { rows } = await getPool().query<Row>(
    `SELECT c.* FROM compute_vm_personal_consents c JOIN accounts a ON a.account_id=c.payer_account_id
      WHERE c.id>$1 AND COALESCE(a.home_bay_id,$2)=$2 AND c.handoff#>>'{remote_volume,state}'='pending' ORDER BY c.id LIMIT 20`,
    [cursor, getConfiguredBayId()],
  );
  cursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      await reconcileRemotePersonalVolume(row);
    } catch (err) {
      logger.warn("remote storage handoff awaits reconciliation", {
        consent_id: row.id,
        err,
      });
    }
  }
}
