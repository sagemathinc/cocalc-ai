/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { v4 as uuid } from "uuid";
import {
  createInterBayAccountDirectoryClient,
  createInterBayAccountLocalClient,
  type AccountDirectoryCreateRequest,
  type AccountDirectoryEntry,
} from "@cocalc/conat/inter-bay/api";
import createAccountLocal from "@cocalc/server/accounts/create-account";
import {
  deleteClusterAccountDirectoryEntry,
  getClusterAccountByEmailDirect,
  getClusterAccountByIdDirect,
  getClusterAccountHomeBayCountsDirect,
  getClusterAccountsByIdsDirect,
  markClusterAccountProvisioned,
  reserveClusterAccountDirectoryEntry,
  searchClusterAccountsDirect,
} from "@cocalc/server/accounts/cluster-directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getConfiguredClusterRole,
  isMultiBayCluster,
} from "@cocalc/server/cluster-config";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";

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
    noFirstProject: !!opts.no_first_project,
    tags: Array.isArray(opts.tags) && opts.tags.length ? opts.tags : undefined,
    signupReason: opts.signup_reason,
    ephemeral: opts.ephemeral,
    customize: opts.customize,
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

  await reserveClusterAccountDirectoryEntry({
    account_id,
    email_address,
    first_name: opts.first_name,
    last_name: opts.last_name,
    name: undefined,
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
      name: entry.name,
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
