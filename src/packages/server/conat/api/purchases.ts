import getBalance from "@cocalc/server/purchases/get-balance";
import getMinBalance0 from "@cocalc/server/purchases/get-min-balance";
import {
  getManagedEgressAdminHistory as getManagedEgressAdminHistory0,
  getManagedEgressAdminOverview as getManagedEgressAdminOverview0,
  getManagedEgressHistoryForAccount,
  getProjectUsageAccountId,
} from "@cocalc/server/membership/managed-egress";
import {
  resolveMembershipDetailsForAccount,
  resolveMembershipForAccount,
} from "@cocalc/server/membership/resolve";
import {
  assignMembershipPackageSeat as assignMembershipPackageSeat0,
  claimMembershipPackageSeat as claimMembershipPackageSeat0,
  getMembershipPackage,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageDetailsForOwner,
  resolveMembershipPackageQuote as resolveMembershipPackageQuote0,
  revokeMembershipPackageSeat as revokeMembershipPackageSeat0,
} from "@cocalc/server/membership/packages";
import { getAIUsageStatus } from "@cocalc/server/ai/usage-status";
import type { MoneyValue } from "@cocalc/util/money";
import isAdmin from "@cocalc/server/accounts/is-admin";
import type { MembershipPackageProduct } from "@cocalc/util/db-schema/shopping-cart-items";
import purchaseMembershipPackage0 from "@cocalc/server/purchases/membership-package";

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

export async function getMembershipPackageQuote({
  account_id,
  package_id,
  kind,
  membership_class,
  seat_count,
  interval,
  course_project_id,
  starts_at,
  expires_at,
  metadata,
}: {
  account_id?: string;
  package_id?: string;
  kind?;
  membership_class?: string;
  seat_count?: number;
  interval?: "month" | "year";
  course_project_id?: string;
  starts_at?: Date | string;
  expires_at?: Date | string;
  metadata?: Record<string, unknown> | null;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  const product: MembershipPackageProduct = {
    type: "membership-package",
    kind,
    membership_class: membership_class ?? "",
    seat_count: seat_count ?? 0,
    interval,
    package_id,
    course_project_id,
    starts_at,
    expires_at,
    metadata: metadata ?? undefined,
  };
  if (package_id) {
    const pkg = await getMembershipPackage({ package_id });
    if (!pkg) {
      throw Error("membership package not found");
    }
    if (pkg.owner_account_id !== account_id && !(await isAdmin(account_id))) {
      throw Error("must own membership package");
    }
  }
  return await resolveMembershipPackageQuote0(product);
}

export async function purchaseMembershipPackage({
  account_id,
  package_id,
  kind,
  membership_class,
  seat_count,
  interval,
  course_project_id,
  starts_at,
  expires_at,
  metadata,
}: {
  account_id?: string;
  package_id?: string;
  kind?;
  membership_class?: string;
  seat_count?: number;
  interval?: "month" | "year";
  course_project_id?: string;
  starts_at?: Date | string;
  expires_at?: Date | string;
  metadata?: Record<string, unknown> | null;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  const product: MembershipPackageProduct = {
    type: "membership-package",
    kind,
    membership_class: membership_class ?? "",
    seat_count: seat_count ?? 0,
    interval,
    package_id,
    course_project_id,
    starts_at,
    expires_at,
    metadata: metadata ?? undefined,
  };
  if (package_id) {
    const pkg = await getMembershipPackage({ package_id });
    if (!pkg) {
      throw Error("membership package not found");
    }
    if (pkg.owner_account_id !== account_id && !(await isAdmin(account_id))) {
      throw Error("must own membership package");
    }
  }
  return await purchaseMembershipPackage0({
    account_id,
    product,
  });
}

export async function getMembershipPackages({
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
  if (targetId !== account_id) {
    if (!account_id || !(await isAdmin(account_id))) {
      throw Error("must be an admin");
    }
  }
  return await listMembershipPackageDetailsForOwner({
    owner_account_id: targetId,
  });
}

export async function assignMembershipPackageSeat({
  account_id,
  package_id,
  target_account_id,
  target_email_address,
  metadata,
}: {
  account_id?: string;
  package_id?: string;
  target_account_id?: string;
  target_email_address?: string;
  metadata?: Record<string, unknown> | null;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!package_id) {
    throw Error("package_id required");
  }
  if (!target_account_id && !target_email_address) {
    throw Error("target_account_id or target_email_address required");
  }
  if (target_account_id && target_email_address) {
    throw Error("specify only one target");
  }
  const pkg = await getMembershipPackage({ package_id });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.owner_account_id !== account_id && !(await isAdmin(account_id))) {
    throw Error("must own membership package");
  }
  return await assignMembershipPackageSeat0({
    package_id,
    account_id: target_account_id,
    email_address: target_email_address,
    assigned_by_account_id: account_id,
    metadata: metadata ?? null,
  });
}

export async function revokeMembershipPackageSeat({
  account_id,
  package_id,
  target_account_id,
  target_email_address,
}: {
  account_id?: string;
  package_id?: string;
  target_account_id?: string;
  target_email_address?: string;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!package_id) {
    throw Error("package_id required");
  }
  if (!target_account_id && !target_email_address) {
    throw Error("target_account_id or target_email_address required");
  }
  if (target_account_id && target_email_address) {
    throw Error("specify only one target");
  }
  const pkg = await getMembershipPackage({ package_id });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.owner_account_id !== account_id && !(await isAdmin(account_id))) {
    throw Error("must own membership package");
  }
  return {
    revoked: await revokeMembershipPackageSeat0({
      package_id,
      account_id: target_account_id,
      email_address: target_email_address,
    }),
  };
}

export async function getClaimableMembershipPackages({
  account_id,
}: {
  account_id?: string;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  return await listClaimableMembershipPackagesForAccount({
    account_id,
  });
}

export async function claimMembershipPackageSeat({
  account_id,
  package_id,
}: {
  account_id?: string;
  package_id?: string;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!package_id) {
    throw Error("package_id required");
  }
  return await claimMembershipPackageSeat0({
    package_id,
    account_id,
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
    const usageAccountId = await getProjectUsageAccountId(normalizedProjectId);
    if (!usageAccountId) {
      throw Error("project not found");
    }
    if (usageAccountId !== targetId) {
      throw Error("project is not attributed to target account");
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
