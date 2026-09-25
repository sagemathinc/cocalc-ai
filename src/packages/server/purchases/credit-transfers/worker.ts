/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import type { CreditTransferManifest } from "@cocalc/util/credit-transfers";
import { reconcileCreditTransfer } from "./core";
import { creditTransferTransport } from "./api";
import { billingAccountsTable } from "../billing-account";

const logger = getLogger("purchases:credit-transfers");

/** Continue committed deliveries even when NEW transfers are disabled. Duplicate
 * workers are harmless: the receiver fence and sender settlement are idempotent.
 */
export async function getPendingCreditTransferManifests(
  limit = 100,
): Promise<CreditTransferManifest[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw Error("Invalid transfer reconciliation limit");
  const accountTable = billingAccountsTable();
  const { rows } = await getPool().query<{ manifest: CreditTransferManifest }>(
    `SELECT t.manifest FROM credit_transfers t
     JOIN ${accountTable} a ON a.account_id=t.sender_account_id
     JOIN account_funding_authorities f ON f.payer_account_id=t.sender_account_id
     WHERE t.state='pending' AND f.state='active'
       AND a.deleted IS NOT TRUE AND a.banned IS NOT TRUE
     ORDER BY t.updated_at LIMIT $1`,
    [limit],
  );
  return rows.map(({ manifest }) => manifest);
}

export default async function maintainCreditTransfers({
  limit = 100,
}: { limit?: number } = {}): Promise<void> {
  for (const manifest of await getPendingCreditTransferManifests(limit)) {
    try {
      await reconcileCreditTransfer(manifest, creditTransferTransport);
    } catch (error) {
      logger.warn("Credit transfer delivery remains pending", {
        transfer_id: manifest.transfer_id,
        error,
      });
      // No timeout compensation. Rotate failures so one unreachable bay does not
      // starve every other destination on subsequent maintenance passes.
      await getPool().query(
        "UPDATE credit_transfers SET updated_at=now() WHERE transfer_id=$1 AND state='pending'",
        [manifest.transfer_id],
      );
    }
  }
}
