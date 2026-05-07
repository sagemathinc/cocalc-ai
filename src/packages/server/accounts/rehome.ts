/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import getPool from "@cocalc/database/pool";
import type {
  AccountMembershipPortableState,
  AccountRehomeAcceptRequest,
  AccountRehomeOperationStage,
  AccountRehomeOperationStatus,
  AccountRehomeOperationSummary,
  AccountRehomeRequest,
  AccountRehomeResponse,
  AccountRehomeStateCopyRequest,
} from "@cocalc/conat/inter-bay/api";
import { createBrowserSessionClient } from "@cocalc/conat/service/browser-session";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { lockAccountRehomeFence } from "@cocalc/server/accounts/rehome-fence";
import {
  getBayPublicOrigin,
  getClusterBayPublicOrigins,
} from "@cocalc/server/bay-public-origin";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import {
  listConfiguredBays,
  resolveAccountHomeBay,
} from "@cocalc/server/bay-directory";
import { listClusterBayRegistry } from "@cocalc/server/bay-registry";
import { listBrowserSessionsForAccount } from "@cocalc/server/conat/api/browser-sessions";
import { getLiveBrowserSessionInfo } from "@cocalc/server/conat/api/browser-sessions-live";
import {
  getClusterAccountById,
  updateClusterAccountApiKeysHomeBay,
  updateClusterAccountHomeBay,
} from "@cocalc/server/inter-bay/accounts";
import { getInterBayFabricClient } from "@cocalc/server/inter-bay/fabric";
import { createInterBayAccountLocalClient } from "@cocalc/conat/inter-bay/api";
import { isValidUUID } from "@cocalc/util/misc";

const log = getLogger("server:accounts:rehome");
const ACCOUNT_REHOME_OPERATIONS_TABLE = "account_rehome_operations";
const ACCOUNT_REHOME_TIMEOUT_MS = 5 * 60_000;
const ACCOUNT_REHOME_BROWSER_RECONNECT_TIMEOUT_MS = 5_000;
const ACCOUNT_REHOME_ROUTE_CONVERGENCE_TIMEOUT_MS = 10_000;

const PORTABLE_STATE_TABLES = [
  "account_project_index",
  "account_collaborator_index",
  "account_notification_index",
  "remember_me",
  "account_auth_sessions",
  "account_auth_challenges",
  "account_second_factors",
  "account_second_factor_recovery_codes",
  "auth_tokens",
  "api_keys",
  "membership_grants",
] as const;

type PortableStateTable = (typeof PORTABLE_STATE_TABLES)[number];
type AccountOwnedMembershipPortableTable =
  | "membership_packages"
  | "membership_side_effects_outbox";

type AccountRehomeOperationRow = AccountRehomeOperationSummary & {
  account: Record<string, unknown> | null;
};

type MembershipPortableStateKey = keyof AccountMembershipPortableState;

type MembershipPortableStateCounts = Record<
  MembershipPortableStateKey,
  number
> & {
  total: number;
};

export type AccountRehomeDrainResult = {
  source_bay_id: string;
  dest_bay_id: string;
  dry_run: boolean;
  limit: number;
  campaign_id: string | null;
  only_if_tag: string | null;
  candidate_count: number;
  candidates: string[];
  rehomed: AccountRehomeResponse[];
  errors: Array<{ account_id: string; error: string }>;
};

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

let accountRehomeSchemaReady: Promise<void> | undefined;
let accountRehomeApiKeysSchemaReady: Promise<void> | undefined;
const tableColumnsCache = new Map<string, Promise<string[]>>();

function normalizeUuid(name: string, value: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!isValidUUID(normalized)) {
    throw new Error(`${name} must be a uuid`);
  }
  return normalized;
}

function normalizeBayId(name: string, value: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw new Error(`${name} must be specified`);
  }
  return normalized;
}

function requireAccount(account_id?: string): string {
  if (!account_id) {
    throw new Error("must be signed in to rehome accounts");
  }
  return account_id;
}

async function assertAdmin(account_id?: string): Promise<string> {
  const accountId = requireAccount(account_id);
  if (!(await isAdmin(accountId))) {
    throw new Error("not authorized");
  }
  return accountId;
}

async function assertBayExists(bay_id: string): Promise<void> {
  const rows = await listClusterBayRegistry();
  if (!rows.some((row) => row.bay_id === bay_id)) {
    throw new Error(`bay ${bay_id} not found`);
  }
}

async function ensureAccountRehomeSchema(): Promise<void> {
  accountRehomeSchemaReady ??= (async () => {
    await getPool().query(`
      CREATE TABLE IF NOT EXISTS ${ACCOUNT_REHOME_OPERATIONS_TABLE} (
        op_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        account_id UUID NOT NULL,
        source_bay_id TEXT NOT NULL,
        dest_bay_id TEXT NOT NULL,
        requested_by UUID,
        reason TEXT,
        campaign_id TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        stage TEXT NOT NULL DEFAULT 'requested',
        attempt INTEGER NOT NULL DEFAULT 0,
        account JSONB,
        last_error TEXT,
        destination_accepted_at TIMESTAMPTZ,
        source_flipped_at TIMESTAMPTZ,
        projections_copied_at TIMESTAMPTZ,
        directory_updated_at TIMESTAMPTZ,
        finished_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS account_rehome_operations_account_idx ON ${ACCOUNT_REHOME_OPERATIONS_TABLE}(account_id, status)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS account_rehome_operations_source_idx ON ${ACCOUNT_REHOME_OPERATIONS_TABLE}(source_bay_id, status)`,
    );
    await getPool().query(
      `CREATE INDEX IF NOT EXISTS account_rehome_operations_campaign_idx ON ${ACCOUNT_REHOME_OPERATIONS_TABLE}(campaign_id)`,
    );
  })();
  await accountRehomeSchemaReady;
}

async function ensureAccountRehomeApiKeysSchema(): Promise<void> {
  accountRehomeApiKeysSchemaReady ??= (async () => {
    await getPool().query(
      "ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS key_id TEXT",
    );
    await getPool().query(
      "CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_id_unique_idx ON api_keys(key_id)",
    );
  })();
  await accountRehomeApiKeysSchemaReady;
}

function durationMs(
  row: Pick<AccountRehomeOperationRow, "created_at" | "finished_at">,
): number | null {
  if (!row.created_at || !row.finished_at) return null;
  const start = new Date(row.created_at as any).valueOf();
  const end = new Date(row.finished_at as any).valueOf();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function summarizeOperation(
  row: AccountRehomeOperationRow,
): AccountRehomeOperationSummary {
  return {
    op_id: row.op_id,
    account_id: row.account_id,
    source_bay_id: row.source_bay_id,
    dest_bay_id: row.dest_bay_id,
    requested_by: row.requested_by ?? null,
    reason: row.reason ?? null,
    campaign_id: row.campaign_id ?? null,
    status: row.status,
    stage: row.stage,
    attempt: row.attempt,
    last_error: row.last_error ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    finished_at: row.finished_at ?? null,
    duration_ms: durationMs(row),
  };
}

async function getTableColumns(table: string): Promise<string[]> {
  let promise = tableColumnsCache.get(table);
  if (!promise) {
    promise = (async () => {
      const { rows } = await getPool().query<{ column_name: string }>(
        `
          SELECT column_name
            FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = $1
           ORDER BY ordinal_position
        `,
        [table],
      );
      const columns = rows.map((row) => row.column_name);
      if (columns.length === 0) {
        throw new Error(`table ${table} has no columns`);
      }
      return columns;
    })();
    tableColumnsCache.set(table, promise);
  }
  return await promise;
}

async function upsertJsonRow({
  table,
  row,
  primaryKey,
}: {
  table: string;
  row: Record<string, unknown>;
  primaryKey: string[];
}): Promise<void> {
  const columns = (await getTableColumns(table)).filter(
    (column) =>
      Object.prototype.hasOwnProperty.call(row, column) ||
      primaryKey.includes(column),
  );
  const updateColumns = columns.filter(
    (column) => !primaryKey.includes(column),
  );
  const insertColumns = columns.map((column) => `"${column}"`).join(", ");
  const selectColumns = columns.map((column) => `(r)."${column}"`).join(", ");
  const conflictColumns = primaryKey.map((column) => `"${column}"`).join(", ");
  const updateSet = updateColumns
    .map((column) => `"${column}" = EXCLUDED."${column}"`)
    .join(", ");
  await getPool().query(
    `
      INSERT INTO "${table}" (${insertColumns})
      SELECT ${selectColumns}
        FROM jsonb_populate_record(NULL::"${table}", $1::jsonb) AS r
      ON CONFLICT (${conflictColumns}) DO UPDATE SET ${updateSet}
    `,
    [row],
  );
}

async function replacePortableRows({
  table,
  account_id,
  rows,
}: {
  table: PortableStateTable;
  account_id: string;
  rows: Record<string, unknown>[];
}): Promise<void> {
  const primaryKey =
    table === "account_project_index"
      ? ["account_id", "project_id"]
      : table === "account_collaborator_index"
        ? ["account_id", "collaborator_account_id"]
        : table === "account_notification_index"
          ? ["account_id", "notification_id"]
          : table === "remember_me"
            ? ["hash"]
            : table === "account_auth_sessions"
              ? ["session_hash"]
              : table === "auth_tokens"
                ? ["auth_token"]
                : table === "api_keys"
                  ? ["key_id"]
                  : ["id"];
  if (table === "api_keys") {
    await getPool().query(
      `
        DELETE FROM api_keys
         WHERE account_id=$1
           AND project_id IS NULL
           AND key_id IS NOT NULL
      `,
      [account_id],
    );
  } else {
    await getPool().query(`DELETE FROM "${table}" WHERE account_id=$1`, [
      account_id,
    ]);
  }
  for (const row of rows) {
    const nextRow =
      table === "api_keys"
        ? Object.fromEntries(
            Object.entries(row).filter(([column]) => column !== "id"),
          )
        : row;
    await upsertJsonRow({
      table,
      row: nextRow,
      primaryKey,
    });
  }
}

async function replaceOwnedPortableRows({
  table,
  account_id,
  rows,
}: {
  table: AccountOwnedMembershipPortableTable;
  account_id: string;
  rows: Record<string, unknown>[];
}): Promise<void> {
  const primaryKey = table === "membership_packages" ? ["id"] : ["effect_key"];
  await getPool().query(`DELETE FROM "${table}" WHERE owner_account_id=$1`, [
    account_id,
  ]);
  for (const row of rows) {
    await upsertJsonRow({
      table,
      row,
      primaryKey,
    });
  }
}

async function replaceOwnedMembershipPackageAssignments({
  account_id,
  rows,
}: {
  account_id: string;
  rows: Record<string, unknown>[];
}): Promise<void> {
  await getPool().query(
    `
      DELETE FROM membership_package_assignments
       WHERE package_id IN (
         SELECT id
           FROM membership_packages
          WHERE owner_account_id=$1
       )
    `,
    [account_id],
  );
  for (const row of rows) {
    await upsertJsonRow({
      table: "membership_package_assignments",
      row,
      primaryKey: ["id"],
    });
  }
}

async function clearPortableRows({
  table,
  account_id,
}: {
  table: PortableStateTable;
  account_id: string;
}): Promise<void> {
  if (table === "api_keys") {
    await ensureAccountRehomeApiKeysSchema();
    await getPool().query(
      `
        DELETE FROM api_keys
         WHERE account_id=$1
           AND project_id IS NULL
      `,
      [account_id],
    );
    return;
  }
  await getPool().query(`DELETE FROM "${table}" WHERE account_id=$1`, [
    account_id,
  ]);
}

async function clearOwnedPortableRows({
  table,
  account_id,
}: {
  table: AccountOwnedMembershipPortableTable;
  account_id: string;
}): Promise<void> {
  await getPool().query(`DELETE FROM "${table}" WHERE owner_account_id=$1`, [
    account_id,
  ]);
}

async function clearOwnedMembershipPackageAssignments(
  account_id: string,
): Promise<void> {
  await getPool().query(
    `
      DELETE FROM membership_package_assignments
       WHERE package_id IN (
         SELECT id
           FROM membership_packages
          WHERE owner_account_id=$1
       )
    `,
    [account_id],
  );
}

async function clearPortableState(account_id: string): Promise<void> {
  for (const table of PORTABLE_STATE_TABLES) {
    await clearPortableRows({ table, account_id });
  }
  await clearOwnedMembershipPackageAssignments(account_id);
  await clearOwnedPortableRows({
    table: "membership_packages",
    account_id,
  });
  await clearOwnedPortableRows({
    table: "membership_side_effects_outbox",
    account_id,
  });
}

async function loadAccountWidePortableApiKeyRows(
  account_id: string,
): Promise<Record<string, unknown>[]> {
  await ensureAccountRehomeApiKeysSchema();
  const { rows } = await getPool().query<{
    rows: Record<string, unknown>[] | null;
  }>(
    `
      SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows
        FROM (
          SELECT *
            FROM api_keys
           WHERE account_id=$1
             AND project_id IS NULL
             AND key_id IS NOT NULL
        ) t
    `,
    [account_id],
  );
  return Array.isArray(rows[0]?.rows) ? rows[0].rows! : [];
}

async function loadOwnedPortableRows(
  table: AccountOwnedMembershipPortableTable,
  account_id: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query<{
    rows: Record<string, unknown>[] | null;
  }>(
    `
      SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows
        FROM (
          SELECT *
            FROM "${table}"
           WHERE owner_account_id=$1
        ) t
    `,
    [account_id],
  );
  return Array.isArray(rows[0]?.rows) ? rows[0].rows! : [];
}

async function loadOwnedMembershipPackageAssignmentRows(
  account_id: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query<{
    rows: Record<string, unknown>[] | null;
  }>(
    `
      SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows
        FROM (
          SELECT a.*
            FROM membership_package_assignments a
            JOIN membership_packages p
              ON p.id = a.package_id
           WHERE p.owner_account_id=$1
        ) t
    `,
    [account_id],
  );
  return Array.isArray(rows[0]?.rows) ? rows[0].rows! : [];
}

export async function getMembershipPortableState(
  account_id: string,
): Promise<AccountMembershipPortableState> {
  const [
    membership_grants,
    membership_packages,
    membership_package_assignments,
    membership_side_effects_outbox,
  ] = await Promise.all([
    loadPortableRows("membership_grants", account_id),
    loadOwnedPortableRows("membership_packages", account_id),
    loadOwnedMembershipPackageAssignmentRows(account_id),
    loadOwnedPortableRows("membership_side_effects_outbox", account_id),
  ]);
  return {
    membership_grants,
    membership_packages,
    membership_package_assignments,
    membership_side_effects_outbox,
  };
}

export async function replaceMembershipPortableState({
  account_id,
  membership_grants,
  membership_packages,
  membership_package_assignments,
  membership_side_effects_outbox,
}: {
  account_id: string;
  membership_grants?: Record<string, unknown>[];
  membership_packages?: Record<string, unknown>[];
  membership_package_assignments?: Record<string, unknown>[];
  membership_side_effects_outbox?: Record<string, unknown>[];
}): Promise<void> {
  await replacePortableRows({
    table: "membership_grants",
    account_id,
    rows: membership_grants ?? [],
  });
  await replaceOwnedPortableRows({
    table: "membership_packages",
    account_id,
    rows: membership_packages ?? [],
  });
  await replaceOwnedMembershipPackageAssignments({
    account_id,
    rows: membership_package_assignments ?? [],
  });
  await replaceOwnedPortableRows({
    table: "membership_side_effects_outbox",
    account_id,
    rows: membership_side_effects_outbox ?? [],
  });
}

async function loadAccountRowForRehome(
  account_id: string,
  db: Queryable = getPool(),
): Promise<Record<string, unknown>> {
  const { rows } = await db.query(
    `
      SELECT to_jsonb(accounts) AS account
        FROM accounts
       WHERE account_id=$1
         AND deleted IS NOT TRUE
       LIMIT 1
    `,
    [account_id],
  );
  const account = rows[0]?.account as Record<string, unknown> | undefined;
  if (!account) {
    throw new Error(`account ${account_id} not found`);
  }
  return account;
}

async function loadPortableRows(
  table: PortableStateTable,
  account_id: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await getPool().query<{
    rows: Record<string, unknown>[] | null;
  }>(
    `
      SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) AS rows
        FROM (
          SELECT *
            FROM "${table}"
           WHERE account_id=$1
        ) t
    `,
    [account_id],
  );
  return Array.isArray(rows[0]?.rows) ? rows[0].rows! : [];
}

async function loadPortableState(
  account_id: string,
): Promise<AccountRehomeStateCopyRequest> {
  const [
    account_project_index,
    account_collaborator_index,
    account_notification_index,
    remember_me,
    account_auth_sessions,
    account_auth_challenges,
    account_second_factors,
    account_second_factor_recovery_codes,
    auth_tokens,
    api_keys,
    membershipPortableState,
  ] = await Promise.all([
    loadPortableRows("account_project_index", account_id),
    loadPortableRows("account_collaborator_index", account_id),
    loadPortableRows("account_notification_index", account_id),
    loadPortableRows("remember_me", account_id),
    loadPortableRows("account_auth_sessions", account_id),
    loadPortableRows("account_auth_challenges", account_id),
    loadPortableRows("account_second_factors", account_id),
    loadPortableRows("account_second_factor_recovery_codes", account_id),
    loadPortableRows("auth_tokens", account_id),
    loadAccountWidePortableApiKeyRows(account_id),
    getMembershipPortableState(account_id),
  ]);
  return {
    target_account_id: account_id,
    source_bay_id: getConfiguredBayId(),
    dest_bay_id: "",
    account_project_index,
    account_collaborator_index,
    account_notification_index,
    remember_me,
    account_auth_sessions,
    account_auth_challenges,
    account_second_factors,
    account_second_factor_recovery_codes,
    auth_tokens,
    api_keys,
    membership_grants: membershipPortableState.membership_grants,
    membership_packages: membershipPortableState.membership_packages,
    membership_package_assignments:
      membershipPortableState.membership_package_assignments,
    membership_side_effects_outbox:
      membershipPortableState.membership_side_effects_outbox,
  };
}

async function assertLocalHomeAccount(
  account_id: string,
  db: Queryable = getPool(),
): Promise<Record<string, unknown>> {
  const account = await loadAccountRowForRehome(account_id, db);
  const homeBayId =
    `${account.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (homeBayId !== getConfiguredBayId()) {
    throw new Error(
      `account ${account_id} is homed in ${homeBayId}, not local bay ${getConfiguredBayId()}`,
    );
  }
  return account;
}

async function createOperation({
  account_id,
  source_bay_id,
  dest_bay_id,
  requested_by,
  reason,
  campaign_id,
}: {
  account_id: string;
  source_bay_id: string;
  dest_bay_id: string;
  requested_by: string;
  reason?: string | null;
  campaign_id?: string | null;
}): Promise<AccountRehomeOperationRow> {
  await ensureAccountRehomeSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockAccountRehomeFence({ db: client, account_id });
    const active = await client.query(
      `
        SELECT *
          FROM ${ACCOUNT_REHOME_OPERATIONS_TABLE}
         WHERE account_id = $1
           AND status = 'running'
         ORDER BY created_at DESC
         LIMIT 1
      `,
      [account_id],
    );
    const existing = active.rows[0] as AccountRehomeOperationRow | undefined;
    if (existing) {
      if (
        existing.source_bay_id === source_bay_id &&
        existing.dest_bay_id === dest_bay_id
      ) {
        await client.query("COMMIT");
        return existing;
      }
      throw new Error(
        `account ${account_id} already has running rehome operation ${existing.op_id} from ${existing.source_bay_id} to ${existing.dest_bay_id}`,
      );
    }
    const account = await assertLocalHomeAccount(account_id, client);
    const { rows } = await client.query(
      `
        INSERT INTO ${ACCOUNT_REHOME_OPERATIONS_TABLE}
          (account_id, source_bay_id, dest_bay_id, requested_by, reason, campaign_id, account)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7::jsonb)
        RETURNING *
      `,
      [
        account_id,
        source_bay_id,
        dest_bay_id,
        requested_by,
        reason ?? null,
        campaign_id ?? null,
        account,
      ],
    );
    await client.query("COMMIT");
    return rows[0]! as AccountRehomeOperationRow;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

export async function getAccountRehomeOperation(
  op_id: string,
): Promise<AccountRehomeOperationSummary | undefined> {
  await ensureAccountRehomeSchema();
  const { rows } = await getPool().query<AccountRehomeOperationRow>(
    `SELECT * FROM ${ACCOUNT_REHOME_OPERATIONS_TABLE} WHERE op_id=$1`,
    [normalizeUuid("op_id", op_id)],
  );
  return rows[0] ? summarizeOperation(rows[0]) : undefined;
}

export async function getAccountRehomeOperationForOperator({
  account_id,
  op_id,
  source_bay_id,
}: {
  account_id?: string;
  op_id: string;
  source_bay_id?: string;
}): Promise<AccountRehomeOperationSummary | undefined> {
  await assertAdmin(account_id);
  const opId = normalizeUuid("op_id", op_id);
  const sourceBayId = `${source_bay_id ?? ""}`.trim();
  if (sourceBayId && sourceBayId !== getConfiguredBayId()) {
    return (
      (await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: sourceBayId,
        timeout: ACCOUNT_REHOME_TIMEOUT_MS,
      }).getRehomeOperation({ op_id: opId })) ?? undefined
    );
  }
  return await getAccountRehomeOperation(opId);
}

async function updateOperation({
  op_id,
  status,
  stage,
  account,
  last_error,
}: {
  op_id: string;
  status?: AccountRehomeOperationStatus;
  stage?: AccountRehomeOperationStage;
  account?: Record<string, unknown> | null;
  last_error?: string | null;
}): Promise<AccountRehomeOperationRow> {
  await ensureAccountRehomeSchema();
  const sets = ["updated_at = NOW()"];
  const values: any[] = [op_id];
  let i = 2;
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    values.push(status);
    if (status === "succeeded" || status === "failed") {
      sets.push("finished_at = NOW()");
    }
    if (status === "running") {
      sets.push("finished_at = NULL");
    }
  }
  if (stage !== undefined) {
    sets.push(`stage = $${i++}`);
    values.push(stage);
    if (stage === "destination_accepted") {
      sets.push(
        "destination_accepted_at = COALESCE(destination_accepted_at, NOW())",
      );
    } else if (stage === "source_flipped") {
      sets.push("source_flipped_at = COALESCE(source_flipped_at, NOW())");
    } else if (stage === "projections_copied") {
      sets.push(
        "projections_copied_at = COALESCE(projections_copied_at, NOW())",
      );
    } else if (stage === "directory_updated") {
      sets.push("directory_updated_at = COALESCE(directory_updated_at, NOW())");
    }
  }
  if (account !== undefined) {
    sets.push(`account = $${i++}`);
    values.push(account);
  }
  if (last_error !== undefined) {
    sets.push(`last_error = $${i++}`);
    values.push(last_error);
  }
  const { rows } = await getPool().query<AccountRehomeOperationRow>(
    `
      UPDATE ${ACCOUNT_REHOME_OPERATIONS_TABLE}
         SET ${sets.join(", ")}
       WHERE op_id = $1
       RETURNING *
    `,
    values,
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`account rehome operation ${op_id} not found`);
  }
  return row;
}

async function startAttempt(op_id: string): Promise<AccountRehomeOperationRow> {
  await ensureAccountRehomeSchema();
  const { rows } = await getPool().query<AccountRehomeOperationRow>(
    `
      UPDATE ${ACCOUNT_REHOME_OPERATIONS_TABLE}
         SET attempt = CASE
               WHEN status = 'succeeded' THEN attempt
               ELSE attempt + 1
             END,
             status = CASE
               WHEN status = 'succeeded' THEN status
               ELSE 'running'
             END,
             last_error = CASE
               WHEN status = 'succeeded' THEN last_error
               ELSE NULL
             END,
             finished_at = CASE
               WHEN status = 'succeeded' THEN finished_at
               ELSE NULL
             END,
             updated_at = NOW()
       WHERE op_id = $1
       RETURNING *
    `,
    [op_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`account rehome operation ${op_id} not found`);
  }
  return row;
}

async function markFailed({
  op_id,
  err,
}: {
  op_id: string;
  err: unknown;
}): Promise<AccountRehomeOperationRow> {
  return await updateOperation({
    op_id,
    status: "failed",
    last_error: err instanceof Error ? err.message : `${err}`,
  });
}

async function flipSourceHomeBay({
  account_id,
  dest_bay_id,
}: {
  account_id: string;
  dest_bay_id: string;
}): Promise<void> {
  const { rowCount } = await getPool().query(
    `
      UPDATE accounts
         SET home_bay_id=$2
       WHERE account_id=$1
         AND deleted IS NOT TRUE
    `,
    [account_id, dest_bay_id],
  );
  if (rowCount !== 1) {
    throw new Error(`account ${account_id} not found while flipping home bay`);
  }
}

async function forceAccountBrowserSessionsToHomeBay({
  account_id,
  dest_bay_id,
  op_id,
}: {
  account_id: string;
  dest_bay_id: string;
  op_id: string;
}): Promise<void> {
  const origin =
    `${(await getBayPublicOrigin(dest_bay_id)) ?? (await getClusterBayPublicOrigins())[dest_bay_id] ?? ""}`.trim();
  if (!origin) {
    log.warn("account rehome browser reconnect skipped; no bay origin", {
      op_id,
      account_id,
      dest_bay_id,
    });
    return;
  }
  const targetUrl = `${origin.replace(/\/+$/, "")}/app?account-rehome`;
  const sessions = listBrowserSessionsForAccount({
    account_id,
    max_age_ms: 2 * 60_000,
    live_by_browser_id: await getLiveBrowserSessionInfo(account_id),
  });
  if (sessions.length === 0) {
    return;
  }
  const results = await Promise.allSettled(
    sessions.map(async ({ browser_id }) => {
      const browser = createBrowserSessionClient({
        account_id,
        browser_id,
        client: conat(),
        timeout: ACCOUNT_REHOME_BROWSER_RECONNECT_TIMEOUT_MS,
      });
      await browser.action({
        project_id: "",
        action: {
          name: "navigate",
          url: targetUrl,
          replace: true,
          wait_for_url_ms: 500,
        },
        posture: "dev",
      });
    }),
  );
  const failed = results.filter(({ status }) => status === "rejected").length;
  log.info("account rehome browser reconnect requested", {
    op_id,
    account_id,
    dest_bay_id,
    target_url: targetUrl,
    sessions: sessions.length,
    failed,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAccountHomeBayReadPath({
  acting_account_id,
  target_account_id,
  dest_bay_id,
  timeout_ms = ACCOUNT_REHOME_ROUTE_CONVERGENCE_TIMEOUT_MS,
}: {
  acting_account_id: string;
  target_account_id: string;
  dest_bay_id: string;
  timeout_ms?: number;
}): Promise<void> {
  const deadline = Date.now() + timeout_ms;
  let lastHomeBayId: string | null = null;
  let lastError: unknown;
  while (true) {
    try {
      const located = await resolveAccountHomeBay({
        account_id: acting_account_id,
        user_account_id: target_account_id,
      });
      lastHomeBayId = `${located.home_bay_id ?? ""}`.trim() || null;
      if (lastHomeBayId === dest_bay_id) {
        return;
      }
    } catch (err) {
      lastError = err;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const suffix = lastError
        ? `; last error: ${lastError instanceof Error ? lastError.message : `${lastError}`}`
        : `; last home bay: ${lastHomeBayId ?? "unknown"}`;
      throw new Error(
        `account ${target_account_id} routing did not converge to ${dest_bay_id}${suffix}`,
      );
    }
    await delay(Math.min(250, Math.max(25, remaining)));
  }
}

export async function acceptAccountRehome({
  target_account_id,
  source_bay_id,
  dest_bay_id,
  account,
}: AccountRehomeAcceptRequest): Promise<AccountRehomeResponse> {
  const accountId = normalizeUuid("target_account_id", target_account_id);
  const sourceBayId = normalizeBayId("source_bay_id", source_bay_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `account rehome accept for ${accountId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  await upsertJsonRow({
    table: "accounts",
    row: {
      ...account,
      account_id: accountId,
      home_bay_id: destBayId,
    },
    primaryKey: ["account_id"],
  });
  log.info("account rehome destination accepted", {
    account_id: accountId,
    source_bay_id: sourceBayId,
    dest_bay_id: destBayId,
  });
  return {
    account_id: accountId,
    previous_bay_id: sourceBayId,
    home_bay_id: destBayId,
    status: "rehomed",
  };
}

export async function copyAccountRehomeState({
  target_account_id,
  source_bay_id,
  dest_bay_id,
  account_project_index,
  account_collaborator_index,
  account_notification_index,
  remember_me,
  account_auth_sessions,
  account_auth_challenges,
  account_second_factors,
  account_second_factor_recovery_codes,
  auth_tokens,
  api_keys,
  membership_grants,
  membership_packages,
  membership_package_assignments,
  membership_side_effects_outbox,
}: AccountRehomeStateCopyRequest): Promise<void> {
  const accountId = normalizeUuid("target_account_id", target_account_id);
  normalizeBayId("source_bay_id", source_bay_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  if (destBayId !== localBayId) {
    throw new Error(
      `account rehome state copy for ${accountId} reached ${localBayId}, not destination bay ${destBayId}`,
    );
  }
  await replacePortableRows({
    table: "account_project_index",
    account_id: accountId,
    rows: account_project_index ?? [],
  });
  await replacePortableRows({
    table: "account_collaborator_index",
    account_id: accountId,
    rows: account_collaborator_index ?? [],
  });
  await replacePortableRows({
    table: "account_notification_index",
    account_id: accountId,
    rows: account_notification_index ?? [],
  });
  await replacePortableRows({
    table: "remember_me",
    account_id: accountId,
    rows: remember_me ?? [],
  });
  await replacePortableRows({
    table: "account_auth_sessions",
    account_id: accountId,
    rows: account_auth_sessions ?? [],
  });
  await replacePortableRows({
    table: "account_auth_challenges",
    account_id: accountId,
    rows: account_auth_challenges ?? [],
  });
  await replacePortableRows({
    table: "account_second_factors",
    account_id: accountId,
    rows: account_second_factors ?? [],
  });
  await replacePortableRows({
    table: "account_second_factor_recovery_codes",
    account_id: accountId,
    rows: account_second_factor_recovery_codes ?? [],
  });
  await replacePortableRows({
    table: "auth_tokens",
    account_id: accountId,
    rows: auth_tokens ?? [],
  });
  await ensureAccountRehomeApiKeysSchema();
  await replacePortableRows({
    table: "api_keys",
    account_id: accountId,
    rows: api_keys ?? [],
  });
  await replacePortableRows({
    table: "membership_grants",
    account_id: accountId,
    rows: membership_grants ?? [],
  });
  await replaceOwnedPortableRows({
    table: "membership_packages",
    account_id: accountId,
    rows: membership_packages ?? [],
  });
  await replaceOwnedMembershipPackageAssignments({
    account_id: accountId,
    rows: membership_package_assignments ?? [],
  });
  await replaceOwnedPortableRows({
    table: "membership_side_effects_outbox",
    account_id: accountId,
    rows: membership_side_effects_outbox ?? [],
  });
  await updateClusterAccountApiKeysHomeBay({
    account_id: accountId,
    home_bay_id: destBayId,
  });
  log.info("account rehome destination state copied", {
    account_id: accountId,
    source_bay_id,
    dest_bay_id: destBayId,
    account_project_index_rows: account_project_index?.length ?? 0,
    account_collaborator_index_rows: account_collaborator_index?.length ?? 0,
    account_notification_index_rows: account_notification_index?.length ?? 0,
    remember_me_rows: remember_me?.length ?? 0,
    auth_tokens_rows: auth_tokens?.length ?? 0,
    api_keys_rows: api_keys?.length ?? 0,
    membership_grants_rows: membership_grants?.length ?? 0,
    membership_packages_rows: membership_packages?.length ?? 0,
    membership_package_assignments_rows:
      membership_package_assignments?.length ?? 0,
    membership_side_effects_outbox_rows:
      membership_side_effects_outbox?.length ?? 0,
  });
}

export async function rehomeAccountOnHomeBay({
  account_id,
  target_account_id,
  dest_bay_id,
  reason,
  campaign_id,
}: AccountRehomeRequest): Promise<AccountRehomeResponse> {
  const requestedBy = requireAccount(account_id);
  const accountId = normalizeUuid("target_account_id", target_account_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  const localBayId = getConfiguredBayId();
  const account = await loadAccountRowForRehome(accountId);
  const sourceBayId = `${account.home_bay_id ?? ""}`.trim() || localBayId;
  if (sourceBayId !== localBayId) {
    throw new Error(
      `account ${accountId} is not homed in local bay ${localBayId}`,
    );
  }
  if (destBayId === localBayId) {
    return {
      account_id: accountId,
      previous_bay_id: localBayId,
      home_bay_id: localBayId,
      status: "already-home",
    };
  }
  await assertBayExists(destBayId);
  const op = await createOperation({
    account_id: accountId,
    source_bay_id: localBayId,
    dest_bay_id: destBayId,
    requested_by: requestedBy,
    reason,
    campaign_id,
  });
  return await runAccountRehomeOperation(op.op_id);
}

export async function runAccountRehomeOperation(
  op_id: string,
): Promise<AccountRehomeResponse> {
  let op = await startAttempt(normalizeUuid("op_id", op_id));
  const localBayId = getConfiguredBayId();
  if (op.source_bay_id !== localBayId) {
    throw new Error(
      `account rehome operation ${op_id} belongs to source bay ${op.source_bay_id}, not local bay ${localBayId}`,
    );
  }

  try {
    let account = op.account;
    if (!account) {
      account = await loadAccountRowForRehome(op.account_id);
      op = await updateOperation({ op_id, account });
    }

    if (op.stage === "requested") {
      await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: op.dest_bay_id,
        timeout: ACCOUNT_REHOME_TIMEOUT_MS,
      }).acceptRehome({
        target_account_id: op.account_id,
        source_bay_id: op.source_bay_id,
        dest_bay_id: op.dest_bay_id,
        account,
      });
      op = await updateOperation({
        op_id,
        stage: "destination_accepted",
      });
    }

    if (op.stage === "destination_accepted") {
      await flipSourceHomeBay({
        account_id: op.account_id,
        dest_bay_id: op.dest_bay_id,
      });
      op = await updateOperation({
        op_id,
        stage: "source_flipped",
      });
    }

    if (op.stage === "source_flipped") {
      const state = await loadPortableState(op.account_id);
      await createInterBayAccountLocalClient({
        client: getInterBayFabricClient(),
        dest_bay: op.dest_bay_id,
        timeout: ACCOUNT_REHOME_TIMEOUT_MS,
      }).copyRehomeState({
        ...state,
        source_bay_id: op.source_bay_id,
        dest_bay_id: op.dest_bay_id,
      });
      op = await updateOperation({
        op_id,
        stage: "projections_copied",
      });
    }

    if (op.stage === "projections_copied") {
      await clearPortableState(op.account_id);
      const accountEntry = await getClusterAccountById(op.account_id);
      await updateClusterAccountHomeBay({
        account_id: op.account_id,
        home_bay_id: op.dest_bay_id,
      });
      await waitForAccountHomeBayReadPath({
        // Use the rehomed account itself for the convergence lookup. The
        // requesting admin may be homed on a different bay, so polling with
        // the operator account can fail on attached source bays even though
        // the rehome itself already succeeded.
        acting_account_id: op.account_id,
        target_account_id: op.account_id,
        dest_bay_id: op.dest_bay_id,
      });
      await forceAccountBrowserSessionsToHomeBay({
        account_id: op.account_id,
        dest_bay_id: op.dest_bay_id,
        op_id,
      });
      if (!accountEntry?.account_id) {
        log.warn("account rehome directory update had no prior entry", {
          op_id,
          account_id: op.account_id,
        });
      }
      op = await updateOperation({
        op_id,
        stage: "directory_updated",
      });
    }

    if (op.stage === "directory_updated") {
      op = await updateOperation({
        op_id,
        status: "succeeded",
        stage: "complete",
      });
    }

    log.info("account rehomed", {
      op_id,
      account_id: op.account_id,
      previous_bay_id: op.source_bay_id,
      home_bay_id: op.dest_bay_id,
      stage: op.stage,
    });
    return {
      op_id,
      account_id: op.account_id,
      previous_bay_id: op.source_bay_id,
      home_bay_id: op.dest_bay_id,
      operation_stage: op.stage,
      operation_status: op.status,
      status: "rehomed",
    };
  } catch (err) {
    const failed = await markFailed({ op_id, err });
    log.warn("account rehome failed", {
      op_id,
      account_id: failed.account_id,
      source_bay_id: failed.source_bay_id,
      dest_bay_id: failed.dest_bay_id,
      stage: failed.stage,
      err: `${err}`,
    });
    throw err;
  }
}

export async function rehomeAccount({
  account_id,
  target_account_id,
  dest_bay_id,
  reason,
  campaign_id,
}: AccountRehomeRequest): Promise<AccountRehomeResponse> {
  const requestedBy = await assertAdmin(account_id);
  const accountId = normalizeUuid("target_account_id", target_account_id);
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  await assertBayExists(destBayId);
  const account = await getClusterAccountById(accountId);
  if (!account?.account_id) {
    throw new Error(`account ${accountId} not found`);
  }
  const sourceBayId =
    `${account.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  if (sourceBayId === destBayId) {
    return {
      account_id: accountId,
      previous_bay_id: sourceBayId,
      home_bay_id: sourceBayId,
      status: "already-home",
    };
  }
  if (sourceBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: sourceBayId,
      timeout: ACCOUNT_REHOME_TIMEOUT_MS,
    }).rehome({
      account_id: requestedBy,
      target_account_id: accountId,
      dest_bay_id: destBayId,
      reason,
      campaign_id,
    });
  }
  return await rehomeAccountOnHomeBay({
    account_id: requestedBy,
    target_account_id: accountId,
    dest_bay_id: destBayId,
    reason,
    campaign_id,
  });
}

function emptyMembershipPortableState(): Required<AccountMembershipPortableState> {
  return {
    membership_grants: [],
    membership_packages: [],
    membership_package_assignments: [],
    membership_side_effects_outbox: [],
  };
}

function membershipPortableStateCounts(
  state: AccountMembershipPortableState,
): MembershipPortableStateCounts {
  const membership_grants = state.membership_grants?.length ?? 0;
  const membership_packages = state.membership_packages?.length ?? 0;
  const membership_package_assignments =
    state.membership_package_assignments?.length ?? 0;
  const membership_side_effects_outbox =
    state.membership_side_effects_outbox?.length ?? 0;
  return {
    membership_grants,
    membership_packages,
    membership_package_assignments,
    membership_side_effects_outbox,
    total:
      membership_grants +
      membership_packages +
      membership_package_assignments +
      membership_side_effects_outbox,
  };
}

function membershipPortableRowKey(
  key: MembershipPortableStateKey,
  row: Record<string, unknown>,
): string {
  const value =
    key === "membership_grants"
      ? row.id
      : key === "membership_packages"
        ? row.id
        : key === "membership_package_assignments"
          ? row.id
          : row.effect_key;
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) {
    throw new Error(`membership portability row missing key for ${key}`);
  }
  return normalized;
}

function rowTimestamp(row: Record<string, unknown>): number {
  for (const field of [
    "updated_at",
    "updated",
    "last_attempt_at",
    "created_at",
    "created",
  ]) {
    const value = row[field];
    if (value == null) continue;
    const ts =
      value instanceof Date
        ? value.valueOf()
        : typeof value === "number"
          ? value
          : Date.parse(`${value}`);
    if (Number.isFinite(ts)) {
      return ts;
    }
  }
  return 0;
}

function mergeMembershipPortableRows({
  key,
  home_bay_id,
  states_by_bay,
}: {
  key: MembershipPortableStateKey;
  home_bay_id: string;
  states_by_bay: Array<{
    bay_id: string;
    state: AccountMembershipPortableState;
  }>;
}): Record<string, unknown>[] {
  const merged = new Map<
    string,
    { bay_id: string; row: Record<string, unknown> }
  >();
  const orderedStates = [...states_by_bay].sort((a, b) => {
    if (a.bay_id === home_bay_id && b.bay_id !== home_bay_id) return -1;
    if (b.bay_id === home_bay_id && a.bay_id !== home_bay_id) return 1;
    return a.bay_id.localeCompare(b.bay_id);
  });
  for (const { bay_id, state } of orderedStates) {
    for (const row of state[key] ?? []) {
      const rowRecord = row as Record<string, unknown>;
      const identity = membershipPortableRowKey(key, rowRecord);
      const existing = merged.get(identity);
      if (!existing) {
        merged.set(identity, { bay_id, row: rowRecord });
        continue;
      }
      if (existing.bay_id === home_bay_id) {
        continue;
      }
      if (bay_id === home_bay_id) {
        merged.set(identity, { bay_id, row: rowRecord });
        continue;
      }
      if (rowTimestamp(rowRecord) >= rowTimestamp(existing.row)) {
        merged.set(identity, { bay_id, row: rowRecord });
      }
    }
  }
  return [...merged.values()].map(({ row }) => row);
}

async function loadMembershipPortableStateFromBay({
  bay_id,
  account_id,
}: {
  bay_id: string;
  account_id: string;
}): Promise<AccountMembershipPortableState> {
  if (bay_id === getConfiguredBayId()) {
    return await getMembershipPortableState(account_id);
  }
  return await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay_id,
    timeout: ACCOUNT_REHOME_TIMEOUT_MS,
  }).getMembershipPortableState({ account_id });
}

async function replaceMembershipPortableStateOnBay({
  bay_id,
  account_id,
  state,
}: {
  bay_id: string;
  account_id: string;
  state: AccountMembershipPortableState;
}): Promise<void> {
  if (bay_id === getConfiguredBayId()) {
    await replaceMembershipPortableState({
      account_id,
      ...state,
    });
    return;
  }
  await createInterBayAccountLocalClient({
    client: getInterBayFabricClient(),
    dest_bay: bay_id,
    timeout: ACCOUNT_REHOME_TIMEOUT_MS,
  }).replaceMembershipPortableState({
    account_id,
    ...state,
  });
}

export async function repairAccountMembershipPortability({
  account_id,
  target_account_id,
  dry_run = true,
  clear_stale = false,
}: {
  account_id?: string;
  target_account_id: string;
  dry_run?: boolean;
  clear_stale?: boolean;
}): Promise<{
  account_id: string;
  home_bay_id: string;
  dry_run: boolean;
  clear_stale: boolean;
  scanned_bays: Array<{
    bay_id: string;
    membership_grants: number;
    membership_packages: number;
    membership_package_assignments: number;
    membership_side_effects_outbox: number;
    total: number;
  }>;
  source_bays_with_rows: string[];
  stale_bay_ids: string[];
  cleared_stale_bay_ids: string[];
  merged_counts: MembershipPortableStateCounts;
  applied: boolean;
}> {
  await assertAdmin(account_id);
  const accountId = normalizeUuid("target_account_id", target_account_id);
  const account = await getClusterAccountById(accountId);
  if (!account?.account_id) {
    throw new Error(`account ${accountId} not found`);
  }
  const homeBayId =
    `${account.home_bay_id ?? ""}`.trim() || getConfiguredBayId();
  const configuredBayIds = (await listConfiguredBays()).map(
    ({ bay_id }) => bay_id,
  );
  const bayIds = [
    ...new Set([homeBayId, getConfiguredBayId(), ...configuredBayIds]),
  ];
  const statesByBay = await Promise.all(
    bayIds.map(async (bay_id) => ({
      bay_id,
      state: await loadMembershipPortableStateFromBay({
        bay_id,
        account_id: accountId,
      }),
    })),
  );
  const scanned_bays = statesByBay.map(({ bay_id, state }) => ({
    bay_id,
    ...membershipPortableStateCounts(state),
  }));
  const source_bays_with_rows = scanned_bays
    .filter(({ total }) => total > 0)
    .map(({ bay_id }) => bay_id);
  const stale_bay_ids = scanned_bays
    .filter(({ bay_id, total }) => bay_id !== homeBayId && total > 0)
    .map(({ bay_id }) => bay_id);
  const mergedState: Required<AccountMembershipPortableState> = {
    membership_grants: mergeMembershipPortableRows({
      key: "membership_grants",
      home_bay_id: homeBayId,
      states_by_bay: statesByBay,
    }),
    membership_packages: mergeMembershipPortableRows({
      key: "membership_packages",
      home_bay_id: homeBayId,
      states_by_bay: statesByBay,
    }),
    membership_package_assignments: mergeMembershipPortableRows({
      key: "membership_package_assignments",
      home_bay_id: homeBayId,
      states_by_bay: statesByBay,
    }),
    membership_side_effects_outbox: mergeMembershipPortableRows({
      key: "membership_side_effects_outbox",
      home_bay_id: homeBayId,
      states_by_bay: statesByBay,
    }),
  };
  const merged_counts = membershipPortableStateCounts(mergedState);
  const cleared_stale_bay_ids: string[] = [];
  if (!dry_run) {
    await replaceMembershipPortableStateOnBay({
      bay_id: homeBayId,
      account_id: accountId,
      state: mergedState,
    });
    if (clear_stale) {
      for (const bay_id of stale_bay_ids) {
        await replaceMembershipPortableStateOnBay({
          bay_id,
          account_id: accountId,
          state: emptyMembershipPortableState(),
        });
        cleared_stale_bay_ids.push(bay_id);
      }
    }
  }
  return {
    account_id: accountId,
    home_bay_id: homeBayId,
    dry_run,
    clear_stale,
    scanned_bays,
    source_bays_with_rows,
    stale_bay_ids,
    cleared_stale_bay_ids,
    merged_counts,
    applied: !dry_run,
  };
}

export async function reconcileAccountRehome({
  account_id,
  op_id,
  source_bay_id,
}: {
  account_id?: string;
  op_id: string;
  source_bay_id?: string;
}): Promise<AccountRehomeResponse> {
  await assertAdmin(account_id);
  const opId = normalizeUuid("op_id", op_id);
  const sourceBayId = `${source_bay_id ?? ""}`.trim();
  if (sourceBayId && sourceBayId !== getConfiguredBayId()) {
    return await createInterBayAccountLocalClient({
      client: getInterBayFabricClient(),
      dest_bay: sourceBayId,
      timeout: ACCOUNT_REHOME_TIMEOUT_MS,
    }).reconcileRehome({
      account_id,
      op_id: opId,
      source_bay_id: sourceBayId,
    });
  }
  return await runAccountRehomeOperation(opId);
}

export async function reconcileAccountRehomeOnSource({
  op_id,
}: {
  op_id: string;
}): Promise<AccountRehomeResponse> {
  return await runAccountRehomeOperation(op_id);
}

export async function drainAccountRehome({
  account_id,
  source_bay_id,
  dest_bay_id,
  limit = 25,
  dry_run = true,
  campaign_id,
  reason,
  only_if_tag,
}: {
  account_id?: string;
  source_bay_id?: string;
  dest_bay_id: string;
  limit?: number;
  dry_run?: boolean;
  campaign_id?: string | null;
  reason?: string | null;
  only_if_tag?: string | null;
}): Promise<AccountRehomeDrainResult> {
  const requestedBy = await assertAdmin(account_id);
  const localBayId = getConfiguredBayId();
  const sourceBayId = normalizeBayId(
    "source_bay_id",
    source_bay_id ?? localBayId,
  );
  const destBayId = normalizeBayId("dest_bay_id", dest_bay_id);
  if (sourceBayId !== localBayId) {
    throw new Error(
      `account rehome drain must run on the source bay (${sourceBayId}); local bay is ${localBayId}`,
    );
  }
  if (sourceBayId === destBayId) {
    throw new Error("source and destination bay must be different");
  }
  await assertBayExists(destBayId);
  const normalizedLimit = Math.min(
    500,
    Math.max(1, Number.isInteger(limit) ? limit : 25),
  );
  const onlyIfTag = `${only_if_tag ?? ""}`.trim() || null;
  const { rows } = await getPool().query<{ account_id: string }>(
    `
      SELECT account_id
        FROM accounts
       WHERE COALESCE(NULLIF(BTRIM(home_bay_id), ''), $1) = $1
         AND account_id <> $2
         AND deleted IS NOT TRUE
         AND ($4::TEXT IS NULL OR $4 = ANY(COALESCE(tags, ARRAY[]::TEXT[])))
       ORDER BY last_active ASC NULLS FIRST, created ASC NULLS FIRST, account_id ASC
       LIMIT $3
    `,
    [sourceBayId, requestedBy, normalizedLimit, onlyIfTag],
  );
  const candidates = rows.map((row) => row.account_id);
  const result: AccountRehomeDrainResult = {
    source_bay_id: sourceBayId,
    dest_bay_id: destBayId,
    dry_run,
    limit: normalizedLimit,
    campaign_id: campaign_id ?? null,
    only_if_tag: onlyIfTag,
    candidate_count: candidates.length,
    candidates,
    rehomed: [],
    errors: [],
  };
  if (dry_run) {
    return result;
  }
  for (const accountId of candidates) {
    try {
      result.rehomed.push(
        await rehomeAccountOnHomeBay({
          account_id: requestedBy,
          target_account_id: accountId,
          dest_bay_id: destBayId,
          campaign_id: campaign_id ?? `drain:${sourceBayId}->${destBayId}`,
          reason: reason ?? `drain ${sourceBayId} to ${destBayId}`,
        }),
      );
    } catch (err) {
      result.errors.push({
        account_id: accountId,
        error: err instanceof Error ? err.message : `${err}`,
      });
    }
  }
  return result;
}
