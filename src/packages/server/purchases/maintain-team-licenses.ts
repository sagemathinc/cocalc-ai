/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import adminAlert from "@cocalc/server/messages/admin-alert";
import getPool from "@cocalc/database/pool";
import { registerBillingAuthorityAccount } from "@cocalc/server/purchases/billing-authority/context";
import {
  createTeamLicenseRenewalPayment,
  getDueTeamLicensesForRenewal,
} from "./team-license";

const logger = getLogger("purchases:maintain-team-licenses");
const RETRY_BACKOFF_MS = 15 * 60_000;
const recentAttempts = new Map<string, number>();

export default async function maintainTeamLicenses({
  max_licenses = Number.POSITIVE_INFINITY,
}: { max_licenses?: number } = {}) {
  logger.debug("maintaining team licenses");
  const licenses = await getDueTeamLicensesForRenewal();
  const limit = Number.isFinite(max_licenses)
    ? Math.max(0, Math.floor(max_licenses))
    : Number.POSITIVE_INFINITY;
  const now = Date.now();
  const eligible = licenses.filter(
    ({ id }) => now - (recentAttempts.get(id) ?? 0) >= RETRY_BACKOFF_MS,
  );
  for (const { id, owner_account_id } of eligible.slice(0, limit)) {
    recentAttempts.set(id, now);
    try {
      await registerBillingAuthorityAccount(owner_account_id);
      await createTeamLicenseRenewalPayment({
        team_license_id: id,
        owner_account_id,
      });
    } catch (err) {
      await getPool()
        .query(
          `UPDATE team_licenses
              SET last_renewal_attempt_at=NOW(), updated=NOW()
            WHERE id=$1 AND owner_account_id=$2`,
          [id, owner_account_id],
        )
        .catch((markErr) =>
          logger.debug("error recording team license renewal backoff", {
            id,
            owner_account_id,
            err: `${markErr}`,
          }),
        );
      logger.debug("error renewing team license", {
        id,
        owner_account_id,
        err: `${err}`,
      });
      adminAlert({
        subject: `ERROR billing team license ${id}`,
        body: err,
      });
    }
  }
}

export const _TEST_ = { recentAttempts };
