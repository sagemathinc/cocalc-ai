import getBalance from "@cocalc/server/purchases/get-balance";
import getMinBalance0 from "@cocalc/server/purchases/get-min-balance";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "@cocalc/server/membership/resolve";
import { getLLMUsageStatus } from "@cocalc/server/llm/usage-status";
import type { MoneyValue } from "@cocalc/util/money";
import isAdmin from "@cocalc/server/accounts/is-admin";

export { getBalance };

export async function getMinBalance({
  account_id,
}: {
  account_id: string;
}): Promise<MoneyValue> {
  return await getMinBalance0(account_id);
}

export async function getMembership({ account_id }) {
  return await resolveMembershipForAccount(account_id);
}

export async function getMembershipDetails({
  account_id,
  user_account_id,
}: {
  account_id?: string;
  user_account_id?: string;
}) {
  const targetId = user_account_id ?? account_id;
  if (!targetId) {
    throw Error("account_id required");
  }
  if (user_account_id && user_account_id !== account_id) {
    if (!account_id || !(await isAdmin(account_id))) {
      throw Error("must be an admin");
    }
  }
  return await resolveMembershipDetailsForAccount(targetId);
}

export async function getLLMUsage({ account_id }) {
  return await getLLMUsageStatus({ account_id });
}
