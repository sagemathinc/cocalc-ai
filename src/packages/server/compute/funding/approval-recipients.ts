/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { PoolClient } from "@cocalc/database/pool";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountsByIds } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { mapParallelLimit } from "@cocalc/util/async-utils";
import { fundingId } from "@cocalc/util/compute-funding";
import type { FundingApprovalReview } from "./approval-review";

type RecipientCheck = {
  account_ids: string[];
  home_bay_id: string;
  require_active: boolean;
};

/** Private inter-bay service. Never trust a directory copy for sanctions state. */
export async function checkFundingApprovalRecipientsOnHome(
  opts: RecipientCheck,
  db: Pick<PoolClient, "query"> = getPool(),
): Promise<void> {
  if (opts.home_bay_id !== getConfiguredBayId())
    throw new Error("Funding recipient check reached the wrong home bay");
  if (
    !Array.isArray(opts.account_ids) ||
    opts.account_ids.length > 1001 ||
    typeof opts.require_active !== "boolean"
  )
    throw new Error("Invalid funding recipient batch");
  const ids = [
    ...new Set(opts.account_ids.map((id) => fundingId(id, "Recipient"))),
  ].sort();
  if (!ids.length) return;
  const { rows } = await db.query<{
    account_id: string;
    home_bay_id: string;
    banned: boolean | null;
    deleted: boolean | null;
  }>(
    `SELECT account_id, home_bay_id, banned, deleted FROM accounts
      WHERE account_id=ANY($1::uuid[]) ORDER BY account_id FOR SHARE`,
    [ids],
  );
  if (
    rows.length !== ids.length ||
    rows.some(
      (a) =>
        a.home_bay_id !== opts.home_bay_id ||
        (opts.require_active && (a.banned || a.deleted)),
    )
  )
    throw new Error(
      "A funding recipient is unavailable or has changed home bay",
    );
}

/** Resolve homes again on every click, before money locks or external RPCs.
 * Remote checks are bounded-age preflight, not a distributed sanctions lock.
 * Local account rows remain share-locked through the financial commit.
 */
export async function prepareFundingApprovalRecipients(
  review: FundingApprovalReview,
  require_active: boolean,
): Promise<(db: PoolClient) => Promise<Record<string, string>>> {
  const started = Date.now();
  const ids = [
    ...new Set([review.payer, ...review.recipients].map((a) => a.account_id)),
  ];
  const accounts = new Map(
    (await getClusterAccountsByIds(ids)).map((a) => [a.account_id, a]),
  );
  const homes: Record<string, string> = {};
  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const account = accounts.get(id);
    if (!account?.home_bay_id || (require_active && account.banned))
      throw new Error("A funding recipient is unavailable");
    homes[id] = account.home_bay_id;
    groups.set(account.home_bay_id, [
      ...(groups.get(account.home_bay_id) ?? []),
      id,
    ]);
  }
  const local = getConfiguredBayId();
  await mapParallelLimit(
    [...groups],
    async ([home_bay_id, account_ids]) => {
      const opts = { account_ids, home_bay_id, require_active };
      if (home_bay_id === local)
        await checkFundingApprovalRecipientsOnHome(opts);
      else
        await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: home_bay_id,
          timeout: 10_000,
        }).computeFundingCheckApprovalRecipients(opts);
    },
    4,
  );
  return async (db) => {
    if (Date.now() - started > 30_000)
      throw new Error("Funding recipient check expired; retry approval");
    await checkFundingApprovalRecipientsOnHome(
      {
        account_ids: groups.get(local) ?? [],
        home_bay_id: local,
        require_active,
      },
      db,
    );
    if (Date.now() - started > 30_000)
      throw new Error("Funding recipient check expired; retry approval");
    return homes;
  };
}
