/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { secrets } from "@cocalc/backend/data";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import {
  deriveSiteMasterKey,
  getOrCreateSiteMasterKey,
} from "@cocalc/util/master-key-lifecycle";
import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
  normalizeProjectSecretName,
  PROJECT_SECRETS_MAX_COUNT,
  PROJECT_SECRETS_PURPOSE,
  validateProjectSecretValue,
} from "@cocalc/util/project-secrets";
import type { EncryptedProjectSecretValue } from "@cocalc/util/project-secrets";
import type { ProjectSecretsRuntimeCache } from "@cocalc/util/project-secrets";

const logger = getLogger("server:projects:project-secrets");

type Queryable = {
  query: (
    sql: string,
    params?: any[],
  ) => Promise<{ rows: any[]; rowCount?: number | null }>;
};

export interface ProjectSecretMetadata {
  project_id: string;
  name: string;
  value_bytes: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CopyProjectSecretsResult {
  copied: string[];
  conflicts: string[];
  missing: string[];
}

export interface ExportProjectSecretsForCopyResult {
  secrets: Record<string, string>;
  missing: string[];
}

let cachedProjectSecretsKey: Buffer | undefined;

function pool(): Queryable {
  return getPool();
}

async function getProjectSecretsKey(): Promise<Buffer> {
  if (cachedProjectSecretsKey) return cachedProjectSecretsKey;
  cachedProjectSecretsKey = deriveSiteMasterKey(
    await getOrCreateSiteMasterKey({ secretsDir: secrets }),
    PROJECT_SECRETS_PURPOSE,
  );
  return cachedProjectSecretsKey;
}

export async function ensureProjectSecretsSchema(
  db: Queryable = pool(),
): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      encrypted_value JSONB NOT NULL,
      value_bytes INTEGER NOT NULL,
      created_by UUID REFERENCES accounts(account_id),
      updated_by UUID REFERENCES accounts(account_id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, name)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS project_secrets_project_id_idx
      ON project_secrets(project_id)
  `);
}

function metadata(row: any): ProjectSecretMetadata {
  return {
    project_id: row.project_id,
    name: row.name,
    value_bytes: Number(row.value_bytes ?? 0),
    created_by: row.created_by ?? null,
    updated_by: row.updated_by ?? null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function encryptedValue(value: any): EncryptedProjectSecretValue {
  return typeof value === "string" ? JSON.parse(value) : value;
}

async function withTransaction<T>(
  fn: (client: Queryable) => Promise<T>,
): Promise<T> {
  const client = await (getPool() as any).connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      logger.warn("project secrets transaction rollback failed", {
        err: `${rollbackErr}`,
      });
    }
    throw err;
  } finally {
    client.release();
  }
}

function normalizeNames(names?: string[]): string[] | undefined {
  if (names == null) return undefined;
  return Array.from(new Set<string>(names.map(normalizeProjectSecretName)));
}

export async function listProjectSecrets({
  project_id,
  db = pool(),
}: {
  project_id: string;
  db?: Queryable;
}): Promise<ProjectSecretMetadata[]> {
  await ensureProjectSecretsSchema(db);
  const { rows } = await db.query(
    `SELECT project_id, name, value_bytes, created_by, updated_by, created_at, updated_at
     FROM project_secrets
     WHERE project_id=$1
     ORDER BY name`,
    [project_id],
  );
  return rows.map(metadata);
}

export async function getProjectSecretsForRuntime({
  project_id,
  db = pool(),
}: {
  project_id: string;
  db?: Queryable;
}): Promise<Record<string, string>> {
  await ensureProjectSecretsSchema(db);
  const key = await getProjectSecretsKey();
  const { rows } = await db.query(
    `SELECT name, encrypted_value
     FROM project_secrets
     WHERE project_id=$1
     ORDER BY name`,
    [project_id],
  );
  return Object.fromEntries(
    rows.map((row) => [
      row.name,
      decryptProjectSecretValue({
        project_id,
        name: row.name,
        encrypted: encryptedValue(row.encrypted_value),
        key,
      }),
    ]),
  );
}

export async function getProjectSecretsRuntimeCache({
  project_id,
  db = pool(),
}: {
  project_id: string;
  db?: Queryable;
}): Promise<ProjectSecretsRuntimeCache> {
  await ensureProjectSecretsSchema(db);
  const key = await getProjectSecretsKey();
  const { rows } = await db.query(
    `SELECT name, encrypted_value, value_bytes, updated_at
     FROM project_secrets
     WHERE project_id=$1
     ORDER BY name`,
    [project_id],
  );
  return {
    key_base64: key.toString("base64"),
    entries: rows.map((row) => ({
      name: row.name,
      encrypted_value: encryptedValue(row.encrypted_value),
      value_bytes: Number(row.value_bytes ?? 0),
      updated_at: row.updated_at,
    })),
  };
}

export async function exportProjectSecretsForCopy({
  project_id,
  names,
  db = pool(),
}: {
  project_id: string;
  names?: string[];
  db?: Queryable;
}): Promise<ExportProjectSecretsForCopyResult> {
  await ensureProjectSecretsSchema(db);
  const selectedNames = normalizeNames(names);
  const key = await getProjectSecretsKey();
  const params: any[] = [project_id];
  let nameSql = "";
  if (selectedNames) {
    params.push(selectedNames);
    nameSql = "AND name = ANY($2::TEXT[])";
  }
  const { rows } = await db.query(
    `SELECT name, encrypted_value
     FROM project_secrets
     WHERE project_id=$1 ${nameSql}
     ORDER BY name`,
    params,
  );
  const sourceByName = new Map(rows.map((row) => [row.name, row]));
  const missing = (selectedNames ?? []).filter(
    (name) => !sourceByName.has(name),
  );
  return {
    missing,
    secrets: Object.fromEntries(
      rows.map((row) => [
        row.name,
        decryptProjectSecretValue({
          project_id,
          name: row.name,
          encrypted: encryptedValue(row.encrypted_value),
          key,
        }),
      ]),
    ),
  };
}

export async function importProjectSecretsForCopy({
  project_id,
  secrets,
  overwrite = false,
  account_id,
}: {
  project_id: string;
  secrets: Record<string, string>;
  overwrite?: boolean;
  account_id: string;
}): Promise<CopyProjectSecretsResult> {
  const entries = Object.entries(secrets ?? {}).map(([name, value]) => {
    const normalizedName = normalizeProjectSecretName(name);
    return {
      name: normalizedName,
      value,
      valueBytes: validateProjectSecretValue(value),
    };
  });
  const uniqueNames = new Set(entries.map(({ name }) => name));
  if (uniqueNames.size !== entries.length) {
    throw new Error("duplicate project secret names");
  }
  if (entries.length === 0) {
    return { copied: [], conflicts: [], missing: [] };
  }
  const key = await getProjectSecretsKey();
  return await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const { rows: targetRows } = await db.query(
      "SELECT name FROM project_secrets WHERE project_id=$1",
      [project_id],
    );
    const targetNames = new Set(targetRows.map((row) => row.name));
    const conflicts = overwrite
      ? []
      : entries.map(({ name }) => name).filter((name) => targetNames.has(name));
    if (conflicts.length > 0) {
      return { copied: [], conflicts, missing: [] };
    }
    const newNames = entries
      .map(({ name }) => name)
      .filter((name) => !targetNames.has(name));
    if (targetNames.size + newNames.length > PROJECT_SECRETS_MAX_COUNT) {
      throw new Error(
        `project secret limit reached (${targetNames.size + newNames.length}/${PROJECT_SECRETS_MAX_COUNT})`,
      );
    }
    for (const { name, value, valueBytes } of entries) {
      const encrypted = encryptProjectSecretValue({
        project_id,
        name,
        value,
        key,
      });
      await db.query(
        `INSERT INTO project_secrets
           (project_id, name, encrypted_value, value_bytes, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW())
         ON CONFLICT (project_id, name) DO UPDATE SET
           encrypted_value=EXCLUDED.encrypted_value,
           value_bytes=EXCLUDED.value_bytes,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW()`,
        [project_id, name, JSON.stringify(encrypted), valueBytes, account_id],
      );
    }
    logger.info("project secrets imported", {
      project_id,
      account_id,
      count: entries.length,
      overwrite,
    });
    return {
      copied: entries.map(({ name }) => name),
      conflicts: [],
      missing: [],
    };
  });
}

export async function setProjectSecret({
  project_id,
  name,
  value,
  account_id,
  overwrite = true,
}: {
  project_id: string;
  name: string;
  value: string;
  account_id: string;
  overwrite?: boolean;
}): Promise<ProjectSecretMetadata> {
  const normalizedName = normalizeProjectSecretName(name);
  const valueBytes = validateProjectSecretValue(value);
  const key = await getProjectSecretsKey();
  const encrypted = encryptProjectSecretValue({
    project_id,
    name: normalizedName,
    value,
    key,
  });
  return await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const { rows: existingRows } = await db.query(
      `SELECT COUNT(*)::int AS count,
              BOOL_OR(name=$2) AS exists
       FROM project_secrets
       WHERE project_id=$1`,
      [project_id, normalizedName],
    );
    const count = Number(existingRows[0]?.count ?? 0);
    const exists = !!existingRows[0]?.exists;
    if (exists && !overwrite) {
      throw new Error(`project secret ${normalizedName} already exists`);
    }
    if (!exists && count >= PROJECT_SECRETS_MAX_COUNT) {
      throw new Error(
        `project secret limit reached (${count}/${PROJECT_SECRETS_MAX_COUNT})`,
      );
    }
    const conflictClause = overwrite
      ? `DO UPDATE SET
         encrypted_value=EXCLUDED.encrypted_value,
         value_bytes=EXCLUDED.value_bytes,
         updated_by=EXCLUDED.updated_by,
         updated_at=NOW()`
      : "DO NOTHING";
    const { rows } = await db.query(
      `INSERT INTO project_secrets
         (project_id, name, encrypted_value, value_bytes, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW())
       ON CONFLICT (project_id, name) ${conflictClause}
       RETURNING project_id, name, value_bytes, created_by, updated_by, created_at, updated_at`,
      [
        project_id,
        normalizedName,
        JSON.stringify(encrypted),
        valueBytes,
        account_id,
      ],
    );
    if (!rows[0]) {
      throw new Error(`project secret ${normalizedName} already exists`);
    }
    logger.info("project secret set", {
      project_id,
      name: normalizedName,
      account_id,
      created: !exists,
    });
    return metadata(rows[0]);
  });
}

export async function deleteProjectSecret({
  project_id,
  name,
  account_id,
}: {
  project_id: string;
  name: string;
  account_id: string;
}): Promise<boolean> {
  const normalizedName = normalizeProjectSecretName(name);
  await ensureProjectSecretsSchema();
  const { rowCount } = await pool().query(
    "DELETE FROM project_secrets WHERE project_id=$1 AND name=$2",
    [project_id, normalizedName],
  );
  const deleted = Number(rowCount ?? 0) > 0;
  logger.info("project secret deleted", {
    project_id,
    name: normalizedName,
    account_id,
    deleted,
  });
  return deleted;
}

export async function copyProjectSecrets({
  source_project_id,
  target_project_id,
  names,
  overwrite = false,
  account_id,
}: {
  source_project_id: string;
  target_project_id: string;
  names?: string[];
  overwrite?: boolean;
  account_id: string;
}): Promise<CopyProjectSecretsResult> {
  const selectedNames = normalizeNames(names);
  const key = await getProjectSecretsKey();
  return await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const params: any[] = [source_project_id];
    let nameSql = "";
    if (selectedNames) {
      params.push(selectedNames);
      nameSql = "AND name = ANY($2::TEXT[])";
    }
    const { rows: sourceRows } = await db.query(
      `SELECT name, encrypted_value, value_bytes
       FROM project_secrets
       WHERE project_id=$1 ${nameSql}
       ORDER BY name`,
      params,
    );
    const sourceByName = new Map(sourceRows.map((row) => [row.name, row]));
    const missing = (selectedNames ?? []).filter(
      (name) => !sourceByName.has(name),
    );
    if (missing.length > 0) {
      return { copied: [], conflicts: [], missing };
    }
    const copyNames = sourceRows.map((row) => row.name);
    if (copyNames.length === 0) {
      return { copied: [], conflicts: [], missing: [] };
    }
    const { rows: targetRows } = await db.query(
      `SELECT name FROM project_secrets WHERE project_id=$1`,
      [target_project_id],
    );
    const targetNames = new Set(targetRows.map((row) => row.name));
    const conflicts = overwrite
      ? []
      : copyNames.filter((name) => targetNames.has(name));
    if (conflicts.length > 0) {
      return { copied: [], conflicts, missing: [] };
    }
    const newNames = copyNames.filter((name) => !targetNames.has(name));
    if (targetNames.size + newNames.length > PROJECT_SECRETS_MAX_COUNT) {
      throw new Error(
        `project secret limit reached (${targetNames.size + newNames.length}/${PROJECT_SECRETS_MAX_COUNT})`,
      );
    }
    for (const row of sourceRows) {
      const value = decryptProjectSecretValue({
        project_id: source_project_id,
        name: row.name,
        encrypted: encryptedValue(row.encrypted_value),
        key,
      });
      const encrypted = encryptProjectSecretValue({
        project_id: target_project_id,
        name: row.name,
        value,
        key,
      });
      await db.query(
        `INSERT INTO project_secrets
           (project_id, name, encrypted_value, value_bytes, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW())
         ON CONFLICT (project_id, name) DO UPDATE SET
           encrypted_value=EXCLUDED.encrypted_value,
           value_bytes=EXCLUDED.value_bytes,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW()`,
        [
          target_project_id,
          row.name,
          JSON.stringify(encrypted),
          Number(row.value_bytes ?? validateProjectSecretValue(value)),
          account_id,
        ],
      );
    }
    logger.info("project secrets copied", {
      source_project_id,
      target_project_id,
      account_id,
      count: copyNames.length,
      overwrite,
    });
    return { copied: copyNames, conflicts: [], missing: [] };
  });
}
