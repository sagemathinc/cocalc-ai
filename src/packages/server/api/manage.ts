/*
This supports four actions:

- get: get the already created keys associated to an account
- delete: delete a specific key given by an id
- create: create a new api key associated to an account
- edit: edit an existing api key: you can change the name and expiration date

If the user has a password, then it must be provided and be correct. If
they have no password, then the provided one is ignored.
*/

import getPool from "@cocalc/database/pool";
import { randomBytes } from "node:crypto";
import passwordHash, {
  verifyPassword,
} from "@cocalc/backend/auth/password-hash";
import { getLogger } from "@cocalc/backend/logger";
import isValidAccount from "@cocalc/server/accounts/is-valid-account";
import type {
  ApiKey as ApiKeyType,
  Action as ApiKeyAction,
  ApiKeyCapability,
  ApiKeyScope,
} from "@cocalc/util/db-schema/api-keys";
import { normalizeApiKeyScopeV1 } from "@cocalc/util/api-key-scope";
import {
  ensureAccountSecurityStateReady,
  isAccountBannedCached,
} from "@cocalc/server/accounts/security-state";
import {
  getClusterAccountApiKeyByKeyId,
  getClusterAccountById,
  touchClusterAccountApiKeyDirectoryEntry,
  upsertClusterAccountApiKeyDirectoryEntry,
  deleteClusterAccountApiKeyDirectoryEntry,
} from "@cocalc/server/inter-bay/accounts";
import {
  type ApiKeyPrincipal,
  effectiveApiKeyScope,
  normalizeApiKeyScope,
} from "./api-key-scope";
import { assertAccountTrustedForProductAccess } from "@cocalc/server/accounts/trusted-product-access";
import {
  recordApiKeyAuditEvent,
  recordApiKeyAuditEventSoon,
} from "./api-key-audit";

const log = getLogger("server:api:manage");

// Global per user limit to avoid abuse/bugs. Nobody should ever hit this.
const MAX_API_KEYS = 100000;
const API_KEY_V2_PREFIX = "sk-cc-v2";
const API_KEY_V2_LEGACY_PREFIXES = new Set(["sk-cocalc-v2"]);
const API_KEY_ID_BYTES = 12;
const API_KEY_SECRET_BYTES = 32;

let apiKeysV2SchemaReady: Promise<void> | undefined;

export async function ensureApiKeysV2Schema(): Promise<void> {
  apiKeysV2SchemaReady ??= (async () => {
    const pool = getPool();
    await pool.query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_id TEXT",
    );
    await pool.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx ON api_keys(key_id)",
    );
    await pool.query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}'::TEXT[]",
    );
    await pool.query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_project_ids UUID[] NOT NULL DEFAULT '{}'::UUID[]",
    );
    await pool.query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope JSONB",
    );
    await pool.query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scope_revision INTEGER NOT NULL DEFAULT 1",
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS api_keys_capabilities_gin_idx ON api_keys USING GIN(capabilities)",
    );
    await pool.query(
      "CREATE INDEX IF NOT EXISTS api_keys_allowed_project_ids_gin_idx ON api_keys USING GIN(allowed_project_ids)",
    );
  })();
  return await apiKeysV2SchemaReady;
}

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function createApiKeySecret({ key_id }: { key_id: string }): string {
  return `${API_KEY_V2_PREFIX}.${key_id}.${randomBase64Url(API_KEY_SECRET_BYTES)}`;
}

function parseApiKeyV2(secret: string): { key_id: string } | undefined {
  const parts = `${secret ?? ""}`.split(".");
  if (
    parts.length !== 3 ||
    (parts[0] !== API_KEY_V2_PREFIX &&
      !API_KEY_V2_LEGACY_PREFIXES.has(parts[0]))
  ) {
    return undefined;
  }
  const key_id = parts[1]?.trim();
  const secretPart = parts[2]?.trim();
  if (!key_id || !secretPart) {
    return undefined;
  }
  return { key_id };
}

function truncApiKey(secret: string): string {
  return `${secret.slice(0, 5)}...${secret.slice(-8)}`;
}

async function syncAccountApiKeyDirectory({
  key_id,
  account_id,
  hash,
  capabilities,
  allowed_project_ids,
  scope,
  scope_revision,
  expire,
  last_active,
}: {
  key_id?: string | null;
  account_id: string;
  hash: string;
  capabilities: ApiKeyCapability[];
  allowed_project_ids: string[];
  scope?: ApiKeyScope | null;
  scope_revision?: number;
  expire?: Date | null;
  last_active?: Date | null;
}): Promise<void> {
  const normalizedKeyId = `${key_id ?? ""}`.trim();
  if (!normalizedKeyId) return;
  const account = await getClusterAccountById(account_id);
  const home_bay_id = `${account?.home_bay_id ?? ""}`.trim();
  if (!home_bay_id) {
    throw new Error(`unable to resolve home bay for account ${account_id}`);
  }
  await upsertClusterAccountApiKeyDirectoryEntry({
    key_id: normalizedKeyId,
    account_id,
    home_bay_id,
    hash,
    capabilities,
    allowed_project_ids,
    scope,
    scope_revision,
    expire: expire == null ? null : new Date(expire).valueOf(),
    last_active: last_active == null ? null : new Date(last_active).valueOf(),
  });
}

interface Options {
  account_id: string;
  action: ApiKeyAction;
  name?: string;
  expire?: Date | null;
  capabilities?: ApiKeyCapability[];
  allowed_project_ids?: string[];
  scope?: ApiKeyScope;
  id?: number;
}

// this does NOT trust its input.
export default async function manageApiKeys({
  account_id,
  action,
  name,
  expire,
  capabilities,
  allowed_project_ids,
  scope,
  id,
}: Options): Promise<undefined | ApiKeyType[]> {
  log.debug("manage", {
    account_id,
    action,
    name,
    expire,
    capabilities,
    allowed_project_ids,
    scope,
    id,
  });
  if (!(await isValidAccount(account_id))) {
    throw Error("account_id is not a valid account");
  }

  return await doManageApiKeys({
    action,
    account_id,
    name,
    expire,
    capabilities,
    allowed_project_ids,
    scope,
    id,
  });
}

// Return all api keys for the given account_id.
// No security checks.
async function getApiKeys(account_id: string): Promise<ApiKeyType[]> {
  log.debug("getApiKeys", account_id);
  const pool = getPool();
  await ensureApiKeysV2Schema();
  const { rows } = await pool.query(
    "SELECT id,key_id,account_id,expire,created,name,trunc,capabilities,allowed_project_ids,scope,scope_revision,last_active FROM api_keys WHERE account_id=$1::UUID ORDER BY created DESC",
    [account_id],
  );
  return rows;
}

async function getApiKey({ id, account_id }) {
  const pool = getPool();
  await ensureApiKeysV2Schema();
  const { rows } = await pool.query(
    "SELECT id,key_id,account_id,expire,created,name,trunc,capabilities,allowed_project_ids,scope,scope_revision,last_active FROM api_keys WHERE id=$1 AND account_id=$2",
    [id, account_id],
  );
  return rows[0];
}

// We require the account_id here even though the id would technically suffice,
// so a user can't just delete random api keys they don't own.
async function deleteApiKey({ account_id, id }) {
  const pool = getPool();
  const existing = await getApiKey({ id, account_id });
  await pool.query("DELETE FROM api_keys WHERE account_id=$1 AND id=$2", [
    account_id,
    id,
  ]);
  await deleteClusterAccountApiKeyDirectoryEntry({
    key_id: `${existing?.key_id ?? ""}`.trim(),
  });
  if (existing != null) {
    await recordApiKeyAuditEvent({
      event: "api_key_deleted",
      value: {
        account_id,
        api_key_id: existing.id,
        key_id: existing.key_id,
        source: "account-api-key-management",
      },
    });
  }
}

async function numKeys(account_id: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    "SELECT COUNT(*) AS count FROM api_keys WHERE account_id=$1",
    [account_id],
  );
  return rows[0].count;
}

async function createApiKey({
  account_id,
  expire,
  name,
  capabilities,
  allowed_project_ids,
  scope: requestedScope,
}: {
  account_id: string;
  expire?: Date | null;
  name: string;
  capabilities?: ApiKeyCapability[];
  allowed_project_ids?: string[];
  scope?: ApiKeyScope;
}): Promise<ApiKeyType> {
  await assertAccountTrustedForProductAccess(account_id, "create API keys");
  const pool = getPool();
  await ensureApiKeysV2Schema();
  if (
    requestedScope != null &&
    (capabilities != null || allowed_project_ids != null)
  ) {
    throw Error(
      "provide either versioned scope or legacy capabilities, not both",
    );
  }
  const scope =
    requestedScope == null
      ? normalizeApiKeyScope({ capabilities, allowed_project_ids })
      : { capabilities: [], allowed_project_ids: [] };
  const canonicalScope =
    requestedScope == null ? null : normalizeApiKeyScopeV1(requestedScope);
  if ((await numKeys(account_id)) >= MAX_API_KEYS) {
    throw Error(
      `There is a limit of ${MAX_API_KEYS} per account; please delete some api keys.`,
    );
  }
  const { rows } = await pool.query(
    "INSERT INTO api_keys(account_id,created,expire,name,key_id,capabilities,allowed_project_ids,scope) VALUES($1,NOW(),$2,$3,$4,$5,$6,$7::JSONB) RETURNING id,key_id,account_id,expire,created,name,capabilities,allowed_project_ids,scope,scope_revision,last_active",
    [
      account_id,
      expire,
      name,
      randomBase64Url(API_KEY_ID_BYTES),
      scope.capabilities,
      scope.allowed_project_ids,
      canonicalScope == null ? null : JSON.stringify(canonicalScope),
    ],
  );
  const { id, key_id } = rows[0];
  // Note that passwordHash is NOT a "function" -- due to salt every time you call it, the output is different!
  // Thus we have to do this little trick.
  // v2 keys use a random key_id for lookup, not the local integer id.
  const secret = createApiKeySecret({ key_id });
  const trunc = truncApiKey(secret);
  const hash = passwordHash(secret);
  await pool.query("UPDATE api_keys SET trunc=$1,hash=$2 WHERE id=$3", [
    trunc,
    hash,
    id,
  ]);
  await syncAccountApiKeyDirectory({
    key_id,
    account_id,
    hash,
    capabilities: scope.capabilities,
    allowed_project_ids: scope.allowed_project_ids,
    scope: canonicalScope,
    scope_revision: 1,
    expire: expire ?? null,
    last_active: null,
  });
  await recordApiKeyAuditEvent({
    event: "api_key_created",
    value: {
      account_id,
      api_key_id: id,
      key_id,
      source: "account-api-key-management",
    },
  });
  return { ...rows[0], trunc, secret };
}

async function updateApiKey({ apiKey, account_id }) {
  log.debug("udpateApiKey", apiKey);
  const pool = getPool();
  const {
    id,
    key_id,
    expire,
    name,
    capabilities,
    allowed_project_ids,
    scope,
    last_active,
  } = apiKey;
  const { rows: updatedRows } = await pool.query(
    "UPDATE api_keys SET expire=$3,name=$4,capabilities=$5,allowed_project_ids=$6,scope=$7::JSONB,last_active=$8,scope_revision=scope_revision+1 WHERE id=$1 AND account_id=$2 RETURNING scope_revision",
    [
      id,
      account_id,
      expire,
      name,
      capabilities,
      allowed_project_ids,
      scope == null ? null : JSON.stringify(scope),
      last_active,
    ],
  );
  if (!updatedRows[0]) {
    throw Error("API key was deleted during edit");
  }
  const { rows } = await pool.query(
    "SELECT hash FROM api_keys WHERE id=$1 AND account_id=$2",
    [id, account_id],
  );
  const hash = `${rows[0]?.hash ?? ""}`.trim();
  if (hash) {
    await syncAccountApiKeyDirectory({
      key_id,
      account_id,
      hash,
      capabilities,
      allowed_project_ids,
      scope,
      scope_revision: Number(updatedRows[0].scope_revision),
      expire: expire ?? null,
      last_active: last_active ?? null,
    });
  }
}

//api_key.slice(0, 3) + "..." + api_key.slice(-4)
// This function does no auth checks.
async function doManageApiKeys({
  action,
  account_id,
  name,
  expire,
  capabilities,
  allowed_project_ids,
  scope,
  id,
}) {
  switch (action) {
    case "get":
      if (!id) {
        return await getApiKeys(account_id);
      } else {
        return [await getApiKey({ id, account_id })];
      }

    case "delete":
      // delete key with given id
      await deleteApiKey({ account_id, id });
      break;

    case "create":
      // creates a key with given name (if given)
      return [
        await createApiKey({
          account_id,
          name,
          expire,
          capabilities,
          allowed_project_ids,
          scope,
        }),
      ];

    case "edit": // change the name or expire time
      const apiKey = await getApiKey({ id, account_id });
      if (apiKey == null) {
        throw Error(`no api key with id ${id}`);
      }
      let changed = false;
      if (name != null && apiKey.name != name) {
        apiKey.name = name;
        changed = true;
      }
      if (expire !== undefined && apiKey.expire != expire) {
        apiKey.expire = expire;
        changed = true;
      }
      if (
        scope !== undefined &&
        (capabilities !== undefined || allowed_project_ids !== undefined)
      ) {
        throw Error(
          "provide either versioned scope or legacy capabilities, not both",
        );
      }
      if (scope !== undefined) {
        apiKey.scope = normalizeApiKeyScopeV1(scope);
        apiKey.capabilities = [];
        apiKey.allowed_project_ids = [];
        changed = true;
      } else if (
        capabilities !== undefined ||
        allowed_project_ids !== undefined
      ) {
        if (apiKey.scope != null) {
          throw Error("edit versioned keys using the versioned scope");
        }
        const scope = normalizeApiKeyScope({
          capabilities: capabilities ?? apiKey.capabilities,
          allowed_project_ids:
            allowed_project_ids ?? apiKey.allowed_project_ids,
        });
        apiKey.capabilities = scope.capabilities;
        apiKey.allowed_project_ids = scope.allowed_project_ids;
        changed = true;
      }
      if (changed) {
        await updateApiKey({ apiKey, account_id });
      }
      break;
  }
}

/*
Get the account that has the given api key,
or returns undefined if there is no such account, or if the account
that owns the api key is banned.

Record that access happened by updating last_active.
*/
export async function getAccountWithApiKey(
  secret: string,
): Promise<ApiKeyPrincipal | undefined> {
  log.debug("getAccountWithApiKey");
  const pool = getPool("medium");
  await ensureApiKeysV2Schema();

  const v2 = parseApiKeyV2(secret);
  if (!v2) {
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        source: "api-key-auth",
        reason: "invalid API key format",
        code: "api_key_invalid_format",
      },
    });
    return undefined;
  }
  const { rows } = await pool.query(
    "SELECT id,key_id,account_id,hash,expire,capabilities,allowed_project_ids,scope,scope_revision FROM api_keys WHERE key_id=$1",
    [v2.key_id],
  );
  if (rows.length > 0) {
    return await checkApiKeyRows({ rows, secret, key_id: v2.key_id });
  }
  return await checkClusterAccountApiKeyDirectoryEntry({
    secret,
    key_id: v2.key_id,
  });
}

async function checkApiKeyRows({
  rows,
  secret,
  key_id,
}: {
  rows: any[];
  secret: string;
  key_id: string;
}): Promise<ApiKeyPrincipal | undefined> {
  if (rows.length == 0) return undefined;
  await ensureAccountSecurityStateReady();
  if (isAccountBannedCached(rows[0].account_id)) {
    log.debug("getAccountWithApiKey: banned api key ", rows[0]?.account_id);
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        account_id: rows[0].account_id,
        api_key_id: rows[0].id,
        key_id: rows[0].key_id ?? key_id,
        source: "api-key-auth-local",
        reason: "account is banned",
        code: "api_key_account_banned",
      },
    });
    return;
  }
  if (verifyPassword(secret, rows[0].hash)) {
    const { expire } = rows[0];
    if (expire != null && expire.valueOf() <= Date.now()) {
      // expired entries will get automatically deleted eventually by database
      // maintenance, but we obviously shouldn't depend on that.
      await deleteApiKey(rows[0]);
      recordApiKeyAuditEventSoon({
        event: "api_key_denied",
        value: {
          account_id: rows[0].account_id,
          api_key_id: rows[0].id,
          key_id: rows[0].key_id ?? key_id,
          source: "api-key-auth-local",
          reason: "API key is expired",
          code: "api_key_expired",
        },
      });
      return undefined;
    }
    let scope: ApiKeyScope;
    const scopeRevision = Number(rows[0].scope_revision ?? 1);
    try {
      if (!Number.isSafeInteger(scopeRevision) || scopeRevision < 1) {
        throw Error("invalid API key scope revision");
      }
      scope = effectiveApiKeyScope({
        scope: rows[0].scope,
        capabilities: rows[0].capabilities ?? [],
        allowed_project_ids: rows[0].allowed_project_ids ?? [],
      });
    } catch {
      recordApiKeyAuditEventSoon({
        event: "api_key_denied",
        value: {
          account_id: rows[0].account_id,
          api_key_id: rows[0].id,
          key_id,
          source: "api-key-auth-local",
          code: "api_key_invalid_scope",
        },
      });
      return undefined;
    }

    // Yes, caller definitely has a valid key.
    await getPool("medium").query(
      "UPDATE api_keys SET last_active=NOW() WHERE id=$1",
      [rows[0].id],
    );
    if (rows[0].account_id) {
      await touchClusterAccountApiKeyDirectoryEntry({ key_id });
      recordApiKeyAuditEventSoon({
        event: "api_key_used",
        value: {
          account_id: rows[0].account_id,
          api_key_id: rows[0].id,
          key_id: rows[0].key_id ?? key_id,
          source: "api-key-auth-local",
        },
      });
      return {
        account_id: rows[0].account_id,
        api_key_id: rows[0].id,
        key_id: rows[0].key_id,
        auth_method: "api_key",
        capabilities: rows[0].capabilities ?? [],
        allowed_project_ids: rows[0].allowed_project_ids ?? [],
        scope,
        scope_revision: scopeRevision,
        ...(expire == null ? {} : { expire_ms: expire.valueOf() }),
      };
    }
  }
  recordApiKeyAuditEventSoon({
    event: "api_key_denied",
    value: {
      account_id: rows[0]?.account_id,
      api_key_id: rows[0]?.id,
      key_id: rows[0]?.key_id ?? key_id,
      source: "api-key-auth-local",
      reason: "API key secret does not match",
      code: "api_key_secret_mismatch",
    },
  });
  return undefined;
}

async function checkClusterAccountApiKeyDirectoryEntry({
  secret,
  key_id,
}: {
  secret: string;
  key_id: string;
}): Promise<ApiKeyPrincipal | undefined> {
  const v2 = parseApiKeyV2(secret);
  if (!v2) return undefined;
  const entry = await getClusterAccountApiKeyByKeyId(v2.key_id);
  if (!entry?.account_id || !entry.hash) {
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        key_id,
        source: "api-key-auth-directory",
        reason: "API key not found",
        code: "api_key_not_found",
      },
    });
    return undefined;
  }
  const account = await getClusterAccountById(entry.account_id);
  await ensureAccountSecurityStateReady();
  if (account?.banned || isAccountBannedCached(entry.account_id)) {
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        account_id: entry.account_id,
        key_id: entry.key_id,
        source: "api-key-auth-directory",
        reason: "account is banned",
        code: "api_key_account_banned",
      },
    });
    return undefined;
  }
  if (!verifyPassword(secret, entry.hash)) {
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        account_id: entry.account_id,
        key_id: entry.key_id,
        source: "api-key-auth-directory",
        reason: "API key secret does not match",
        code: "api_key_secret_mismatch",
      },
    });
    return undefined;
  }
  if (entry.expire != null && entry.expire <= Date.now()) {
    await deleteClusterAccountApiKeyDirectoryEntry({ key_id: v2.key_id });
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        account_id: entry.account_id,
        key_id: entry.key_id,
        source: "api-key-auth-directory",
        reason: "API key is expired",
        code: "api_key_expired",
      },
    });
    return undefined;
  }
  let scope: ApiKeyScope;
  const scopeRevision = Number(entry.scope_revision ?? 1);
  try {
    if (!Number.isSafeInteger(scopeRevision) || scopeRevision < 1) {
      throw Error("invalid API key scope revision");
    }
    scope = effectiveApiKeyScope({
      scope: entry.scope ?? undefined,
      capabilities: (entry.capabilities ?? []) as ApiKeyCapability[],
      allowed_project_ids: entry.allowed_project_ids ?? [],
    });
  } catch {
    recordApiKeyAuditEventSoon({
      event: "api_key_denied",
      value: {
        account_id: entry.account_id,
        key_id: entry.key_id,
        source: "api-key-auth-directory",
        code: "api_key_invalid_scope",
      },
    });
    return undefined;
  }
  await touchClusterAccountApiKeyDirectoryEntry({ key_id: v2.key_id });
  recordApiKeyAuditEventSoon({
    event: "api_key_used",
    value: {
      account_id: entry.account_id,
      api_key_id: -1,
      key_id: entry.key_id,
      source: "api-key-auth-directory",
    },
  });
  return {
    account_id: entry.account_id,
    api_key_id: -1,
    key_id: entry.key_id,
    auth_method: "api_key",
    capabilities: (entry.capabilities ?? []) as ApiKeyCapability[],
    allowed_project_ids: entry.allowed_project_ids ?? [],
    scope,
    scope_revision: scopeRevision,
    ...(entry.expire == null ? {} : { expire_ms: entry.expire }),
  };
}
