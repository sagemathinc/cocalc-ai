/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import getPool from "@cocalc/database/pool";
import { getLogger } from "@cocalc/backend/logger";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { withFundingAccountTransaction } from "./backing";

const logger = getLogger("compute:funding:personal-expiry");
let cursor = "00000000-0000-0000-0000-000000000000";

/** Consent expiry belongs to the payer, not to the bay storing the VM/disk.
 * End future authority without releasing any existing cleanup liability. */
export async function expirePersonalFundingConsents(): Promise<void> {
  const { rows } = await getPool().query<{
    id: string;
    payer_account_id: string;
  }>(
    `SELECT c.id,c.payer_account_id FROM compute_vm_personal_consents c JOIN accounts a ON a.account_id=c.payer_account_id
     WHERE c.id>$1 AND COALESCE(a.home_bay_id,$2)=$2 AND c.state IN ('pending','approved','preparing','active')
       AND ((c.terms->>'ends_at')::timestamptz<=clock_timestamp()
         OR (c.state='pending' AND c.approval_expires_at<=clock_timestamp())) ORDER BY c.id LIMIT 20`,
    [cursor, getConfiguredBayId()],
  );
  cursor =
    rows.length === 20
      ? rows[rows.length - 1].id
      : "00000000-0000-0000-0000-000000000000";
  for (const row of rows) {
    try {
      await withFundingAccountTransaction(row.payer_account_id, async (db) => {
        await db.query(
          `UPDATE compute_vm_personal_consents SET state='expired',version=version+1,updated_at=clock_timestamp()
           WHERE id=$1 AND payer_account_id=$2 AND state IN ('pending','approved','preparing','active')
             AND ((terms->>'ends_at')::timestamptz<=clock_timestamp()
               OR (state='pending' AND approval_expires_at<=clock_timestamp()))`,
          [row.id, row.payer_account_id],
        );
      });
    } catch (err) {
      logger.warn("personal consent expiry awaits authority", {
        consent_id: row.id,
        err,
      });
    }
  }
}
