/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getAccountId from "@cocalc/http-api/lib/account/get-account";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getBayPublicOriginForRequest } from "@cocalc/server/bay-public-origin";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";

export default async function bootstrap(req, res) {
  const account_id = await getAccountId(req);
  if (!account_id) {
    res.json({
      signed_in: false,
      home_bay_id: getConfiguredBayId(),
      home_bay_url: await getBayPublicOriginForRequest(
        req,
        getConfiguredBayId(),
      ),
    });
    return;
  }
  const account = await getClusterAccountById(account_id);
  const home_bay_id =
    `${account?.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  res.json({
    signed_in: true,
    account_id,
    home_bay_id,
    home_bay_url: await getBayPublicOriginForRequest(req, home_bay_id),
  });
}
