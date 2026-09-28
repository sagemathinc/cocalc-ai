/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import { withAccountRehomeWriteFence } from "@cocalc/database/postgres/account-rehome-fence";
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
import { normalizeApiKeyIssuanceSequence } from "./issuance-sequence";

export interface ApiKeyAuthorizationState {
  hash: string;
  scope: ApiKeyScope;
  scope_revision: number;
  issuance_sequence: string;
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
    `SELECT hash, scope, scope_revision, capabilities, allowed_project_ids, expire,
            COALESCE(issuance_sequence,0)::text AS issuance_sequence
       FROM api_keys WHERE account_id=$1 AND key_id=$2 LIMIT 1`,
    [account_id, key_id],
  );
  const row = rows[0];
  if (!row) return null;
  const expire_ms =
    row.expire == null ? undefined : new Date(row.expire).getTime();
  const scope_revision = Number(row.scope_revision);
  if (
    typeof row.hash !== "string" ||
    !row.hash ||
    (expire_ms != null &&
      (!Number.isFinite(expire_ms) || expire_ms <= Date.now())) ||
    !Number.isSafeInteger(scope_revision) ||
    scope_revision < 1
  ) {
    return null;
  }
  try {
    return {
      hash: row.hash,
      scope: effectiveApiKeyScope({
        scope: row.scope,
        capabilities: row.capabilities ?? [],
        allowed_project_ids: row.allowed_project_ids ?? [],
      }),
      scope_revision,
      issuance_sequence: normalizeApiKeyIssuanceSequence(row.issuance_sequence),
      ...(expire_ms == null ? {} : { expire_ms }),
    };
  } catch {
    return null;
  }
}

// Internal bay-to-bay operation, not a browser or API-key authority surface.
export async function getApiKeyIssuanceWatermarkLocal({
  account_id,
}: {
  account_id: string;
}): Promise<string> {
  if (!isValidUUID(account_id)) throw Error("invalid account id");
  const owner = await getClusterAccountById(account_id);
  if (owner?.home_bay_id !== getConfiguredBayId())
    throw Error("API key account home changed");
  await ensureApiKeysV2Schema();
  return await withAccountRehomeWriteFence({
    account_id,
    action: "read API key issuance watermark",
    fn: async (db) => {
      const { rows } = await db.query(
        `SELECT COALESCE(api_key_issuance_sequence,0)::text AS sequence
         FROM accounts WHERE account_id=$1 AND deleted IS NOT TRUE FOR UPDATE`,
        [account_id],
      );
      return normalizeApiKeyIssuanceSequence(rows[0]?.sequence);
    },
  });
}

export async function getApiKeyIssuanceWatermark(opts: {
  account_id: string;
}): Promise<string> {
  const account = await getClusterAccountById(opts.account_id);
  const home = account?.home_bay_id;
  if (!home) throw Error("unable to resolve API key account home");
  const value =
    home === getConfiguredBayId()
      ? await getApiKeyIssuanceWatermarkLocal(opts)
      : await createInterBayAccountLocalClient({
          client: getInterBayFabricClient(),
          dest_bay: home,
          timeout: 5_000,
        }).getApiKeyIssuanceWatermark(opts);
  return normalizeApiKeyIssuanceSequence(value);
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
