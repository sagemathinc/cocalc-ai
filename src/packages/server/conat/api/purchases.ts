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
import { resolveAccountHomeBay } from "@cocalc/server/bay-directory";
import {
  assignMembershipPackageSeat as assignMembershipPackageSeat0,
  claimMembershipPackageSeat as claimMembershipPackageSeat0,
  createMembershipPackage,
  getMembershipPackage,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageDetailsForOwner,
  resolveMembershipPackageQuote as resolveMembershipPackageQuote0,
  revokeMembershipPackageSeat as revokeMembershipPackageSeat0,
  updateMembershipPackage as updateMembershipPackage0,
} from "@cocalc/server/membership/packages";
import { getAIUsageStatus } from "@cocalc/server/ai/usage-status";
import type { MoneyValue } from "@cocalc/util/money";
import isAdmin from "@cocalc/server/accounts/is-admin";
import type { MembershipPackageProduct } from "@cocalc/util/db-schema/shopping-cart-items";
import purchaseMembershipPackage0 from "@cocalc/server/purchases/membership-package";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireFreshAuthForSessionHash } from "@cocalc/server/auth/auth-sessions";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import type {
  MembershipClass,
  MembershipPackageDetails,
} from "@cocalc/conat/hub/api/purchases";

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

async function resolveTargetAccountHomeBay({
  account_id,
  user_account_id,
}: {
  account_id: string;
  user_account_id: string;
}): Promise<string> {
  const location = await resolveAccountHomeBay({
    account_id,
    user_account_id,
  });
  return `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

function requireAccount(account_id?: string): string {
  const owner = `${account_id ?? ""}`.trim();
  if (!owner) {
    throw Error("account_id required");
  }
  return owner;
}

function normalizeSiteLicenseKind(kind?: string): "site" {
  if (kind == null || kind === "site") {
    return "site";
  }
  throw Error("kind must be 'site'");
}

function normalizeAllowedDomain(domain: string): string {
  const value = `${domain ?? ""}`.trim().toLowerCase().replace(/^@+/, "");
  if (
    !value ||
    value.includes("@") ||
    value.includes("/") ||
    value.includes(":") ||
    !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
      value,
    )
  ) {
    throw Error(`invalid allowed domain '${domain}'`);
  }
  return value;
}

function normalizeAllowedDomains(allowed_domains?: string[]): string[] {
  const domains = Array.from(
    new Set((allowed_domains ?? []).map(normalizeAllowedDomain)),
  ).sort();
  if (domains.length === 0) {
    throw Error("at least one allowed domain is required");
  }
  return domains;
}

async function getCreatedMembershipPackageDetails({
  owner_account_id,
  package_id,
}: {
  owner_account_id: string;
  package_id: string;
}): Promise<MembershipPackageDetails> {
  const packages = await listMembershipPackageDetailsForOwner({
    owner_account_id,
  });
  const membershipPackage = packages.find(({ id }) => id === package_id);
  if (!membershipPackage) {
    throw Error("created membership package not found");
  }
  return membershipPackage;
}

async function maybeRequireFreshAuthForBrowserPurchaseAction({
  account_id,
  browser_id,
}: {
  account_id?: string;
  browser_id?: string;
}): Promise<void> {
  const owner = requireAccount(account_id);
  const cleanedBrowserId = `${browser_id ?? ""}`.trim();
  if (!cleanedBrowserId) {
    return;
  }
  const session_hash = getBrowserAuthSessionHash({
    account_id: owner,
    browser_id: cleanedBrowserId,
  });
  if (!session_hash) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  await requireFreshAuthForSessionHash({
    account_id: owner,
    session_hash,
    allow_actor_impersonation: true,
  });
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
  if (account_id && targetId !== account_id) {
    const home_bay_id = await resolveTargetAccountHomeBay({
      account_id,
      user_account_id: targetId,
    });
    if (home_bay_id !== getConfiguredBayId()) {
      return await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: home_bay_id,
      }).getMembershipDetails({
        account_id: targetId,
        refresh_usage_status,
      });
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
  browser_id,
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
  browser_id?: string;
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
  await maybeRequireFreshAuthForBrowserPurchaseAction({
    account_id,
    browser_id,
  });
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
  if (account_id && targetId !== account_id) {
    const home_bay_id = await resolveTargetAccountHomeBay({
      account_id,
      user_account_id: targetId,
    });
    if (home_bay_id !== getConfiguredBayId()) {
      return await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: home_bay_id,
      }).getMembershipPackages({
        owner_account_id: targetId,
      });
    }
  }
  return await listMembershipPackageDetailsForOwner({
    owner_account_id: targetId,
  });
}

export async function adminProvisionMembershipPackage({
  account_id,
  owner_account_id,
  kind,
  membership_class,
  seat_count,
  allowed_domains,
  starts_at,
  expires_at,
  metadata,
}: {
  account_id?: string;
  owner_account_id?: string;
  kind?: "site";
  membership_class?: MembershipClass;
  seat_count?: number;
  allowed_domains?: string[];
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
} = {}): Promise<MembershipPackageDetails> {
  const actorId = requireAccount(account_id);
  if (!(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  const targetId = `${owner_account_id ?? actorId}`.trim();
  if (!targetId) {
    throw Error("owner_account_id required");
  }
  const normalizedKind = normalizeSiteLicenseKind(kind);
  const membershipClass = `${membership_class ?? ""}`.trim();
  if (!membershipClass) {
    throw Error("membership_class is required");
  }
  if (!Number.isInteger(seat_count) || (seat_count ?? 0) <= 0) {
    throw Error("seat_count must be a positive integer");
  }
  const domains = normalizeAllowedDomains(allowed_domains);
  if (targetId !== actorId) {
    const home_bay_id = await resolveTargetAccountHomeBay({
      account_id: actorId,
      user_account_id: targetId,
    });
    if (home_bay_id !== getConfiguredBayId()) {
      return await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: home_bay_id,
      }).adminProvisionMembershipPackage({
        owner_account_id: targetId,
        actor_account_id: actorId,
        kind: normalizedKind,
        membership_class: membershipClass,
        seat_count: seat_count!,
        allowed_domains: domains,
        starts_at,
        expires_at,
        metadata: metadata ?? null,
      });
    }
  }
  const package_id = await createMembershipPackage({
    owner_account_id: targetId,
    kind: normalizedKind,
    membership_class: membershipClass,
    seat_count: seat_count!,
    starts_at,
    expires_at,
    metadata: {
      ...(metadata ?? {}),
      allowed_domains: domains,
      provisioned_by_account_id: actorId,
      provisioned_at: new Date().toISOString(),
      provisioned_via: "admin",
    },
  });
  return await getCreatedMembershipPackageDetails({
    owner_account_id: targetId,
    package_id,
  });
}

export async function updateMembershipPackage({
  account_id,
  package_id,
  owner_account_id,
  seat_count,
  expires_at,
}: {
  account_id?: string;
  package_id?: string;
  owner_account_id?: string;
  seat_count?: number;
  expires_at?: Date | string | null;
} = {}): Promise<MembershipPackageDetails> {
  const actorId = requireAccount(account_id);
  if (!package_id) {
    throw Error("package_id required");
  }
  const isAdminActor = await isAdmin(actorId);
  const targetOwnerId = `${owner_account_id ?? ""}`.trim();
  const home_bay_id = targetOwnerId
    ? await resolveTargetAccountHomeBay({
        account_id: actorId,
        user_account_id: targetOwnerId,
      })
    : getConfiguredBayId();
  if (home_bay_id !== getConfiguredBayId()) {
    if (!isAdminActor) {
      throw Error("must be an admin");
    }
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).updateMembershipPackage({
      package_id,
      actor_account_id: actorId,
      seat_count,
      expires_at,
    });
  }
  const pkg = await getMembershipPackage({ package_id });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.owner_account_id !== actorId && !isAdminActor) {
    throw Error("must own membership package");
  }
  if (targetOwnerId && pkg.owner_account_id !== targetOwnerId) {
    throw Error("membership package does not belong to owner_account_id");
  }
  return await updateMembershipPackage0({
    package_id,
    seat_count,
    expires_at,
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
