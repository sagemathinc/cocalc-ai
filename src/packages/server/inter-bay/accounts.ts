/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { v4 as uuid } from "uuid";
import {
  type AccountApiKeyDirectoryEntry,
  createInterBayAccountDirectoryClient,
  createInterBayAccountLocalClient,
  type AccountApiKeyDirectoryDeleteRequest,
  type AccountApiKeyDirectoryTouchRequest,
  type AccountApiKeyDirectoryUpdateHomeBayRequest,
  type AccountApiKeyDirectoryUpsertRequest,
  type AccountLocalAdminDisableTwoFactorResult,
  type AccountLocalQuarantineBillingResourcesRequest,
  type AccountLocalQuarantineBillingResourcesResult,
  type AccountLocalAdminVerifyEmailAddressResult,
  type AccountLocalSetBanRequest,
  type AccountLocalSetBanResult,
  type AccountLocalSetPasswordFromResetRequest,
  type AccountLocalVerifySignInPasswordRequest,
  type AccountLocalVerifySignInPasswordResult,
  type AccountDirectoryCreateRequest,
  type AccountDirectoryDeleteRequest,
  type AccountDirectoryDeleteResult,
  type AccountDirectoryEntry,
} from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import adminVerifyEmailAddressLocal from "@cocalc/server/accounts/admin-verify-email-address";
import createAccountLocal from "@cocalc/server/accounts/create-account";
import deleteAccountLocal from "@cocalc/server/accounts/delete";
import { banUser, removeUserBan } from "@cocalc/server/accounts/ban";
import { recordAccountBanAuditEvent } from "@cocalc/server/accounts/ban-audit";
import { quarantineAccountBillingResourcesLocal } from "@cocalc/server/accounts/resource-quarantine";
import { assertSignupEmailDomainAllowed } from "@cocalc/server/accounts/signup-email-domain-policy";
import setPasswordFromResetLocal from "@cocalc/server/accounts/set-password-from-reset";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import { adminDisableTwoFactor as adminDisableTwoFactorLocal } from "@cocalc/server/auth/two-factor";
import { verifyLocalSignInPassword } from "@cocalc/server/auth/verify-sign-in-password";
import {
  deleteClusterAccountApiKeyDirectoryEntryDirect,
  deleteClusterAccountDirectoryEntry,
  getClusterAccountApiKeyByKeyIdDirect,
  getClusterBanEquivalentEmailAccountsDirect,
  getClusterAccountByEmailDirect,
  getClusterAccountByIdDirect,
  getClusterAccountHomeBayCountsDirect,
  getClusterAccountsByIdsDirect,
  markClusterAccountProvisioned,
  reserveClusterAccountDirectoryEntry,
  searchClusterAccountsDirect,
  touchClusterAccountApiKeyDirectoryEntryDirect,
  updateClusterAccountBannedDirect,
  updateClusterAccountEmailAddressDirect,
  updateClusterAccountApiKeysHomeBayDirect,
  updateClusterAccountHomeBayDirect,
  canonicalEmailForBanEquivalence,
  upsertClusterAccountApiKeyDirectoryEntryDirect,
} from "@cocalc/server/accounts/cluster-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { isValidUUID } from "@cocalc/util/misc";

function currentBayId(): string {
  return getConfiguredBayId();
}

export async function getClusterAccountById(
  account_id: string,
): Promise<AccountDirectoryEntry | null> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getClusterAccountByIdDirect(account_id);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).get({ account_id });
}

export async function getClusterAccountByEmail(
  email_address: string,
): Promise<AccountDirectoryEntry | null> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getClusterAccountByEmailDirect(email_address);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).getByEmail({ email_address });
}

export async function getClusterAccountsByIds(
  account_ids: string[],
): Promise<AccountDirectoryEntry[]> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getClusterAccountsByIdsDirect(account_ids);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).getMany({ account_ids });
}

export async function searchClusterAccounts({
  query,
  limit,
  admin,
  only_email,
}: {
  query: string;
  limit?: number;
  admin?: boolean;
  only_email?: boolean;
}): Promise<AccountDirectoryEntry[]> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await searchClusterAccountsDirect({
      query,
      limit,
      admin,
      only_email,
    });
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).search({
    query,
    limit,
    admin,
    only_email,
  });
}

export async function getClusterBanEquivalentEmailAccounts({
  email_address,
  limit,
}: {
  email_address: string;
  limit?: number;
}): Promise<AccountDirectoryEntry[]> {
  const normalized = `${email_address ?? ""}`.trim().toLowerCase();
  if (!normalized) {
    return [];
  }
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getClusterBanEquivalentEmailAccountsDirect({
      email_address: normalized,
      limit,
    });
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).getBanEquivalentEmailAccounts({
    email_address: normalized,
    limit,
  });
}

export async function getClusterAccountHomeBayCounts(): Promise<
  Record<string, number>
> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getClusterAccountHomeBayCountsDirect();
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).getHomeBayCounts({});
}

export async function assertNoClusterBannedEquivalentEmailAccount({
  email_address,
  allowed_account_id,
}: {
  email_address?: string | null;
  allowed_account_id?: string | null;
}): Promise<void> {
  const email = `${email_address ?? ""}`.trim().toLowerCase();
  if (!email || !canonicalEmailForBanEquivalence(email)) {
    return;
  }
  const allowedAccountId = `${allowed_account_id ?? ""}`.trim().toLowerCase();
  const banned = (
    await getClusterBanEquivalentEmailAccounts({ email_address: email })
  ).find(
    (account) =>
      account.banned === true &&
      (!allowedAccountId || account.account_id !== allowedAccountId),
  );
  if (!banned) {
    return;
  }
  throw Error(
    `This email address is blocked because an equivalent address is banned (${banned.email_address ?? banned.account_id}).`,
  );
}

export async function updateClusterAccountHomeBay(opts: {
  account_id: string;
  home_bay_id: string;
}): Promise<AccountDirectoryEntry> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await updateClusterAccountHomeBayDirect(opts);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).updateHomeBay(opts);
}

export async function updateClusterAccountEmailAddress(opts: {
  account_id: string;
  email_address: string;
}): Promise<AccountDirectoryEntry> {
  const normalized = {
    ...opts,
    account_id: `${opts.account_id ?? ""}`.trim().toLowerCase(),
    email_address: `${opts.email_address ?? ""}`.trim().toLowerCase(),
  };
  await assertSignupEmailDomainAllowed({
    email_address: normalized.email_address,
  });
  await assertNoClusterBannedEquivalentEmailAccount({
    email_address: normalized.email_address,
    allowed_account_id: normalized.account_id,
  });
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await updateClusterAccountEmailAddressDirect(normalized);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).updateEmailAddress(normalized);
}

export async function updateClusterAccountBanned(opts: {
  account_id: string;
  banned: boolean;
}): Promise<AccountDirectoryEntry> {
  const normalized = {
    account_id: `${opts.account_id ?? ""}`.trim().toLowerCase(),
    banned: !!opts.banned,
  };
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await updateClusterAccountBannedDirect(normalized);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).updateBanned(normalized);
}

export async function getClusterAccountApiKeyByKeyId(
  key_id: string,
): Promise<AccountApiKeyDirectoryEntry | null> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await getClusterAccountApiKeyByKeyIdDirect(key_id);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).getApiKey({ key_id });
}

export async function upsertClusterAccountApiKeyDirectoryEntry(
  opts: AccountApiKeyDirectoryUpsertRequest,
): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await upsertClusterAccountApiKeyDirectoryEntryDirect(opts);
    return;
  }
  await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).upsertApiKey(opts);
}

export async function deleteClusterAccountApiKeyDirectoryEntry(
  opts: AccountApiKeyDirectoryDeleteRequest,
): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await deleteClusterAccountApiKeyDirectoryEntryDirect(opts.key_id);
    return;
  }
  await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).deleteApiKey(opts);
}

export async function updateClusterAccountApiKeysHomeBay(
  opts: AccountApiKeyDirectoryUpdateHomeBayRequest,
): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await updateClusterAccountApiKeysHomeBayDirect(opts);
    return;
  }
  await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).updateApiKeysHomeBay(opts);
}

export async function touchClusterAccountApiKeyDirectoryEntry(
  opts: AccountApiKeyDirectoryTouchRequest,
): Promise<void> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    await touchClusterAccountApiKeyDirectoryEntryDirect(opts.key_id);
    return;
  }
  await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).touchApiKey(opts);
}

export async function verifyClusterAccountSignInPassword({
  home_bay_id,
  email_address,
  password,
}: AccountLocalVerifySignInPasswordRequest & {
  home_bay_id: string;
}): Promise<AccountLocalVerifySignInPasswordResult> {
  const targetBay = `${home_bay_id ?? ""}`.trim();
  if (!targetBay || targetBay === currentBayId()) {
    return await verifyLocalSignInPassword({ email_address, password });
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: targetBay,
  }).verifySignInPassword({ email_address, password });
}

export async function assertClusterAccountTrustedForProductAccess({
  account_id,
  action,
}: {
  account_id: string;
  action: string;
}): Promise<void> {
  const account = await getClusterAccountById(account_id);
  if (!account?.home_bay_id || account.home_bay_id === currentBayId()) {
    await assertAccountTrustedForProductAccess(account_id, action);
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: account.home_bay_id,
  }).assertProductAccessTrust({ account_id, action });
}

export async function adminVerifyClusterAccountEmailAddress({
  account_id,
}: {
  account_id: string;
}): Promise<AccountLocalAdminVerifyEmailAddressResult> {
  const account = await getClusterAccountById(account_id);
  if (!account) {
    throw Error(`account ${account_id} not found`);
  }
  const homeBayId = `${account.home_bay_id ?? ""}`.trim();
  if (!homeBayId || homeBayId === currentBayId()) {
    return await adminVerifyEmailAddressLocal({ account_id });
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).adminVerifyEmailAddress({ account_id });
}

export async function adminDisableClusterAccountTwoFactor({
  account_id,
}: {
  account_id: string;
}): Promise<AccountLocalAdminDisableTwoFactorResult> {
  const account = await getClusterAccountById(account_id);
  if (!account) {
    throw Error(`account ${account_id} not found`);
  }
  const homeBayId = `${account.home_bay_id ?? ""}`.trim();
  if (!homeBayId || homeBayId === currentBayId()) {
    return await adminDisableTwoFactorLocal({ account_id });
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).adminDisableTwoFactor({ account_id });
}

export async function setLocalClusterAccountBan({
  account_id,
  banned,
  actor_account_id,
  reason,
  metadata,
}: AccountLocalSetBanRequest): Promise<AccountLocalSetBanResult> {
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  if (banned) {
    await banUser(account_id);
    await quarantineAccountBillingResourcesLocal({
      account_id,
      actor_account_id,
      reason: reason ?? "account ban",
      home_bay_id: currentBayId(),
    });
  } else {
    await removeUserBan(account_id);
  }
  await recordAccountBanAuditEvent({
    account_id,
    action: banned ? "ban" : "unban",
    actor_account_id,
    reason,
    metadata,
  });
  return {
    account_id,
    home_bay_id: currentBayId(),
    banned: !!banned,
  };
}

export async function setClusterAccountBan({
  account_id,
  banned,
  actor_account_id,
  reason,
  metadata,
}: AccountLocalSetBanRequest): Promise<AccountLocalSetBanResult> {
  const normalizedAccountId = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalizedAccountId)) {
    throw new Error("account_id must be a valid uuid");
  }
  const account = await getClusterAccountById(normalizedAccountId);
  if (!account) {
    throw Error(`account ${normalizedAccountId} not found`);
  }
  const homeBayId = `${account.home_bay_id ?? ""}`.trim() || currentBayId();
  const result =
    homeBayId === currentBayId()
      ? await setLocalClusterAccountBan({
          account_id: normalizedAccountId,
          banned,
          actor_account_id,
          reason,
          metadata,
        })
      : await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: homeBayId,
        }).setBan({
          account_id: normalizedAccountId,
          banned,
          actor_account_id,
          reason,
          metadata,
        });
  await updateClusterAccountBanned({
    account_id: normalizedAccountId,
    banned,
  });
  return {
    ...result,
    home_bay_id: homeBayId,
    banned: !!banned,
  };
}

export async function quarantineLocalClusterAccountBillingResources({
  account_id,
  actor_account_id,
  reason,
}: AccountLocalQuarantineBillingResourcesRequest): Promise<AccountLocalQuarantineBillingResourcesResult> {
  const normalizedAccountId = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalizedAccountId)) {
    throw new Error("account_id must be a valid uuid");
  }
  return await quarantineAccountBillingResourcesLocal({
    account_id: normalizedAccountId,
    actor_account_id,
    reason,
    home_bay_id: currentBayId(),
  });
}

export async function quarantineClusterAccountBillingResources({
  account_id,
  actor_account_id,
  reason,
}: AccountLocalQuarantineBillingResourcesRequest): Promise<AccountLocalQuarantineBillingResourcesResult> {
  const normalizedAccountId = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalizedAccountId)) {
    throw new Error("account_id must be a valid uuid");
  }
  const account = await getClusterAccountById(normalizedAccountId);
  if (!account) {
    throw Error(`account ${normalizedAccountId} not found`);
  }
  const homeBayId = `${account.home_bay_id ?? ""}`.trim() || currentBayId();
  if (homeBayId === currentBayId()) {
    return await quarantineLocalClusterAccountBillingResources({
      account_id: normalizedAccountId,
      actor_account_id,
      reason,
    });
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).quarantineBillingResources({
    account_id: normalizedAccountId,
    actor_account_id,
    reason,
  });
}

export async function banClusterAccountAndEquivalentEmails({
  account_id,
  actor_account_id,
  reason,
}: {
  account_id: string;
  actor_account_id?: string | null;
  reason?: string | null;
}): Promise<AccountLocalSetBanResult[]> {
  const normalizedAccountId = `${account_id ?? ""}`.trim().toLowerCase();
  if (!isValidUUID(normalizedAccountId)) {
    throw new Error("account_id must be a valid uuid");
  }
  const account = await getClusterAccountById(normalizedAccountId);
  if (!account) {
    throw Error(`account ${normalizedAccountId} not found`);
  }
  const accountsToBan = new Map<string, AccountDirectoryEntry>();
  accountsToBan.set(normalizedAccountId, account);
  const canonicalEmail = canonicalEmailForBanEquivalence(account.email_address);
  for (const equivalent of await getClusterBanEquivalentEmailAccounts({
    email_address: account.email_address ?? "",
  })) {
    if (equivalent.account_id) {
      accountsToBan.set(equivalent.account_id, equivalent);
    }
  }

  const results: AccountLocalSetBanResult[] = [];
  for (const id of accountsToBan.keys()) {
    results.push(
      await setClusterAccountBan({
        account_id: id,
        banned: true,
        actor_account_id,
        reason,
        metadata: {
          equivalent_email_ban: id !== normalizedAccountId,
          primary_account_id: normalizedAccountId,
          primary_email_address: account.email_address ?? null,
          canonical_email: canonicalEmail ?? null,
        },
      }),
    );
  }
  return results;
}

export async function setClusterAccountPasswordFromReset({
  account_id,
  password,
}: AccountLocalSetPasswordFromResetRequest): Promise<void> {
  const account = await getClusterAccountById(account_id);
  if (!account) {
    throw Error(`account ${account_id} not found`);
  }
  const homeBayId = `${account.home_bay_id ?? ""}`.trim();
  if (!homeBayId || homeBayId === currentBayId()) {
    await setPasswordFromResetLocal({ account_id, password });
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: homeBayId,
  }).setPasswordFromReset({ account_id, password });
}

export async function provisionLocalClusterAccount(
  opts: AccountDirectoryCreateRequest,
): Promise<AccountDirectoryEntry> {
  const account_id = `${opts.account_id ?? ""}`.trim() || uuid();
  await createAccountLocal({
    email: opts.email_address,
    password: opts.password,
    firstName: opts.first_name,
    lastName: opts.last_name,
    account_id,
    owner_id: opts.owner_id,
    home_bay_id: opts.home_bay_id,
    tags: Array.isArray(opts.tags) && opts.tags.length ? opts.tags : undefined,
    signupReason: opts.signup_reason,
    ephemeral: opts.ephemeral,
    customize: opts.customize,
    trusted_product_access: opts.trusted_product_access,
    trusted_product_access_reason: opts.trusted_product_access_reason,
  });
  return (
    (await getClusterAccountByIdDirect(account_id)) ?? {
      account_id,
      email_address: opts.email_address,
      first_name: opts.first_name,
      last_name: opts.last_name,
      home_bay_id: currentBayId(),
    }
  );
}

async function createClusterAccountDirect(
  opts: AccountDirectoryCreateRequest,
): Promise<AccountDirectoryEntry> {
  const email_address = `${opts.email_address ?? ""}`.trim().toLowerCase();
  const home_bay_id = `${opts.home_bay_id ?? ""}`.trim() || currentBayId();
  const account_id = `${opts.account_id ?? ""}`.trim() || uuid();
  const existing = await getClusterAccountByEmailDirect(email_address);
  if (existing?.account_id) {
    throw new Error(`an account with email '${email_address}' already exists`);
  }
  await assertSignupEmailDomainAllowed({ email_address });
  await assertNoClusterBannedEquivalentEmailAccount({ email_address });

  await reserveClusterAccountDirectoryEntry({
    account_id,
    email_address,
    first_name: opts.first_name,
    last_name: opts.last_name,
    home_bay_id,
  });

  try {
    const entry =
      home_bay_id === currentBayId()
        ? await provisionLocalClusterAccount({
            ...opts,
            account_id,
            email_address,
            home_bay_id,
          })
        : await createInterBayAccountLocalClient({
            client: getInterBayFabricClient(),
            dest_bay: home_bay_id,
          }).create({
            ...opts,
            account_id,
            email_address,
            home_bay_id,
          });
    await markClusterAccountProvisioned({
      account_id,
      email_address,
      first_name: entry.first_name ?? opts.first_name,
      last_name: entry.last_name ?? opts.last_name,
      home_bay_id: entry.home_bay_id ?? home_bay_id,
    });
    return {
      ...entry,
      home_bay_id: entry.home_bay_id ?? home_bay_id,
      email_address: entry.email_address ?? email_address,
    };
  } catch (err) {
    await deleteClusterAccountDirectoryEntry(account_id);
    throw err;
  }
}

export async function createClusterAccount(
  opts: AccountDirectoryCreateRequest,
): Promise<AccountDirectoryEntry> {
  const normalized: AccountDirectoryCreateRequest = {
    ...opts,
    email_address: `${opts.email_address ?? ""}`.trim().toLowerCase(),
    home_bay_id: `${opts.home_bay_id ?? ""}`.trim() || currentBayId(),
  };
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await createClusterAccountDirect(normalized);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).create(normalized);
}

async function assertLocalAccountDeleteAllowed({
  account_id,
  only_if_tag,
}: AccountDirectoryDeleteRequest): Promise<void> {
  if (!only_if_tag) return;
  const { rows } = await getPool().query<{ tags: string[] | null }>(
    "SELECT tags FROM accounts WHERE account_id=$1",
    [account_id],
  );
  const tags = rows[0]?.tags ?? [];
  if (!tags.includes(only_if_tag)) {
    throw new Error(
      `refusing to delete account ${account_id}; missing required tag '${only_if_tag}'`,
    );
  }
}

export async function deleteLocalClusterAccount({
  account_id,
  only_if_tag,
}: AccountDirectoryDeleteRequest): Promise<AccountDirectoryDeleteResult> {
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  await assertLocalAccountDeleteAllowed({ account_id, only_if_tag });
  await deleteAccountLocal(account_id);
  return {
    account_id,
    home_bay_id: currentBayId(),
    status: "deleted",
  };
}

async function deleteClusterAccountDirect({
  account_id,
  only_if_tag,
}: AccountDirectoryDeleteRequest): Promise<AccountDirectoryDeleteResult> {
  if (!isValidUUID(account_id)) {
    throw new Error("account_id must be a valid uuid");
  }
  const entry = await getClusterAccountByIdDirect(account_id);
  const home_bay_id = `${entry?.home_bay_id ?? ""}`.trim() || currentBayId();
  const result =
    home_bay_id === currentBayId()
      ? await deleteLocalClusterAccount({ account_id, only_if_tag })
      : await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: home_bay_id,
        }).delete({ account_id, only_if_tag });

  await deleteClusterAccountDirectoryEntry(account_id);
  return {
    ...result,
    home_bay_id,
  };
}

export async function deleteClusterAccount(
  opts: AccountDirectoryDeleteRequest,
): Promise<AccountDirectoryDeleteResult> {
  if (!isMultiBayCluster() || getConfiguredClusterRole() === "seed") {
    return await deleteClusterAccountDirect(opts);
  }
  return await createInterBayAccountDirectoryClient({
    client: getInterBayFabricClient(),
  }).delete(opts);
}
