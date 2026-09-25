/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { isValidUUID } from "@cocalc/util/misc";
import type { ApiKeyScope } from "@cocalc/util/db-schema/api-keys";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getClusterAccountById } from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { effectiveApiKeyScope } from "./api-key-scope";
import { ensureApiKeysV2Schema } from "./manage";

export interface ApiKeyAuthorizationState {
  scope: ApiKeyScope;
  scope_revision: number;
  expire_ms?: number;
}

export async function getApiKeyAuthorizationStateLocal({
  account_id,
  key_id,
}: {
  account_id: string;
  key_id: string;
}): Promise<ApiKeyAuthorizationState | null> {
  if (!isValidUUID(account_id) || !/^[A-Za-z0-9_-]{8,128}$/.test(key_id)) {
    return null;
  }
  const owner = await getClusterAccountById(account_id);
  if (owner?.home_bay_id !== getConfiguredBayId()) return null;
  await ensureApiKeysV2Schema();
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id)) return null;
  const { rows } = await getPool().query(
    `SELECT scope, scope_revision, capabilities, allowed_project_ids, expire
       FROM api_keys WHERE account_id=$1 AND key_id=$2 LIMIT 1`,
    [account_id, key_id],
  );
  const row = rows[0];
  if (!row) return null;
  const expire_ms =
    row.expire == null ? undefined : new Date(row.expire).getTime();
  const scope_revision = Number(row.scope_revision);
  if (
    (expire_ms != null &&
      (!Number.isFinite(expire_ms) || expire_ms <= Date.now())) ||
    !Number.isSafeInteger(scope_revision) ||
    scope_revision < 1
  ) {
    return null;
  }
  try {
    return {
      scope: effectiveApiKeyScope({
        scope: row.scope,
        capabilities: row.capabilities ?? [],
        allowed_project_ids: row.allowed_project_ids ?? [],
      }),
      scope_revision,
      ...(expire_ms == null ? {} : { expire_ms }),
    };
  } catch {
    return null;
  }
}

export async function getApiKeyAuthorizationState(opts: {
  account_id: string;
  key_id: string;
}): Promise<ApiKeyAuthorizationState | null> {
  const account = await getClusterAccountById(opts.account_id);
  const home = account?.home_bay_id;
  if (!home) {
    throw new Error("unable to resolve API key account home");
  }
  if (home === getConfiguredBayId()) {
    return await getApiKeyAuthorizationStateLocal(opts);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: home,
    timeout: 5_000,
  }).getApiKeyAuthorizationState(opts);
}
