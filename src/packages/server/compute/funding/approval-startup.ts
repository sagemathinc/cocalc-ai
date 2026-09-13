/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import type { Server } from "node:http";
import { getLogger } from "@cocalc/backend/logger";
import {
  COURSE_COMPUTE_RETENTION_HOURS,
  normalizeCourseFundingDraft,
} from "@cocalc/util/compute-funding";
import type { CourseFundingDraft } from "@cocalc/util/compute-funding";
import { fundingApprovalConfigFromEnv } from "./approval-config";
import { initFundingRolloutVerifiers } from "./rollout-startup";
import {
  createCourseFundingApprovals,
  ensureCourseFundingApprovalSchema,
  registerCourseFundingApprovalService,
} from "./approvals";
import type { ApplyFundingIntent, FinancialApprovalResult } from "./approvals";
import { prepareFundingApprovalRecipients } from "./approval-recipients";
import { withFundingAccountTransaction } from "./backing";
import type { CourseFundingApprovalTerms } from "./approval-review";
import { resolveCourseFundingReview } from "./approval-review";
import { startCourseFundingApprovalServer } from "./approval-server";
import { createCourseFundingPoolInTransaction } from "./pools";
import {
  normalizeCourseFundingPoolChangeDraft,
  changeCourseFundingPoolInTransaction,
} from "./pool-changes";
import type { CourseFundingPoolChangeDraft } from "@cocalc/conat/hub/api/compute-funding";
import { enqueueCourseFundingReceiptInTransaction } from "./receipts";
import {
  getVmPersonalFundingApprovalHandler,
  normalizePersonalVmApprovalTerms,
  validatePersonalVmApprovalReview,
} from "./approval-personal";
import type { PersonalVmApprovalTerms } from "./approval-personal";
import {
  normalizeTransferApprovalTerms,
  prepareTransferApproval,
  registerTransferApprovals,
} from "./approval-transfer";
import type { CreditTransferApprovalTerms } from "./approval-transfer";
import { prepareSponsorshipApproval } from "./approval-sponsorship";
import { normalizePersonalVolumeApprovalTerms } from "./approval-volume-personal";
import type { PersonalVolumeApprovalTerms } from "./approval-volume-personal";
import { normalizeMonthlyCollectionTerms } from "@cocalc/util/monthly-collection";
import type { MonthlyCollectionTerms } from "@cocalc/util/monthly-collection";
import {
  applyMonthlyCollection,
  reviewMonthlyCollection,
} from "@cocalc/server/purchases/monthly-collection";

const logger = getLogger("compute:funding:approval-startup");
let starting: Promise<void> | undefined;
let server: Server | undefined;
let unregister: (() => void) | undefined;
let unregisterTransfers: (() => void) | undefined;

export function initCourseFundingApprovalService({
  listen = true,
}: { listen?: boolean } = {}): Promise<void> {
  if (starting) return starting;
  initFundingRolloutVerifiers();
  const config = fundingApprovalConfigFromEnv();
  if (!config) return Promise.resolve();
  starting = (async () => {
    await ensureCourseFundingApprovalSchema();
    const apply = async (
      {
        db,
        payer_account_id,
        operation_id,
        intent_id,
        terms,
        review,
      }: ApplyFundingIntent<CourseFundingApprovalTerms>,
      home_bay_by_account_id?: Record<string, string>,
    ): Promise<FinancialApprovalResult> => {
      if (review.storage_retention_hours !== COURSE_COMPUTE_RETENTION_HOURS) {
        throw new Error("Storage policy changed; create a new funding intent");
      }
      if ("kind" in terms) {
        if (terms.kind === "monthlyCollection")
          return applyMonthlyCollection(db, payer_account_id, terms, intent_id);
        if (terms.kind === "personalVolumeFunding") {
          if (!review.personal_volume)
            throw Error("Personal storage review unavailable.");
          return (
            await import("./volume-personal")
          ).approvePersonalVolumeFunding({
            db,
            payer_account_id,
            intent_id,
            terms,
            review: review.personal_volume,
          });
        }
        if (terms.kind === "creditTransfer")
          throw new Error(
            "Transfer approval requires sorted transaction preflight",
          );
        if (!review.personal_vm_fallback)
          throw new Error("Personal VM review unavailable");
        return await getVmPersonalFundingApprovalHandler().apply({
          db,
          payer_account_id,
          operation_id,
          intent_id,
          terms,
          review: validatePersonalVmApprovalReview(
            payer_account_id,
            terms,
            review.personal_vm_fallback,
          ),
        });
      }
      if (!home_bay_by_account_id)
        throw new Error("Course funding requires current recipient checks");
      if ("action" in terms) {
        return await changeCourseFundingPoolInTransaction(db, {
          payer_account_id,
          operation_id,
          terms,
          home_bay_by_account_id,
        });
      }
      const allocation = await createCourseFundingPoolInTransaction(db, {
        payer_account_id,
        operation_id,
        terms,
      });
      await enqueueCourseFundingReceiptInTransaction(db, {
        payer_account_id,
        operation_id,
        action: "allocated",
        pool: allocation.pool,
        grants: allocation.grants,
        home_bay_by_account_id,
      });
      return { pool_id: allocation.pool.id };
    };
    const approvals = createCourseFundingApprovals<
      CourseFundingApprovalTerms,
      FinancialApprovalResult
    >({
      approval_origin: config.origin,
      validateTerms: (input: unknown) =>
        input != null && typeof input === "object" && "kind" in input
          ? input.kind === "monthlyCollection"
            ? normalizeMonthlyCollectionTerms(input as MonthlyCollectionTerms)
            : input.kind === "creditTransfer"
              ? normalizeTransferApprovalTerms(
                  input as CreditTransferApprovalTerms,
                )
              : input.kind === "personalVolumeFunding"
                ? normalizePersonalVolumeApprovalTerms(
                    input as PersonalVolumeApprovalTerms,
                  )
                : normalizePersonalVmApprovalTerms(
                    input as PersonalVmApprovalTerms,
                  )
          : input != null && typeof input === "object" && "action" in input
            ? normalizeCourseFundingPoolChangeDraft(
                input as CourseFundingPoolChangeDraft,
              )
            : normalizeCourseFundingDraft(input as CourseFundingDraft),
      resolveReview: resolveCourseFundingReview,
      apply,
      prepare: async (intent) => {
        if (
          "kind" in intent.terms &&
          intent.terms.kind === "monthlyCollection"
        ) {
          await reviewMonthlyCollection(intent.payer_account_id, intent.terms);
          return {
            withTransaction: (fn) =>
              withFundingAccountTransaction(intent.payer_account_id, fn),
            apply,
          };
        }
        const transfer = await prepareTransferApproval(intent);
        if (transfer || "kind" in intent.terms) return transfer;
        const sponsorship = await prepareSponsorshipApproval(
          intent.payer_account_id,
          intent.terms,
        );
        // Reductions/closure must remain available to a payer after sanctions.
        const check = await prepareFundingApprovalRecipients(
          intent.review,
          !("action" in intent.terms) ||
            intent.review.pool_change?.requires_course_access !== false,
        );
        return {
          withTransaction: (fn) =>
            withFundingAccountTransaction(intent.payer_account_id, fn),
          apply: async (locked) => {
            await sponsorship(locked.db);
            return await apply(locked, await check(locked.db));
          },
        };
      },
    });
    if (listen)
      server = await startCourseFundingApprovalServer({ approvals, config });
    unregister = registerCourseFundingApprovalService(approvals);
    unregisterTransfers = registerTransferApprovals(approvals);
    server?.once("close", () => {
      unregisterTransfers?.();
      unregisterTransfers = undefined;
      unregister?.();
      unregister = undefined;
    });
    logger.info("trusted financial approval configured", {
      origin: config.origin,
      listen,
    });
  })().catch(async (error) => {
    starting = undefined;
    unregisterTransfers?.();
    unregisterTransfers = undefined;
    unregister?.();
    unregister = undefined;
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    throw error;
  });
  return starting;
}

export async function stopCourseFundingApprovalService(): Promise<void> {
  await starting;
  unregister?.();
  unregister = undefined;
  unregisterTransfers?.();
  unregisterTransfers = undefined;
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((err) => (err ? reject(err) : resolve())),
    );
  server = undefined;
  starting = undefined;
}
