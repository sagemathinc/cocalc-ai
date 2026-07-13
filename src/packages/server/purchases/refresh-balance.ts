/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { publishAccountRowFeedEventsBestEffort } from "@cocalc/server/account/account-row-feed";
import { toDecimal, type MoneyValue } from "@cocalc/util/money";
import getBalance from "./get-balance";

const logger = getLogger("purchases:refresh-balance");

export async function publishAccountBalanceUpdateBestEffort({
  account_id,
  balance,
}: {
  account_id: string;
  balance: MoneyValue;
}): Promise<void> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) {
    return;
  }
  try {
    await publishAccountRowFeedEventsBestEffort({
      account_id: accountId,
      patch: { balance: toDecimal(balance).toNumber() },
      reason: "balance_updated",
    });
  } catch (err) {
    logger.warn("failed to publish account balance update", {
      account_id: accountId,
      err: `${err}`,
    });
  }
}

export async function refreshAccountBalanceAndPublishBestEffort({
  account_id,
}: {
  account_id: string;
}): Promise<void> {
  const accountId = `${account_id ?? ""}`.trim();
  if (!accountId) {
    return;
  }
  try {
    const balance = await getBalance({ account_id: accountId });
    await publishAccountBalanceUpdateBestEffort({
      account_id: accountId,
      balance,
    });
  } catch (err) {
    logger.warn("failed to refresh account balance", {
      account_id: accountId,
      err: `${err}`,
    });
  }
}
