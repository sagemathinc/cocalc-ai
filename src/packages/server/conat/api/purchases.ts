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
import { getClusterAccountByIdDirect } from "@cocalc/server/accounts/cluster-directory";
import {
  assignMembershipPackageSeat as assignMembershipPackageSeat0,
  claimMembershipPackageSeat as claimMembershipPackageSeat0,
  getMembershipPackage,
  listClaimableMembershipPackagesForAccount,
  listMembershipPackageDetailsForOwner,
  resolveMembershipPackageQuote as resolveMembershipPackageQuote0,
  revokeMembershipPackageSeat as revokeMembershipPackageSeat0,
  updateMembershipPackage as updateMembershipPackage0,
} from "@cocalc/server/membership/packages";
import {
  addSiteLicensePool as addSiteLicensePool0,
  adminProvisionSiteLicense as adminProvisionSiteLicense0,
  getVerifiedEmailAddressesForAccount,
  getSiteLicenseAffiliationReverificationStatusForAccount,
  getSiteLicenseOverview as getSiteLicenseOverview0,
  requestSiteLicensePool as requestSiteLicensePool0,
  refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay,
  removeSiteLicenseManager as removeSiteLicenseManager0,
  reviewSiteLicensePoolRequest as reviewSiteLicensePoolRequest0,
  setSiteLicenseManager as setSiteLicenseManager0,
  updateSiteLicense as updateSiteLicense0,
  updateSiteLicensePool as updateSiteLicensePool0,
} from "@cocalc/server/membership/site-licenses";
import { getAIUsageStatus } from "@cocalc/server/ai/usage-status";
import type { MoneyValue } from "@cocalc/util/money";
import isAdmin from "@cocalc/server/accounts/is-admin";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import purchaseMembershipPackage0 from "@cocalc/server/purchases/membership-package";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getConfiguredClusterSeedBayId } from "@cocalc/server/cluster-config";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { requireFreshAuthForSessionHash } from "@cocalc/server/auth/auth-sessions";
import { getBrowserAuthSessionHash } from "@cocalc/server/conat/socketio/browser-auth-sessions";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import type {
  MembershipPackageDetails,
  SiteLicenseAffiliationReverificationSeat,
  SiteLicenseAffiliationReverificationUserStatus,
  SiteLicenseManagerRole,
  SiteLicenseOverview,
  SiteLicensePoolConfig,
  SiteLicensePoolRequest,
} from "@cocalc/conat/hub/api/purchases";

export { getBalance };

function getSeedBayId(): string {
  return getConfiguredClusterSeedBayId();
}

function isSeedBay(): boolean {
  return getConfiguredBayId() === getSeedBayId();
}

function getSeedSiteLicenseClient() {
  return createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: getSeedBayId(),
  });
}

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
  allow_cross_account_routing = false,
}: {
  account_id: string;
  user_account_id: string;
  allow_cross_account_routing?: boolean;
}): Promise<string> {
  let location;
  try {
    location = await resolveAccountHomeBay({
      account_id,
      user_account_id,
    });
  } catch (err) {
    if (
      !allow_cross_account_routing ||
      `${(err as Error)?.message ?? ""}` !== "not authorized"
    ) {
      throw err;
    }
    const entry = await getClusterAccountByIdDirect(user_account_id);
    if (entry == null) {
      throw new Error(`account ${user_account_id} not found`);
    }
    return `${entry.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  }
  return `${location.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
}

function requireAccount(account_id?: string): string {
  const owner = `${account_id ?? ""}`.trim();
  if (!owner) {
    throw Error("account_id required");
  }
  return owner;
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

async function validatePurchaseFreshAuth({
  account_id,
  browser_id,
  session_hash,
  allow_actor_impersonation = true,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  allow_actor_impersonation?: boolean;
}): Promise<void> {
  const owner = requireAccount(account_id);
  const cleanedSessionHash = `${session_hash ?? ""}`.trim();
  if (cleanedSessionHash) {
    await requireFreshAuthForSessionHash({
      account_id: owner,
      session_hash: cleanedSessionHash,
      allow_actor_impersonation,
    });
    return;
  }
  const cleanedBrowserId = `${browser_id ?? ""}`.trim();
  if (!cleanedBrowserId) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  const browserSessionHash = getBrowserAuthSessionHash({
    account_id: owner,
    browser_id: cleanedBrowserId,
  });
  if (!browserSessionHash) {
    throw Object.assign(new Error("fresh auth is required"), {
      code: "fresh_auth_required",
    });
  }
  await requireFreshAuthForSessionHash({
    account_id: owner,
    session_hash: browserSessionHash,
    allow_actor_impersonation,
  });
}

async function maybeRequireFreshAuthForBrowserPurchaseAction({
  account_id,
  browser_id,
  session_hash,
  allow_actor_impersonation = true,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  allow_actor_impersonation?: boolean;
}): Promise<void> {
  if (!`${browser_id ?? ""}`.trim() && !`${session_hash ?? ""}`.trim()) {
    return;
  }
  await validatePurchaseFreshAuth({
    account_id,
    browser_id,
    session_hash,
    allow_actor_impersonation,
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
  if (account_id) {
    const home_bay_id =
      targetId === account_id
        ? await resolveTargetAccountHomeBay({
            account_id,
            user_account_id: account_id,
          })
        : await resolveTargetAccountHomeBay({
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
  session_hash,
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
  session_hash?: string | null;
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
  await assertAccountTrustedForProductAccess(
    account_id,
    "purchase memberships",
  );
  await maybeRequireFreshAuthForBrowserPurchaseAction({
    account_id,
    browser_id,
    session_hash,
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

export async function updateMembershipPackage({
  account_id,
  browser_id,
  session_hash,
  package_id,
  owner_account_id,
  site_license_id,
  seat_count,
  expires_at,
  allowed_domains,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  package_id?: string;
  owner_account_id?: string;
  site_license_id?: string;
  seat_count?: number;
  expires_at?: Date | string | null;
  allowed_domains?: string[];
} = {}): Promise<MembershipPackageDetails> {
  const actorId = requireAccount(account_id);
  if (!package_id) {
    throw Error("package_id required");
  }
  const isAdminActor = await isAdmin(actorId);
  const siteLicenseId = `${site_license_id ?? ""}`.trim();
  if (siteLicenseId) {
    await validatePurchaseFreshAuth({
      account_id: actorId,
      browser_id,
      session_hash,
      allow_actor_impersonation: false,
    });
    if (!isSeedBay()) {
      return await getSeedSiteLicenseClient().updateMembershipPackage({
        package_id,
        actor_account_id: actorId,
        seat_count,
        expires_at,
        allowed_domains:
          allowed_domains === undefined
            ? undefined
            : normalizeAllowedDomains(allowed_domains),
      });
    }
    return await updateSiteLicensePool0({
      actor_account_id: actorId,
      package_id,
      seat_count,
      expires_at,
      allowed_domains:
        allowed_domains === undefined
          ? undefined
          : normalizeAllowedDomains(allowed_domains),
    });
  }
  await assertAccountTrustedForProductAccess(
    actorId,
    "update membership packages",
  );
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
    const normalizedAllowedDomains =
      allowed_domains === undefined
        ? undefined
        : normalizeAllowedDomains(allowed_domains);
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).updateMembershipPackage({
      package_id,
      actor_account_id: actorId,
      seat_count,
      expires_at,
      allowed_domains: normalizedAllowedDomains,
    });
  }
  const pkg = await getMembershipPackage({ package_id });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.owner_account_id !== actorId && !isAdminActor) {
    throw Error("must own membership package");
  }
  if (pkg.kind === "site") {
    await validatePurchaseFreshAuth({
      account_id: actorId,
      browser_id,
      session_hash,
      allow_actor_impersonation: false,
    });
    return await updateSiteLicensePool0({
      actor_account_id: actorId,
      package_id,
      seat_count,
      expires_at,
      allowed_domains:
        allowed_domains === undefined
          ? undefined
          : normalizeAllowedDomains(allowed_domains),
    });
  }
  if (targetOwnerId && pkg.owner_account_id !== targetOwnerId) {
    throw Error("membership package does not belong to owner_account_id");
  }
  return await updateMembershipPackage0({
    package_id,
    seat_count,
    expires_at,
    allowed_domains:
      allowed_domains === undefined
        ? undefined
        : normalizeAllowedDomains(allowed_domains),
  });
}

export async function assignMembershipPackageSeat({
  account_id,
  browser_id,
  session_hash,
  package_id,
  target_account_id,
  target_email_address,
  metadata,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
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
  await assertAccountTrustedForProductAccess(
    account_id,
    "assign membership seats",
  );
  await validatePurchaseFreshAuth({
    account_id,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const pkg = await getMembershipPackage({ package_id });
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.kind === "site") {
    throw Error(
      "site-license seats must be claimed or approved through site-license workflows",
    );
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
  browser_id,
  session_hash,
  package_id,
  target_account_id,
  target_email_address,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
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
  await assertAccountTrustedForProductAccess(
    account_id,
    "revoke membership seats",
  );
  await validatePurchaseFreshAuth({
    account_id,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
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
  const actorId = requireAccount(account_id);
  const home_bay_id = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (home_bay_id !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).getClaimableMembershipPackagesForAccount({
      account_id: actorId,
    });
  }
  return await listClaimableMembershipPackagesForAccount({
    account_id: actorId,
  });
}

export async function claimMembershipPackageSeat({
  account_id,
  package_id,
  accepted_terms,
}: {
  account_id?: string;
  package_id?: string;
  accepted_terms?: boolean;
}) {
  const actorId = requireAccount(account_id);
  if (!package_id) {
    throw Error("package_id required");
  }
  const home_bay_id = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (home_bay_id !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).claimMembershipPackageSeatForAccount({
      account_id: actorId,
      package_id,
      accepted_terms,
    });
  }
  await assertAccountTrustedForProductAccess(actorId, "claim membership seats");
  return await claimMembershipPackageSeat0({
    package_id,
    account_id: actorId,
    accepted_terms,
  });
}

export async function adminProvisionSiteLicense({
  account_id,
  browser_id,
  session_hash,
  owner_account_id,
  name,
  organization_name,
  allowed_domains,
  pools,
  custom_terms_url,
  custom_policy_url,
  terms_version_label,
  renewal_policy,
  overage_policy,
  starts_at,
  expires_at,
  metadata,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  owner_account_id?: string;
  name?: string;
  organization_name?: string;
  allowed_domains?: string[];
  pools?: SiteLicensePoolConfig[];
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  renewal_policy?: string | null;
  overage_policy?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  if (!(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const ownerAccountId = `${owner_account_id ?? actorId}`.trim();
  if (!ownerAccountId) {
    throw Error("owner_account_id required");
  }
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().adminProvisionSiteLicense({
      actor_account_id: actorId,
      owner_account_id: ownerAccountId,
      name: `${name ?? ""}`,
      organization_name: `${organization_name ?? ""}`,
      allowed_domains: allowed_domains ?? [],
      pools: pools ?? [],
      custom_terms_url,
      custom_policy_url,
      terms_version_label,
      renewal_policy,
      overage_policy,
      starts_at,
      expires_at,
      metadata,
    });
  }
  return await adminProvisionSiteLicense0({
    actor_account_id: actorId,
    owner_account_id: ownerAccountId,
    name: `${name ?? ""}`,
    organization_name: `${organization_name ?? ""}`,
    allowed_domains: allowed_domains ?? [],
    pools: pools ?? [],
    custom_terms_url,
    custom_policy_url,
    terms_version_label,
    renewal_policy,
    overage_policy,
    starts_at,
    expires_at,
    metadata,
  });
}

export async function getSiteLicenseOverview({
  account_id,
  site_license_id,
}: {
  account_id?: string;
  owner_account_id?: string;
  site_license_id?: string;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().getSiteLicenseOverview({
      account_id: actorId,
      site_license_id: `${site_license_id ?? ""}`.trim(),
    });
  }
  return await getSiteLicenseOverview0({
    account_id: actorId,
    site_license_id: `${site_license_id ?? ""}`.trim(),
  });
}

export async function updateSiteLicense({
  account_id,
  browser_id,
  session_hash,
  site_license_id,
  name,
  organization_name,
  allowed_domains,
  custom_terms_url,
  custom_policy_url,
  terms_version_label,
  renewal_policy,
  overage_policy,
  starts_at,
  expires_at,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  site_license_id?: string;
  name?: string;
  organization_name?: string;
  allowed_domains?: string[];
  custom_terms_url?: string | null;
  custom_policy_url?: string | null;
  terms_version_label?: string | null;
  renewal_policy?: string | null;
  overage_policy?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  const siteLicenseId = `${site_license_id ?? ""}`.trim();
  if (!siteLicenseId) {
    throw Error("site_license_id required");
  }
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const opts = {
    actor_account_id: actorId,
    site_license_id: siteLicenseId,
    name,
    organization_name,
    allowed_domains:
      allowed_domains === undefined
        ? undefined
        : normalizeAllowedDomains(allowed_domains),
    custom_terms_url,
    custom_policy_url,
    terms_version_label,
    renewal_policy,
    overage_policy,
    starts_at,
    expires_at,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().updateSiteLicense(opts);
  }
  return await updateSiteLicense0(opts);
}

export async function addSiteLicensePool({
  account_id,
  browser_id,
  session_hash,
  site_license_id,
  pool,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  site_license_id?: string;
  pool?: SiteLicensePoolConfig;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  const siteLicenseId = `${site_license_id ?? ""}`.trim();
  if (!siteLicenseId) {
    throw Error("site_license_id required");
  }
  if (pool == null) {
    throw Error("pool required");
  }
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const opts = {
    actor_account_id: actorId,
    site_license_id: siteLicenseId,
    pool,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().addSiteLicensePool(opts);
  }
  return await addSiteLicensePool0(opts);
}

export async function setSiteLicenseManager({
  account_id,
  site_license_id,
  target_account_id,
  role,
}: {
  account_id?: string;
  site_license_id?: string;
  target_account_id?: string;
  role?: SiteLicenseManagerRole;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  const siteLicenseId = `${site_license_id ?? ""}`.trim();
  const targetAccountId = `${target_account_id ?? ""}`.trim();
  const normalizedRole = `${role ?? ""}`.trim() as SiteLicenseManagerRole;
  const opts = {
    actor_account_id: actorId,
    site_license_id: siteLicenseId,
    target_account_id: targetAccountId,
    role: normalizedRole,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().setSiteLicenseManager(opts);
  }
  return await setSiteLicenseManager0(opts);
}

export async function removeSiteLicenseManager({
  account_id,
  site_license_id,
  target_account_id,
}: {
  account_id?: string;
  site_license_id?: string;
  target_account_id?: string;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  const opts = {
    actor_account_id: actorId,
    site_license_id: `${site_license_id ?? ""}`.trim(),
    target_account_id: `${target_account_id ?? ""}`.trim(),
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().removeSiteLicenseManager(opts);
  }
  return await removeSiteLicenseManager0(opts);
}

export async function requestSiteLicensePool({
  account_id,
  owner_account_id,
  package_id,
  requester_note,
  accepted_terms,
}: {
  account_id?: string;
  owner_account_id?: string;
  package_id?: string;
  requester_note?: string | null;
  accepted_terms?: boolean;
} = {}): Promise<SiteLicensePoolRequest> {
  const actorId = requireAccount(account_id);
  const ownerAccountId = `${owner_account_id ?? ""}`.trim();
  const packageId = `${package_id ?? ""}`.trim();
  const actorHomeBayId = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (actorHomeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: actorHomeBayId,
    }).requestSiteLicensePoolForAccount({
      account_id: actorId,
      owner_account_id: ownerAccountId || undefined,
      package_id: packageId,
      requester_note,
      accepted_terms,
    });
  }
  await assertAccountTrustedForProductAccess(
    actorId,
    "request site-license pool",
  );
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().requestSiteLicensePool({
      account_id: actorId,
      package_id: packageId,
      verified_email_addresses:
        await getVerifiedEmailAddressesForAccount(actorId),
      requester_note,
      accepted_terms,
    });
  }
  return await requestSiteLicensePool0({
    account_id: actorId,
    package_id: packageId,
    requester_note,
    accepted_terms,
  });
}

export async function reviewSiteLicensePoolRequest({
  account_id,
  request_id,
  action,
  review_note,
}: {
  account_id?: string;
  owner_account_id?: string;
  request_id?: string;
  action?: "approve" | "reject";
  review_note?: string | null;
} = {}): Promise<SiteLicensePoolRequest> {
  const actorId = requireAccount(account_id);
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().reviewSiteLicensePoolRequest({
      actor_account_id: actorId,
      request_id: `${request_id ?? ""}`.trim(),
      action: action ?? "reject",
      review_note,
    });
  }
  return await reviewSiteLicensePoolRequest0({
    actor_account_id: actorId,
    request_id: `${request_id ?? ""}`.trim(),
    action: action ?? "reject",
    review_note,
  });
}

export async function getSiteLicenseAffiliationReverificationStatus({
  account_id,
}: {
  account_id?: string;
} = {}): Promise<SiteLicenseAffiliationReverificationUserStatus> {
  const actorId = requireAccount(account_id);
  const home_bay_id = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (home_bay_id !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).getSiteLicenseAffiliationReverificationStatusForAccount({
      account_id: actorId,
    });
  }
  return await getSiteLicenseAffiliationReverificationStatusForAccount({
    account_id: actorId,
  });
}

export async function refreshSiteLicenseAffiliationVerification({
  account_id,
  site_license_id,
}: {
  account_id?: string;
  site_license_id?: string;
} = {}): Promise<SiteLicenseAffiliationReverificationSeat[]> {
  const actorId = requireAccount(account_id);
  const requestedSiteLicenseId = `${site_license_id ?? ""}`.trim();
  const actorHomeBayId = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (actorHomeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: actorHomeBayId,
    }).refreshSiteLicenseAffiliationVerificationForAccount({
      account_id: actorId,
      site_license_id: requestedSiteLicenseId || undefined,
    });
  }
  await assertAccountTrustedForProductAccess(
    actorId,
    "refresh site-license affiliation verification",
  );
  const status = await getSiteLicenseAffiliationReverificationStatusForAccount({
    account_id: actorId,
  });
  const verified_email_addresses =
    await getVerifiedEmailAddressesForAccount(actorId);
  const candidateSeats = status.seats.filter(
    (seat) =>
      seat.can_refresh_with_verified_email &&
      (requestedSiteLicenseId
        ? seat.site_license_id === requestedSiteLicenseId
        : seat.state === "pending_reverification" ||
          seat.state === "grace_expired"),
  );
  const bySiteLicense = new Map(
    candidateSeats.map((seat) => [seat.site_license_id, seat]),
  );
  const refreshed: SiteLicenseAffiliationReverificationSeat[] = [];
  for (const seat of bySiteLicense.values()) {
    if (!isSeedBay()) {
      refreshed.push(
        ...(await getSeedSiteLicenseClient().refreshSiteLicenseAffiliationVerification(
          {
            account_id: actorId,
            site_license_id: seat.site_license_id,
            verified_email_addresses,
          },
        )),
      );
      continue;
    }
    refreshed.push(
      ...(await refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay(
        {
          account_id: actorId,
          site_license_id: seat.site_license_id,
          verified_email_addresses,
        },
      )),
    );
  }
  return refreshed;
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
