import getBalance from "@cocalc/server/purchases/get-balance";
import getMinBalance0 from "@cocalc/server/purchases/get-min-balance";
import {
  getManagedEgressAdminHistory as getManagedEgressAdminHistory0,
  getManagedEgressAdminOverview as getManagedEgressAdminOverview0,
  getManagedEgressHistoryForAccount,
  getProjectUsageAccountId,
} from "@cocalc/server/membership/managed-egress";
import {
  getManagedCpuAdminHistory as getManagedCpuAdminHistory0,
  getManagedCpuAdminOverview as getManagedCpuAdminOverview0,
} from "@cocalc/server/membership/managed-cpu";
import {
  getAdminActiveUsersOverview as getAdminActiveUsersOverview0,
  getAdminRetentionOverview as getAdminRetentionOverview0,
} from "@cocalc/server/membership/retention-overview";
import {
  createAbuseReviewAnnotation as createAbuseReviewAnnotation0,
  listAbuseReviewAnnotations as listAbuseReviewAnnotations0,
  revokeAbuseReviewAnnotation as revokeAbuseReviewAnnotation0,
} from "@cocalc/server/membership/abuse-review-annotations";
import {
  resetAccountUsageEpoch,
  type AccountUsageWindowName,
} from "@cocalc/server/membership/usage-windows";
import {
  createMembershipTier as createMembershipTier0,
  deleteMembershipTier as deleteMembershipTier0,
  importMembershipTiers as importMembershipTiers0,
  updateMembershipTier as updateMembershipTier0,
} from "@cocalc/server/membership/tier-admin";
import { getAccountUsageOverviewForAccount } from "@cocalc/server/membership/account-usage-overview";
import type {
  AbuseReviewCategory,
  AbuseReviewDisposition,
  AdminMembershipTierPayload,
  AccountUsageWindowEpoch,
  AdminActiveUsersBucket,
  AdminRetentionActivitySignal,
  AdminRetentionCohortUnit,
  AdminResetMembershipUsageWindowsResult,
  AbuseReviewPriorityAdjustment,
  MembershipClass,
  MembershipUsageWindowResetTarget,
} from "@cocalc/conat/hub/api/purchases";
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
  archiveSiteLicensePool as archiveSiteLicensePool0,
  assignSiteLicensePoolSeat as assignSiteLicensePoolSeat0,
  cancelSiteLicensePoolRequest as cancelSiteLicensePoolRequest0,
  getVerifiedEmailAddressesForAccount,
  listSiteLicenseOverviews as listSiteLicenseOverviews0,
  getSiteLicenseAffiliationReverificationStatusForAccount,
  getSiteLicenseOverview as getSiteLicenseOverview0,
  releaseSiteLicensePoolSeat as releaseSiteLicensePoolSeat0,
  requestSiteLicensePool as requestSiteLicensePool0,
  refreshSiteLicenseAffiliationVerificationWithVerifiedEmailsOnLocalBay,
  removeSiteLicenseManager as removeSiteLicenseManager0,
  reviewSiteLicensePoolRequest as reviewSiteLicensePoolRequest0,
  revokeSiteLicensePoolSeat as revokeSiteLicensePoolSeat0,
  setSiteLicenseManager as setSiteLicenseManager0,
  updateSiteLicense as updateSiteLicense0,
  updateSiteLicensePool as updateSiteLicensePool0,
} from "@cocalc/server/membership/site-licenses";
import {
  addSiteLicenseExternalClaimKey as addSiteLicenseExternalClaimKey0,
  consumeSiteLicenseExternalClaimToken as consumeSiteLicenseExternalClaimToken0,
  createSiteLicenseExternalClaimPool as createSiteLicenseExternalClaimPool0,
  disableSiteLicenseExternalClaimPool as disableSiteLicenseExternalClaimPool0,
  listSiteLicenseExternalClaimConsumptions as listSiteLicenseExternalClaimConsumptions0,
  listSiteLicenseExternalClaimKeys as listSiteLicenseExternalClaimKeys0,
  listSiteLicenseExternalClaimPools as listSiteLicenseExternalClaimPools0,
  revokeSiteLicenseExternalClaimKey as revokeSiteLicenseExternalClaimKey0,
} from "@cocalc/server/membership/site-license-external-claims";
import { getAIUsageStatus } from "@cocalc/server/ai/usage-status";
import type { MoneyValue } from "@cocalc/util/money";
import isAdmin from "@cocalc/server/accounts/is-admin";
import type { MembershipPackageProduct } from "@cocalc/util/membership-package-product";
import purchaseMembershipPackage0, {
  purchaseMembershipPackages as purchaseMembershipPackages0,
} from "@cocalc/server/purchases/membership-package";
import {
  verifyDirectStudentCourseProduct,
  verifyDirectStudentCourseProducts,
} from "@cocalc/server/purchases/direct-student-course-product";
import {
  getTeamLicenseOverviewForOwner,
  resolveTeamLicenseQuote,
} from "@cocalc/server/membership/team-licenses";
import { purchaseTeamLicenseChange as purchaseTeamLicenseChange0 } from "@cocalc/server/purchases/team-license";
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
  SiteLicenseExternalClaimConsumption,
  SiteLicenseExternalClaimConsumptionStatus,
  SiteLicenseExternalClaimKey,
  SiteLicenseExternalClaimPool,
  SiteLicenseExternalClaimSigningAlgorithm,
  SiteLicenseManagerRole,
  SiteLicenseOverview,
  SiteLicensePoolConfig,
  SiteLicensePoolRequest,
  MembershipPackageAssignment,
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

function requireMembershipTierId(id?: string | null): MembershipClass {
  const tierId = `${id ?? ""}`.trim();
  if (!tierId) {
    throw Error("membership tier id is required");
  }
  return tierId;
}

function requireMembershipTierPayload(
  tier?: AdminMembershipTierPayload,
): AdminMembershipTierPayload {
  if (tier == null || typeof tier !== "object" || Array.isArray(tier)) {
    throw Error("membership tier payload is required");
  }
  return {
    ...tier,
    id: requireMembershipTierId(tier.id),
  };
}

function requireMembershipTierPayloads(
  tiers?: AdminMembershipTierPayload[],
): AdminMembershipTierPayload[] {
  if (!Array.isArray(tiers) || tiers.length === 0) {
    throw Error("at least one membership tier is required");
  }
  return tiers.map(requireMembershipTierPayload);
}

async function requireAdmin(account_id?: string): Promise<string> {
  const accountId = requireAccount(account_id);
  if (!(await isAdmin(accountId))) {
    throw Error("must be an admin");
  }
  return accountId;
}

function assertMembershipTierAdminBay(): void {
  if (!isSeedBay()) {
    throw Error(
      "membership tier configuration must be changed on the seed bay",
    );
  }
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
  return Array.from(
    new Set((allowed_domains ?? []).map(normalizeAllowedDomain)),
  ).sort();
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

async function requireFreshAuthForPurchaseAction({
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
  await validatePurchaseFreshAuth({
    account_id,
    browser_id,
    session_hash,
    allow_actor_impersonation,
  });
}

async function requireFreshAuthAdmin({
  account_id,
  browser_id,
  session_hash,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
}): Promise<string> {
  const accountId = await requireAdmin(account_id);
  assertMembershipTierAdminBay();
  await validatePurchaseFreshAuth({
    account_id: accountId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  return accountId;
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

export async function createMembershipTier({
  account_id,
  browser_id,
  session_hash,
  tier,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  tier?: AdminMembershipTierPayload;
} = {}): Promise<{ id: MembershipClass }> {
  await requireFreshAuthAdmin({ account_id, browser_id, session_hash });
  return await createMembershipTier0({
    tier: requireMembershipTierPayload(tier),
  });
}

export async function updateMembershipTier({
  account_id,
  browser_id,
  session_hash,
  tier,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  tier?: AdminMembershipTierPayload;
} = {}): Promise<{ id: MembershipClass }> {
  await requireFreshAuthAdmin({ account_id, browser_id, session_hash });
  return await updateMembershipTier0({
    tier: requireMembershipTierPayload(tier),
  });
}

export async function importMembershipTiers({
  account_id,
  browser_id,
  session_hash,
  tiers,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  tiers?: AdminMembershipTierPayload[];
} = {}): Promise<{ ids: MembershipClass[] }> {
  await requireFreshAuthAdmin({ account_id, browser_id, session_hash });
  return await importMembershipTiers0({
    tiers: requireMembershipTierPayloads(tiers),
  });
}

export async function deleteMembershipTier({
  account_id,
  browser_id,
  session_hash,
  id,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  id?: MembershipClass;
} = {}): Promise<{ id: MembershipClass }> {
  await requireFreshAuthAdmin({ account_id, browser_id, session_hash });
  return await deleteMembershipTier0({ id: requireMembershipTierId(id) });
}

export async function getAccountUsageOverview({
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
      }).getAccountUsageOverview({
        account_id: targetId,
      });
    }
  }
  return await getAccountUsageOverviewForAccount({ account_id: targetId });
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
  return await resolveMembershipPackageQuote0(
    await verifyDirectStudentCourseProduct({ account_id, product }),
  );
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
  await requireFreshAuthForPurchaseAction({
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
  const verifiedProduct = await verifyDirectStudentCourseProduct({
    account_id,
    product,
  });
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
    product: verifiedProduct,
  });
}

export async function purchaseMembershipPackages({
  account_id,
  browser_id,
  session_hash,
  products,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  products?: MembershipPackageProduct[];
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  await assertAccountTrustedForProductAccess(
    account_id,
    "purchase memberships",
  );
  await requireFreshAuthForPurchaseAction({
    account_id,
    browser_id,
    session_hash,
  });
  if (!Array.isArray(products) || products.length === 0) {
    throw Error("at least one membership package product is required");
  }
  for (const product of products) {
    if (product?.type !== "membership-package") {
      throw Error("product type must be 'membership-package'");
    }
    if (product.package_id) {
      const pkg = await getMembershipPackage({
        package_id: product.package_id,
      });
      if (!pkg) {
        throw Error("membership package not found");
      }
      if (pkg.owner_account_id !== account_id && !(await isAdmin(account_id))) {
        throw Error("must own membership package");
      }
    }
  }
  const verifiedProducts = await verifyDirectStudentCourseProducts({
    account_id,
    products,
  });
  return await purchaseMembershipPackages0({
    account_id,
    products: verifiedProducts,
  });
}

export async function getTeamLicense({ account_id }: { account_id?: string }) {
  const owner = requireAccount(account_id);
  const home_bay_id = await resolveTargetAccountHomeBay({
    account_id: owner,
    user_account_id: owner,
  });
  if (home_bay_id !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).getTeamLicense({ account_id: owner });
  }
  return await getTeamLicenseOverviewForOwner({ owner_account_id: owner });
}

export async function getTeamLicenseQuote({
  account_id,
  target_seats,
}: {
  account_id?: string;
  target_seats?: Record<string, number>;
}) {
  const owner = requireAccount(account_id);
  const home_bay_id = await resolveTargetAccountHomeBay({
    account_id: owner,
    user_account_id: owner,
  });
  if (home_bay_id !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).getTeamLicenseQuote({ account_id: owner, target_seats });
  }
  return await resolveTeamLicenseQuote({
    owner_account_id: owner,
    target_seats,
  });
}

export async function purchaseTeamLicenseChange({
  account_id,
  browser_id,
  session_hash,
  target_seats,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  target_seats?: Record<string, number>;
}) {
  const owner = requireAccount(account_id);
  await assertAccountTrustedForProductAccess(owner, "purchase memberships");
  await requireFreshAuthForPurchaseAction({
    account_id: owner,
    browser_id,
    session_hash,
  });
  const home_bay_id = await resolveTargetAccountHomeBay({
    account_id: owner,
    user_account_id: owner,
  });
  if (home_bay_id !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: home_bay_id,
    }).purchaseTeamLicenseChange({
      account_id: owner,
      target_seats,
    });
  }
  return await purchaseTeamLicenseChange0({
    account_id: owner,
    target_seats: target_seats ?? {},
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
  pool_name,
  seat_count,
  pool_description,
  requires_approval,
  affiliation_reverification_days,
  affiliation_reverification_grace_days,
  expires_at,
  allowed_domains,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  package_id?: string;
  owner_account_id?: string;
  site_license_id?: string;
  pool_name?: string;
  seat_count?: number;
  pool_description?: string | null;
  requires_approval?: boolean;
  affiliation_reverification_days?: number | null;
  affiliation_reverification_grace_days?: number | null;
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
        pool_name,
        seat_count,
        pool_description,
        requires_approval,
        affiliation_reverification_days,
        affiliation_reverification_grace_days,
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
      pool_name,
      seat_count,
      pool_description,
      requires_approval,
      affiliation_reverification_days,
      affiliation_reverification_grace_days,
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
      pool_name,
      seat_count,
      pool_description,
      requires_approval,
      affiliation_reverification_days,
      affiliation_reverification_grace_days,
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
      pool_name,
      seat_count,
      pool_description,
      requires_approval,
      affiliation_reverification_days,
      affiliation_reverification_grace_days,
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
  const isAdminActor = await isAdmin(account_id);
  const pkg = await getMembershipPackage({ package_id });
  if (!pkg && !isSeedBay()) {
    return await getSeedSiteLicenseClient().revokeSiteLicensePoolSeat({
      actor_account_id: account_id,
      package_id,
      target_account_id,
      target_email_address,
      trusted_admin: isAdminActor,
    });
  }
  if (!pkg) {
    throw Error("membership package not found");
  }
  if (pkg.kind === "site") {
    return {
      revoked: await revokeSiteLicensePoolSeat0({
        actor_account_id: account_id,
        package_id,
        target_account_id,
        target_email_address,
        trusted_admin: isAdminActor,
      }),
    };
  }
  if (pkg.owner_account_id !== account_id && !isAdminActor) {
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

export async function assignSiteLicensePoolSeat({
  account_id,
  browser_id,
  session_hash,
  package_id,
  target_account_id,
  grant_expires_at,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  package_id?: string;
  target_account_id?: string;
  grant_expires_at?: Date | string | null;
} = {}): Promise<MembershipPackageAssignment> {
  const actorId = requireAccount(account_id);
  if (!package_id) {
    throw Error("package_id required");
  }
  if (!target_account_id) {
    throw Error("target_account_id required");
  }
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const opts = {
    actor_account_id: actorId,
    package_id,
    target_account_id,
    grant_expires_at,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().assignSiteLicensePoolSeat(opts);
  }
  return await assignSiteLicensePoolSeat0(opts);
}

export async function getClaimableMembershipPackages({
  account_id,
  include_claimed_site_license_pools,
}: {
  account_id?: string;
  include_claimed_site_license_pools?: boolean;
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
      ...(include_claimed_site_license_pools
        ? { include_claimed_site_license_pools }
        : {}),
    });
  }
  return await listClaimableMembershipPackagesForAccount({
    account_id: actorId,
    ...(include_claimed_site_license_pools
      ? { include_claimed_site_license_pools }
      : {}),
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
  const ownerAccountId = `${owner_account_id ?? ""}`.trim() || undefined;
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

export async function listSiteLicenseOverviews({
  account_id,
  admin = false,
}: {
  account_id?: string;
  admin?: boolean;
} = {}): Promise<SiteLicenseOverview[]> {
  const actorId = requireAccount(account_id);
  if (admin && !(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().listSiteLicenseOverviews({
      actor_account_id: actorId,
      admin,
      trusted_admin: admin,
    });
  }
  return await listSiteLicenseOverviews0({
    account_id: actorId,
    admin,
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

export async function createSiteLicenseExternalClaimPool({
  account_id,
  browser_id,
  session_hash,
  site_license_id,
  package_id,
  name,
  issuer,
  slug,
  audience,
  default_membership_class,
  allow_membership_class_override,
  default_membership_duration_days,
  default_membership_expires_at,
  allow_membership_expires_at_override,
  min_membership_duration_days,
  max_membership_duration_days,
  max_membership_expires_at,
  default_rootfs_id,
  max_claims,
  max_claims_per_account,
  starts_at,
  expires_at,
  disabled_at,
  metadata,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  site_license_id?: string;
  package_id?: string;
  name?: string;
  issuer?: string;
  slug?: string | null;
  audience?: string;
  default_membership_class?: string | null;
  allow_membership_class_override?: boolean;
  default_membership_duration_days?: number | null;
  default_membership_expires_at?: Date | string | null;
  allow_membership_expires_at_override?: boolean;
  min_membership_duration_days?: number | null;
  max_membership_duration_days?: number | null;
  max_membership_expires_at?: Date | string | null;
  default_rootfs_id?: string | null;
  max_claims?: number | null;
  max_claims_per_account?: number | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  disabled_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
} = {}): Promise<SiteLicenseExternalClaimPool> {
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
  const opts = {
    actor_account_id: actorId,
    site_license_id: `${site_license_id ?? ""}`.trim(),
    package_id: `${package_id ?? ""}`.trim(),
    name: `${name ?? ""}`.trim(),
    issuer: `${issuer ?? ""}`.trim(),
    slug,
    audience,
    default_membership_class,
    allow_membership_class_override,
    default_membership_duration_days,
    default_membership_expires_at,
    allow_membership_expires_at_override,
    min_membership_duration_days,
    max_membership_duration_days,
    max_membership_expires_at,
    default_rootfs_id,
    max_claims,
    max_claims_per_account,
    starts_at,
    expires_at,
    disabled_at,
    metadata,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().createSiteLicenseExternalClaimPool(
      opts,
    );
  }
  return await createSiteLicenseExternalClaimPool0({
    ...opts,
    created_by_account_id: actorId,
  });
}

export async function addSiteLicenseExternalClaimKey({
  account_id,
  browser_id,
  session_hash,
  pool_id,
  kid,
  alg,
  public_key_jwk,
  public_key_pem,
  starts_at,
  expires_at,
  revoked_at,
  metadata,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  pool_id?: string;
  kid?: string;
  alg?: SiteLicenseExternalClaimSigningAlgorithm;
  public_key_jwk?: Record<string, unknown> | null;
  public_key_pem?: string | null;
  starts_at?: Date | string | null;
  expires_at?: Date | string | null;
  revoked_at?: Date | string | null;
  metadata?: Record<string, unknown> | null;
} = {}): Promise<SiteLicenseExternalClaimKey> {
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
  const opts = {
    actor_account_id: actorId,
    pool_id: `${pool_id ?? ""}`.trim(),
    kid: `${kid ?? ""}`.trim(),
    alg: alg ?? "EdDSA",
    public_key_jwk,
    public_key_pem,
    starts_at,
    expires_at,
    revoked_at,
    metadata,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().addSiteLicenseExternalClaimKey(
      opts,
    );
  }
  return await addSiteLicenseExternalClaimKey0({
    ...opts,
    created_by_account_id: actorId,
  });
}

export async function listSiteLicenseExternalClaimPools({
  account_id,
  site_license_id,
  package_id,
  pool_id,
  limit,
}: {
  account_id?: string;
  site_license_id?: string;
  package_id?: string;
  pool_id?: string;
  limit?: number;
} = {}): Promise<SiteLicenseExternalClaimPool[]> {
  const actorId = requireAccount(account_id);
  if (!(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  const opts = { site_license_id, package_id, pool_id, limit };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().listSiteLicenseExternalClaimPools({
      account_id: actorId,
      ...opts,
    });
  }
  return await listSiteLicenseExternalClaimPools0(opts);
}

export async function disableSiteLicenseExternalClaimPool({
  account_id,
  browser_id,
  session_hash,
  pool_id,
  disabled_at,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  pool_id?: string;
  disabled_at?: Date | string | null;
} = {}): Promise<SiteLicenseExternalClaimPool> {
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
  const opts = {
    actor_account_id: actorId,
    pool_id: `${pool_id ?? ""}`.trim(),
    disabled_at,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().disableSiteLicenseExternalClaimPool(
      opts,
    );
  }
  return await disableSiteLicenseExternalClaimPool0(opts);
}

export async function listSiteLicenseExternalClaimKeys({
  account_id,
  pool_id,
  kid,
  limit,
}: {
  account_id?: string;
  pool_id?: string;
  kid?: string;
  limit?: number;
} = {}): Promise<SiteLicenseExternalClaimKey[]> {
  const actorId = requireAccount(account_id);
  if (!(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  const opts = {
    pool_id: `${pool_id ?? ""}`.trim(),
    kid: `${kid ?? ""}`.trim(),
    limit,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().listSiteLicenseExternalClaimKeys({
      account_id: actorId,
      ...opts,
    });
  }
  return await listSiteLicenseExternalClaimKeys0(opts);
}

export async function revokeSiteLicenseExternalClaimKey({
  account_id,
  browser_id,
  session_hash,
  pool_id,
  kid,
  revoked_at,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  pool_id?: string;
  kid?: string;
  revoked_at?: Date | string | null;
} = {}): Promise<SiteLicenseExternalClaimKey> {
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
  const opts = {
    actor_account_id: actorId,
    pool_id: `${pool_id ?? ""}`.trim(),
    kid: `${kid ?? ""}`.trim(),
    revoked_at,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().revokeSiteLicenseExternalClaimKey(
      opts,
    );
  }
  return await revokeSiteLicenseExternalClaimKey0(opts);
}

export async function listSiteLicenseExternalClaimConsumptions({
  account_id,
  pool_id,
  site_license_id,
  target_account_id,
  status,
  limit,
}: {
  account_id?: string;
  pool_id?: string;
  site_license_id?: string;
  target_account_id?: string;
  status?: SiteLicenseExternalClaimConsumptionStatus;
  limit?: number;
} = {}): Promise<SiteLicenseExternalClaimConsumption[]> {
  const actorId = requireAccount(account_id);
  if (!(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  const opts = {
    pool_id: `${pool_id ?? ""}`.trim() || undefined,
    site_license_id: `${site_license_id ?? ""}`.trim() || undefined,
    account_id: `${target_account_id ?? ""}`.trim() || undefined,
    status,
    limit,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().listSiteLicenseExternalClaimConsumptions(
      {
        account_id: actorId,
        pool_id: opts.pool_id,
        site_license_id: opts.site_license_id,
        target_account_id: opts.account_id,
        status,
        limit,
      },
    );
  }
  return await listSiteLicenseExternalClaimConsumptions0(opts);
}

export async function consumeSiteLicenseExternalClaimToken({
  account_id,
  token,
}: {
  account_id?: string;
  token?: string;
} = {}): Promise<SiteLicenseExternalClaimConsumption> {
  try {
    const actorId = requireAccount(account_id);
    const rawToken = `${token ?? ""}`.trim();
    if (!rawToken) {
      throw Error("token required");
    }
    const home_bay_id = await resolveTargetAccountHomeBay({
      account_id: actorId,
      user_account_id: actorId,
    });
    if (home_bay_id !== getConfiguredBayId()) {
      return await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: home_bay_id,
      }).consumeSiteLicenseExternalClaimToken({
        account_id: actorId,
        token: rawToken,
      });
    }
    await assertAccountTrustedForProductAccess(
      actorId,
      "claim site-license external token",
    );
    if (!isSeedBay()) {
      return await getSeedSiteLicenseClient().consumeSiteLicenseExternalClaimToken(
        {
          account_id: actorId,
          token: rawToken,
        },
      );
    }
    return await consumeSiteLicenseExternalClaimToken0({
      account_id: actorId,
      token: rawToken,
    });
  } catch (err) {
    throw asSiteLicenseExternalClaimRpcError(err);
  }
}

function asSiteLicenseExternalClaimRpcError(err: unknown): Error {
  const message = err instanceof Error ? err.message : `${err}`;
  if (err instanceof Error && (err as any).code) {
    return err;
  }
  return Object.assign(err instanceof Error ? err : new Error(message), {
    code: classifySiteLicenseExternalClaimError(message),
  });
}

function classifySiteLicenseExternalClaimError(message: string): string {
  const s = message.toLowerCase();
  if (s.includes("token required")) return "claim_token_required";
  if (s.includes("external claim key")) return "claim_token_invalid";
  if (s.includes("pool") && s.includes("disabled")) {
    return "claim_pool_disabled";
  }
  if (s.includes("pool") && s.includes("expired")) {
    return "claim_pool_disabled";
  }
  if (s.includes("site license") && s.includes("disabled")) {
    return "claim_site_license_disabled";
  }
  if (s.includes("site license") && s.includes("expired")) {
    return "claim_site_license_disabled";
  }
  if (s.includes("expired")) return "claim_token_expired";
  if (s.includes("not active yet")) return "claim_token_not_active";
  if (s.includes("already consumed")) return "claim_token_already_used";
  if (s.includes("already claimed for this account")) {
    return "claim_pool_account_limit";
  }
  if (s.includes("no claims available")) return "claim_pool_limit";
  if (s.includes("not found")) return "claim_not_found";
  if (s.includes("audience")) return "claim_audience_mismatch";
  if (s.includes("issuer")) return "claim_issuer_mismatch";
  if (s.includes("signature") || s.includes("compact jws")) {
    return "claim_token_invalid";
  }
  if (s.includes("membership") || s.includes("seat")) {
    return "claim_membership_failed";
  }
  return "claim_failed";
}

export async function archiveSiteLicensePool({
  account_id,
  browser_id,
  session_hash,
  package_id,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  package_id?: string;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  const packageId = `${package_id ?? ""}`.trim();
  if (!packageId) {
    throw Error("package_id required");
  }
  if (!(await isAdmin(actorId))) {
    throw Error("must be an admin");
  }
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const opts = {
    actor_account_id: actorId,
    package_id: packageId,
  };
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().archiveSiteLicensePool(opts);
  }
  return await archiveSiteLicensePool0(opts);
}

export async function setSiteLicenseManager({
  account_id,
  browser_id,
  session_hash,
  site_license_id,
  target_account_id,
  role,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  site_license_id?: string;
  target_account_id?: string;
  role?: SiteLicenseManagerRole;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  const siteLicenseId = `${site_license_id ?? ""}`.trim();
  const targetAccountId = `${target_account_id ?? ""}`.trim();
  const normalizedRole = `${role ?? ""}`.trim() as SiteLicenseManagerRole;
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
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
  browser_id,
  session_hash,
  site_license_id,
  target_account_id,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  site_license_id?: string;
  target_account_id?: string;
} = {}): Promise<SiteLicenseOverview> {
  const actorId = requireAccount(account_id);
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
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

export async function cancelSiteLicensePoolRequest({
  account_id,
  request_id,
}: {
  account_id?: string;
  request_id?: string;
} = {}): Promise<SiteLicensePoolRequest> {
  const actorId = requireAccount(account_id);
  const requestId = `${request_id ?? ""}`.trim();
  if (!requestId) {
    throw Error("request_id required");
  }
  const actorHomeBayId = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (actorHomeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: actorHomeBayId,
    }).cancelSiteLicensePoolRequest({
      account_id: actorId,
      request_id: requestId,
    });
  }
  await assertAccountTrustedForProductAccess(
    actorId,
    "cancel site-license pool request",
  );
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().cancelSiteLicensePoolRequest({
      account_id: actorId,
      request_id: requestId,
    });
  }
  return await cancelSiteLicensePoolRequest0({
    account_id: actorId,
    request_id: requestId,
  });
}

export async function releaseSiteLicensePoolSeat({
  account_id,
  package_id,
}: {
  account_id?: string;
  package_id?: string;
} = {}): Promise<{ revoked: boolean }> {
  const actorId = requireAccount(account_id);
  const packageId = `${package_id ?? ""}`.trim();
  if (!packageId) {
    throw Error("package_id required");
  }
  const actorHomeBayId = await resolveTargetAccountHomeBay({
    account_id: actorId,
    user_account_id: actorId,
  });
  if (actorHomeBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: actorHomeBayId,
    }).releaseSiteLicensePoolSeat({
      account_id: actorId,
      package_id: packageId,
    });
  }
  await assertAccountTrustedForProductAccess(
    actorId,
    "release site-license pool seat",
  );
  if (!isSeedBay()) {
    return await getSeedSiteLicenseClient().releaseSiteLicensePoolSeat({
      account_id: actorId,
      package_id: packageId,
    });
  }
  return {
    revoked: await releaseSiteLicensePoolSeat0({
      account_id: actorId,
      package_id: packageId,
    }),
  };
}

export async function reviewSiteLicensePoolRequest({
  account_id,
  browser_id,
  session_hash,
  request_id,
  action,
  review_note,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  owner_account_id?: string;
  request_id?: string;
  action?: "approve" | "reject";
  review_note?: string | null;
} = {}): Promise<SiteLicensePoolRequest> {
  const actorId = requireAccount(account_id);
  await validatePurchaseFreshAuth({
    account_id: actorId,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
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

export async function getManagedCpuAdminOverview({
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
  return await getManagedCpuAdminOverview0({
    start,
    end,
    recent_event_limit,
    top_account_limit,
    top_project_limit,
  });
}

export async function getManagedCpuAdminHistory({
  account_id,
  user_account_id,
  project_id,
  start,
  end,
  bucket,
  recent_event_limit,
  top_account_limit,
  top_project_limit,
}: {
  account_id?: string;
  user_account_id?: string;
  project_id?: string;
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
  const targetAccountId = `${user_account_id ?? ""}`.trim() || undefined;
  const normalizedProjectId = `${project_id ?? ""}`.trim() || undefined;
  if (normalizedProjectId && targetAccountId) {
    const usageAccountId = await getProjectUsageAccountId(normalizedProjectId);
    if (!usageAccountId) {
      throw Error("project not found");
    }
    if (usageAccountId !== targetAccountId) {
      throw Error("project is not attributed to target account");
    }
  }
  return await getManagedCpuAdminHistory0({
    account_id: targetAccountId,
    project_id: normalizedProjectId,
    start,
    end,
    bucket,
    recent_event_limit,
    top_account_limit,
    top_project_limit,
  });
}

export async function getAdminRetentionOverview({
  account_id,
  start,
  end,
  unit,
  activity_signal,
  period_count,
  exclude_banned,
  opened_project_only,
}: {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  unit?: AdminRetentionCohortUnit;
  activity_signal?: AdminRetentionActivitySignal;
  period_count?: number;
  exclude_banned?: boolean;
  opened_project_only?: boolean;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getAdminRetentionOverview0({
    start,
    end,
    unit,
    activity_signal,
    period_count,
    exclude_banned,
    opened_project_only,
  });
}

export async function getAdminActiveUsersOverview({
  account_id,
  start,
  end,
  bucket,
  activity_signal,
  exclude_banned,
  opened_project_only,
}: {
  account_id?: string;
  start?: string | Date;
  end?: string | Date;
  bucket?: AdminActiveUsersBucket;
  activity_signal?: AdminRetentionActivitySignal;
  exclude_banned?: boolean;
  opened_project_only?: boolean;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await getAdminActiveUsersOverview0({
    start,
    end,
    bucket,
    activity_signal,
    exclude_banned,
    opened_project_only,
  });
}

function requiresFreshAuthForAbuseAnnotation({
  disposition,
  priority_adjustment,
}: {
  disposition?: AbuseReviewDisposition;
  priority_adjustment?: AbuseReviewPriorityAdjustment;
}): boolean {
  return disposition === "abusive" || priority_adjustment === "urgent";
}

export async function createAbuseReviewAnnotation({
  account_id,
  browser_id,
  session_hash,
  user_account_id,
  project_id,
  category,
  disposition,
  priority_adjustment,
  reason,
  evidence,
  expires_at,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  user_account_id?: string;
  project_id?: string | null;
  category?: AbuseReviewCategory;
  disposition?: AbuseReviewDisposition;
  priority_adjustment?: AbuseReviewPriorityAdjustment;
  reason?: string;
  evidence?: Record<string, unknown> | null;
  expires_at?: string | Date | null;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  if (
    requiresFreshAuthForAbuseAnnotation({ disposition, priority_adjustment })
  ) {
    await validatePurchaseFreshAuth({
      account_id,
      browser_id,
      session_hash,
      allow_actor_impersonation: false,
    });
  }
  return await createAbuseReviewAnnotation0({
    account_id: user_account_id,
    project_id,
    category,
    disposition,
    priority_adjustment,
    reason,
    evidence,
    created_by: account_id,
    expires_at,
  });
}

export async function listAbuseReviewAnnotations({
  account_id,
  user_account_id,
  project_id,
  category,
  active_only,
  limit,
}: {
  account_id?: string;
  user_account_id?: string;
  project_id?: string | null;
  category?: AbuseReviewCategory;
  active_only?: boolean;
  limit?: number;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  return await listAbuseReviewAnnotations0({
    account_id: user_account_id,
    project_id,
    category,
    active_only,
    limit,
  });
}

export async function revokeAbuseReviewAnnotation({
  account_id,
  browser_id,
  session_hash,
  id,
  revoked_reason,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  id?: string;
  revoked_reason?: string;
}) {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await validatePurchaseFreshAuth({
    account_id,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  return await revokeAbuseReviewAnnotation0({
    id,
    revoked_by: account_id,
    revoked_reason,
  });
}

function normalizeMembershipUsageWindowResetTarget(
  value?: MembershipUsageWindowResetTarget,
): AccountUsageWindowName[] {
  const window = `${value ?? "all"}`.trim();
  if (window === "5h" || window === "7d") {
    return [window];
  }
  if (window === "all") {
    return ["5h", "7d"];
  }
  throw Error("window must be '5h', '7d', or 'all'");
}

export async function adminResetMembershipUsageWindows({
  account_id,
  browser_id,
  session_hash,
  window,
  reason,
}: {
  account_id?: string;
  browser_id?: string;
  session_hash?: string | null;
  window?: MembershipUsageWindowResetTarget;
  reason?: string;
}): Promise<AdminResetMembershipUsageWindowsResult> {
  if (!account_id) {
    throw Error("account_id required");
  }
  if (!(await isAdmin(account_id))) {
    throw Error("must be an admin");
  }
  await validatePurchaseFreshAuth({
    account_id,
    browser_id,
    session_hash,
    allow_actor_impersonation: false,
  });
  const windows: AccountUsageWindowEpoch[] = [];
  for (const targetWindow of normalizeMembershipUsageWindowResetTarget(
    window,
  )) {
    windows.push(
      await resetAccountUsageEpoch({
        window: targetWindow,
        reset_by: account_id,
        reason: reason ?? "",
      }),
    );
  }
  return { windows };
}
