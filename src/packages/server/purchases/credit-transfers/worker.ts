/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import type { CreditTransferManifest } from "@cocalc/util/credit-transfers";
import { reconcileCreditTransfer } from "./core";
import { creditTransferTransport } from "./api";

const logger = getLogger("purchases:credit-transfers");

/** Continue committed deliveries even when NEW transfers are disabled. Duplicate
 * workers are harmless: the receiver fence and sender settlement are idempotent.
 */
export async function getPendingCreditTransferManifests(): Promise<
  CreditTransferManifest[]
> {
  const { rows } = await getPool().query<{ manifest: CreditTransferManifest }>(
    `SELECT t.manifest FROM credit_transfers t
     JOIN accounts a ON a.account_id=t.sender_account_id
     JOIN account_funding_authorities f ON f.payer_account_id=t.sender_account_id
     WHERE t.state='pending' AND f.state='active' AND f.home_bay_id=$1
       AND COALESCE(NULLIF(BTRIM(a.home_bay_id),''),$1)=$1
     ORDER BY t.updated_at LIMIT 100`,
    [getConfiguredBayId()],
  );
  return rows.map(({ manifest }) => manifest);
}

export default async function maintainCreditTransfers(): Promise<void> {
  for (const manifest of await getPendingCreditTransferManifests()) {
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
