import getBalance from "@cocalc/server/purchases/get-balance";
import getMinBalance0 from "@cocalc/server/purchases/get-min-balance";
import {
  getManagedEgressAdminHistory as getManagedEgressAdminHistory0,
  getManagedEgressAdminOverview as getManagedEgressAdminOverview0,
  getManagedEgressHistoryForAccount,
  getProjectOwnerAccountId,
} from "@cocalc/server/membership/managed-egress";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "@cocalc/server/membership/resolve";
import { getAIUsageStatus } from "@cocalc/server/ai/usage-status";
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
  refresh_usage_status,
}: {
  account_id?: string;
  user_account_id?: string;
  refresh_usage_status?: boolean;
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
  return await resolveMembershipDetailsForAccount(targetId, {
    refresh_usage_status,
  });
}

export async function getAIUsage({ account_id }) {
  return await getAIUsageStatus({ account_id });
}

export async function getManagedEgressHistory({
  account_id,
  user_account_id,
  project_id,
  start,
  end,
  bucket,
  recent_event_limit,
  top_project_limit,
}: {
  account_id?: string;
  user_account_id?: string;
  project_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: "5m" | "1h" | "1d";
  recent_event_limit?: number;
  top_project_limit?: number;
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
  const normalizedProjectId = `${project_id ?? ""}`.trim() || undefined;
  if (normalizedProjectId) {
    const owner = await getProjectOwnerAccountId(normalizedProjectId);
    if (!owner) {
      throw Error("project not found");
    }
    if (owner !== targetId) {
      throw Error("project is not owned by target account");
    }
  }
  return await getManagedEgressHistoryForAccount({
    account_id: targetId,
    project_id: normalizedProjectId,
    start,
    end,
    bucket,
    recent_event_limit,
    top_project_limit,
  });
}

export async function getManagedEgressAdminOverview({
  account_id,
  start,
  end,
  recent_event_limit,
  top_account_limit,
  top_project_limit,
}: {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getManagedEgressAdminOverview0({
    start,
    end,
    recent_event_limit,
    top_account_limit,
    top_project_limit,
  });
}

export async function getManagedEgressAdminHistory({
  account_id,
  start,
  end,
  bucket,
  recent_event_limit,
  top_account_limit,
  top_project_limit,
}: {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: "5m" | "1h" | "1d";
  recent_event_limit?: number;
  top_account_limit?: number;
  top_project_limit?: number;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getManagedEgressAdminHistory0({
    start,
    end,
    bucket,
    recent_event_limit,
    top_account_limit,
    top_project_limit,
  });
}
