/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import adminAlert from "@cocalc/server/messages/admin-alert";
import {
  createTeamLicenseRenewalPayment,
  getDueTeamLicensesForRenewal,
} from "./team-license";

const logger = getLogger("purchases:maintain-team-licenses");

export default async function maintainTeamLicenses() {
  logger.debug("maintaining team licenses");
  const licenses = await getDueTeamLicensesForRenewal();
  for (const { id, owner_account_id } of licenses) {
    try {
      await createTeamLicenseRenewalPayment({
        team_license_id: id,
        owner_account_id,
      });
    } catch (err) {
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
