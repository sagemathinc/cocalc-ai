/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import getPool from "@cocalc/database/pool";
import type { Pool, PoolClient } from "@cocalc/database/pool";
import { apiKeyScopeAllows } from "@cocalc/util/api-key-scope";
import {
  apiKeyActionExpiresAt,
  normalizeApiKeyActionBinding,
  normalizeApiKeyActionRequest,
} from "@cocalc/util/api-key-management";
import type {
  ApiKeyActionReview,
  ApiKeyActionPrincipal,
  ApiKeyActionDecision,
} from "@cocalc/util/api-key-management";
import { isValidUUID } from "@cocalc/util/misc";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  getClusterAccountById,
  deleteClusterAccountApiKeyDirectoryEntry,
} from "@cocalc/server/inter-bay/accounts";
import { requireDangerousSessionAuth } from "@cocalc/server/conat/api/dangerous-session-auth";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import { ensureApiKeysV2Schema } from "./manage";
import { effectiveApiKeyScope } from "./api-key-scope";
import { ApiKeyActionStore } from "./key-action-store";

const CAPABILITY = "api-key:revoke:request";

export async function listApiKeyActionsLocal(opts: {
  account_id: string;
  session_hash: string;
}): Promise<ApiKeyActionReview[]> {
  await assertHome(opts.account_id);
  if (!opts.session_hash) throw new Error("human authentication required");
  await requireDangerousSessionAuth({
    ...opts,
    require_second_factor: true,
    allow_actor_impersonation: false,
  });
  const store = new ApiKeyActionStore(getPool());
  await store.ensureSchema();
  return store.listPending(opts.account_id);
}

async function assertHome(account_id: string): Promise<void> {
  if (!isValidUUID(account_id)) throw new Error("invalid API key action owner");
  const account = await getClusterAccountById(account_id);
  if (account?.home_bay_id !== getConfiguredBayId())
    throw new Error("API key actions require account home");
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(account_id))
    throw new Error("API key action owner is unavailable");
}

async function keyRow(
  db: Pool | PoolClient,
  account_id: string,
  key_id: string,
  lock = false,
): Promise<any> {
  const { rows } = await db.query(
    `SELECT id,key_id,account_id,name,trunc,scope,scope_revision,
    capabilities,allowed_project_ids,expire,
    (expire IS NULL OR expire > clock_timestamp()) AS live
    FROM api_keys WHERE account_id=$1 AND key_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [account_id, key_id],
  );
  if (!rows[0]) throw new Error("API key action credential is unavailable");
  return rows[0];
}

function assertRequester(row: any, revision: number): void {
  if (
    !row.live ||
    row.scope_revision !== revision ||
    !apiKeyScopeAllows(effectiveApiKeyScope(row), CAPABILITY)
  ) {
    throw new Error(
      "requesting API key expired, changed, or lacks management request scope",
    );
  }
}

async function assertManualTarget(
  db: Pool | PoolClient,
  key_id: string,
): Promise<void> {
  // Ordinary manual-key operation does not depend on agent tables being installed.
  const { rows: tables } = await db.query(
    "SELECT to_regclass('public.agent_cocalc_connector_turns') AS name",
  );
  if (!tables[0]?.name) return;
  const { rows } = await db.query(
    "SELECT 1 FROM agent_cocalc_connector_turns WHERE key_id=$1 LIMIT 1",
    [key_id],
  );
  if (rows.length)
    throw new Error("management action target must be a manual API key");
}

async function validateLocked(
  db: PoolClient,
  review: ApiKeyActionReview,
): Promise<void> {
  const binding = review.binding;
  await assertHome(binding.account_id);
  const requester = await keyRow(
    db,
    binding.account_id,
    binding.requesting_key_id,
    true,
  );
  assertRequester(requester, binding.requesting_scope_revision);
  if (review.status !== "pending") return;
  const target = await keyRow(
    db,
    binding.account_id,
    binding.target_key_id,
    true,
  );
  if (
    target.scope_revision !== binding.target_scope_revision ||
    `${target.name ?? ""}` !== review.target_name ||
    `${target.trunc ?? ""}` !== review.target_trunc
  ) {
    throw new Error("target API key changed since review");
  }
  await assertManualTarget(db, target.key_id);
}

// Only the authenticated HTTP/inter-bay adapter may supply principal. There is
// intentionally no public Hub RPC for nominating a requesting key identity.
export async function requestApiKeyActionLocal(
  principal: ApiKeyActionPrincipal,
  input: unknown,
): Promise<ApiKeyActionReview> {
  if (principal.auth_method !== "api_key")
    throw new Error("API key authentication required");
  const request = normalizeApiKeyActionRequest(input);
  await assertHome(principal.account_id);
  await ensureApiKeysV2Schema();
  const pool = getPool();
  const store = new ApiKeyActionStore(pool);
  await store.ensureSchema();
  const requester = await keyRow(pool, principal.account_id, principal.key_id);
  assertRequester(requester, principal.scope_revision!);
  const target = await keyRow(
    pool,
    principal.account_id,
    request.action.target_key_id,
  );
  await assertManualTarget(pool, target.key_id);
  const binding = normalizeApiKeyActionBinding({
    account_id: principal.account_id,
    requesting_key_id: principal.key_id,
    requesting_scope_revision: requester.scope_revision,
    target_key_id: target.key_id,
    target_scope_revision: target.scope_revision,
  });
  const now = Date.now();
  const review: ApiKeyActionReview = {
    ...request,
    binding,
    target_name: `${target.name ?? ""}`,
    target_trunc: `${target.trunc ?? ""}`,
    created_at: now,
    expires_at: apiKeyActionExpiresAt(
      now,
      requester.expire == null
        ? undefined
        : new Date(requester.expire).getTime(),
    ),
    status: "pending",
  };
  return store.create(review, validateLocked);
}

export async function decideApiKeyActionLocal({
  account_id,
  session_hash,
  reviewed,
  decision,
}: ApiKeyActionDecision): Promise<ApiKeyActionReview> {
  if (reviewed.binding.account_id !== account_id)
    throw new Error("API key action owner mismatch");
  await assertHome(account_id);
  const fresh = async () => {
    if (!session_hash) throw new Error("human authentication required");
    await requireDangerousSessionAuth({
      account_id,
      session_hash,
      require_second_factor: true,
      allow_actor_impersonation: false,
    });
  };
  await fresh();
  await ensureApiKeysV2Schema();
  const store = new ApiKeyActionStore(getPool());
  await store.ensureSchema();
  const result = await store.decide({
    reviewed,
    decision,
    authorize: async (db, review) => {
      await fresh();
      await validateLocked(db, review);
    },
    execute: async (db, review) => {
      await db.query(
        "DELETE FROM api_keys WHERE account_id=$1 AND key_id=$2 AND scope_revision=$3",
        [
          account_id,
          review.binding.target_key_id,
          review.binding.target_scope_revision,
        ],
      );
    },
  });
  if (result.status === "executed") {
    // Remote authorization consults account home, so the committed deletion is
    // effective even if directory cleanup fails. Retrying only repeats cleanup.
    await deleteClusterAccountApiKeyDirectoryEntry({
      account_id,
      key_id: result.binding.target_key_id,
      home_bay_id: getConfiguredBayId(),
    });
  }
  return result;
}
