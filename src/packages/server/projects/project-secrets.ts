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
import type {
  ProjectSecretsRuntimeCache,
  ProjectSecretsRuntimeRefreshResult,
} from "@cocalc/util/project-secrets";
import { normalizeCoursePath } from "@cocalc/util/course-path";
import { isValidUUID } from "@cocalc/util/misc";

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
  allow_course_sharing: boolean;
  revision: number;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

export interface CopyProjectSecretsResult {
  copied: string[];
  conflicts: string[];
  missing: string[];
  runtime_refresh?: ProjectSecretsRuntimeRefreshResult;
}

export interface ExportProjectSecretsForCopyResult {
  secrets: Record<string, string>;
  missing: string[];
}

export interface CourseManagedSecretInput {
  name: string;
  value: string;
  source_revision: number;
  grant_id: string;
}

export interface CourseManagedSecretsResult {
  copied: string[];
  unchanged: string[];
  conflicts: string[];
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

// Run once per process: the setup includes ALTER TABLE, which takes an ACCESS
// EXCLUSIVE lock even when nothing changes and queues every later query on the
// table behind any open transaction (production outage 2026-10-06).
let projectSecretsSchemaReady = false;

export async function ensureProjectSecretsSchema(
  db: Queryable = pool(),
): Promise<void> {
  if (projectSecretsSchemaReady) return;
  await db.query(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id UUID NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      encrypted_value JSONB NOT NULL,
      value_bytes INTEGER NOT NULL,
      created_by UUID,
      updated_by UUID,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      allow_course_sharing BOOLEAN NOT NULL DEFAULT FALSE,
      revision BIGINT NOT NULL DEFAULT 1,
      PRIMARY KEY (project_id, name)
    )
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS project_secrets_project_id_idx
      ON project_secrets(project_id)
  `);
  await db.query(`
    ALTER TABLE project_secrets
      ADD COLUMN IF NOT EXISTS allow_course_sharing BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await db.query(`
    ALTER TABLE project_secrets
      ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS project_secrets_runtime_state (
      project_id UUID PRIMARY KEY REFERENCES projects(project_id) ON DELETE CASCADE,
      generation BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await db.query(`
    INSERT INTO project_secrets_runtime_state(project_id, generation, updated_at)
    SELECT DISTINCT project_id, 1, NOW() FROM project_secrets
    ON CONFLICT (project_id) DO NOTHING
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS project_secret_managed_sources (
      project_id UUID NOT NULL,
      name TEXT NOT NULL,
      source_kind TEXT NOT NULL CHECK (source_kind = 'course'),
      source_project_id UUID NOT NULL,
      source_course_id UUID NOT NULL,
      source_policy_id UUID NOT NULL,
      source_grant_id UUID NOT NULL,
      source_secret_name TEXT NOT NULL,
      source_secret_revision BIGINT NOT NULL,
      installed_by UUID NOT NULL,
      installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, name),
      FOREIGN KEY (project_id, name)
        REFERENCES project_secrets(project_id, name) ON DELETE CASCADE
    )
  `);
  // These rows name the acting account, which may be homed on another bay
  // and have no local `accounts` row, so they must not reference accounts.
  await db.query(`
    ALTER TABLE project_secrets
      DROP CONSTRAINT IF EXISTS project_secrets_created_by_fkey,
      DROP CONSTRAINT IF EXISTS project_secrets_updated_by_fkey
  `);
  await db.query(`
    ALTER TABLE project_secret_managed_sources
      DROP CONSTRAINT IF EXISTS project_secret_managed_sources_installed_by_fkey
  `);
  // DDL inside a caller's transaction may still roll back.
  if (db === pool()) projectSecretsSchemaReady = true;
}

function metadata(row: any): ProjectSecretMetadata {
  return {
    project_id: row.project_id,
    name: row.name,
    value_bytes: Number(row.value_bytes ?? 0),
    allow_course_sharing: row.allow_course_sharing === true,
    revision: Number(row.revision ?? 1),
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
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
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

async function bumpRuntimeGeneration(
  db: Queryable,
  project_id: string,
): Promise<number> {
  const { rows } = await db.query(
    `INSERT INTO project_secrets_runtime_state(project_id, generation, updated_at)
     VALUES ($1, 1, NOW())
     ON CONFLICT (project_id) DO UPDATE SET
       generation=project_secrets_runtime_state.generation + 1,
       updated_at=NOW()
     RETURNING generation`,
    [project_id],
  );
  return Number(rows[0]?.generation ?? 0);
}

async function invalidateCoursePoliciesForSecrets(
  db: Queryable,
  project_id: string,
  names: string[],
): Promise<void> {
  if (names.length === 0) return;
  const { rows } = await db.query(
    "SELECT to_regclass('course_secret_grants') AS grants_table",
  );
  if (rows[0]?.grants_table == null) return;
  await db.query(
    `UPDATE course_secret_policies AS policies SET
       generation=policies.generation + 1,
       updated_at=NOW()
     WHERE policies.project_id=$1
       AND policies.revoked_at IS NULL
       AND EXISTS (
         SELECT 1 FROM course_secret_grants AS grants
         WHERE grants.policy_id=policies.policy_id
           AND grants.source_secret_name=ANY($2::TEXT[])
           AND grants.enabled=TRUE
           AND grants.revoked_at IS NULL
       )`,
    [project_id, names],
  );
}

function normalizeNames(names?: string[]): string[] | undefined {
  if (names == null) return undefined;
  return Array.from(new Set<string>(names.map(normalizeProjectSecretName)));
}

async function assertNotCourseManaged(
  db: Queryable,
  project_id: string,
  name: string,
): Promise<void> {
  const { rows } = await db.query(
    `SELECT 1 FROM project_secret_managed_sources
     WHERE project_id=$1 AND name=$2`,
    [project_id, name],
  );
  if (rows[0]) {
    throw new Error(`project secret ${name} is managed by a course`);
  }
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
    `SELECT project_id, name, value_bytes, allow_course_sharing, revision,
            created_by, updated_by, created_at, updated_at
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
    `SELECT state.generation, secrets.name, secrets.encrypted_value,
            secrets.value_bytes, secrets.updated_at
     FROM (
       SELECT COALESCE(
         (SELECT generation FROM project_secrets_runtime_state WHERE project_id=$1),
         0
       ) AS generation
     ) AS state
     LEFT JOIN project_secrets AS secrets ON secrets.project_id=$1
     ORDER BY secrets.name`,
    [project_id],
  );
  return {
    key_base64: key.toString("base64"),
    generation: Number(rows[0]?.generation ?? 0),
    entries: rows
      .filter((row) => row.name != null)
      .map((row) => ({
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
    if (overwrite) {
      for (const { name } of entries) {
        await assertNotCourseManaged(db, project_id, name);
      }
    }
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
           (project_id, name, encrypted_value, value_bytes, created_by, updated_by,
            created_at, updated_at, allow_course_sharing, revision)
         VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW(), FALSE, 1)
         ON CONFLICT (project_id, name) DO UPDATE SET
           encrypted_value=EXCLUDED.encrypted_value,
           value_bytes=EXCLUDED.value_bytes,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW(),
           allow_course_sharing=FALSE,
           revision=project_secrets.revision + 1`,
        [project_id, name, JSON.stringify(encrypted), valueBytes, account_id],
      );
    }
    await invalidateCoursePoliciesForSecrets(
      db,
      project_id,
      entries.map(({ name }) => name),
    );
    await bumpRuntimeGeneration(db, project_id);
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
    await assertNotCourseManaged(db, project_id, normalizedName);
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
         updated_at=NOW(),
         revision=project_secrets.revision + 1`
      : "DO NOTHING";
    const { rows } = await db.query(
      `INSERT INTO project_secrets
         (project_id, name, encrypted_value, value_bytes, created_by, updated_by,
          created_at, updated_at, allow_course_sharing, revision)
       VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW(), FALSE, 1)
       ON CONFLICT (project_id, name) ${conflictClause}
       RETURNING project_id, name, value_bytes, allow_course_sharing, revision,
                 created_by, updated_by, created_at, updated_at`,
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
    await invalidateCoursePoliciesForSecrets(db, project_id, [normalizedName]);
    await bumpRuntimeGeneration(db, project_id);
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
  const deleted = await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    await assertNotCourseManaged(db, project_id, normalizedName);
    const { rowCount } = await db.query(
      "DELETE FROM project_secrets WHERE project_id=$1 AND name=$2",
      [project_id, normalizedName],
    );
    const didDelete = Number(rowCount ?? 0) > 0;
    if (didDelete) {
      await invalidateCoursePoliciesForSecrets(db, project_id, [
        normalizedName,
      ]);
      await bumpRuntimeGeneration(db, project_id);
    }
    return didDelete;
  });
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
  exclude_names,
  overwrite = false,
  account_id,
}: {
  source_project_id: string;
  target_project_id: string;
  names?: string[];
  exclude_names?: string[];
  overwrite?: boolean;
  account_id: string;
}): Promise<CopyProjectSecretsResult> {
  const selectedNames = normalizeNames(names);
  const excludedNames = normalizeNames(exclude_names) ?? [];
  const key = await getProjectSecretsKey();
  return await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const params: any[] = [source_project_id];
    let nameSql = "";
    if (selectedNames) {
      params.push(selectedNames);
      nameSql = "AND name = ANY($2::TEXT[])";
    }
    if (excludedNames.length) {
      params.push(excludedNames);
      nameSql += ` AND NOT name = ANY($${params.length}::TEXT[])`;
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
    if (overwrite) {
      for (const name of copyNames) {
        await assertNotCourseManaged(db, target_project_id, name);
      }
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
           (project_id, name, encrypted_value, value_bytes, created_by, updated_by,
            created_at, updated_at, allow_course_sharing, revision)
         VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW(), FALSE, 1)
         ON CONFLICT (project_id, name) DO UPDATE SET
           encrypted_value=EXCLUDED.encrypted_value,
           value_bytes=EXCLUDED.value_bytes,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW(),
           allow_course_sharing=FALSE,
           revision=project_secrets.revision + 1`,
        [
          target_project_id,
          row.name,
          JSON.stringify(encrypted),
          Number(row.value_bytes ?? validateProjectSecretValue(value)),
          account_id,
        ],
      );
    }
    await invalidateCoursePoliciesForSecrets(db, target_project_id, copyNames);
    await bumpRuntimeGeneration(db, target_project_id);
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

export async function setProjectSecretCourseSharing({
  project_id,
  name,
  allow,
  account_id,
}: {
  project_id: string;
  name: string;
  allow: boolean;
  account_id: string;
}): Promise<ProjectSecretMetadata> {
  const normalizedName = normalizeProjectSecretName(name);
  const result = await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const { rows } = await db.query(
      `UPDATE project_secrets SET
         allow_course_sharing=$3,
         updated_by=$4,
         updated_at=NOW()
       WHERE project_id=$1 AND name=$2
       RETURNING project_id, name, value_bytes, allow_course_sharing, revision,
                 created_by, updated_by, created_at, updated_at`,
      [project_id, normalizedName, allow, account_id],
    );
    if (!rows[0]) {
      throw new Error(`project secret ${normalizedName} does not exist`);
    }
    await invalidateCoursePoliciesForSecrets(db, project_id, [normalizedName]);
    return metadata(rows[0]);
  });
  logger.info("project secret course sharing eligibility changed", {
    project_id,
    name: normalizedName,
    allow,
    account_id,
  });
  return result;
}

export async function listCourseShareableSecrets({
  project_id,
  db = pool(),
}: {
  project_id: string;
  db?: Queryable;
}): Promise<ProjectSecretMetadata[]> {
  return (await listProjectSecrets({ project_id, db })).filter(
    ({ allow_course_sharing }) => allow_course_sharing,
  );
}

export async function getCourseShareableSecretValues({
  project_id,
  names,
  db = pool(),
}: {
  project_id: string;
  names: string[];
  db?: Queryable;
}): Promise<
  Array<{ name: string; value: string; revision: number; value_bytes: number }>
> {
  await ensureProjectSecretsSchema(db);
  const selected = normalizeNames(names) ?? [];
  if (selected.length === 0) return [];
  const key = await getProjectSecretsKey();
  const { rows } = await db.query(
    `SELECT name, encrypted_value, revision, value_bytes
     FROM project_secrets
     WHERE project_id=$1
       AND name=ANY($2::TEXT[])
       AND allow_course_sharing=TRUE
     ORDER BY name`,
    [project_id, selected],
  );
  const found = new Set(rows.map(({ name }) => name));
  const unavailable = selected.filter((name) => !found.has(name));
  if (unavailable.length > 0) {
    throw new Error(
      `course sharing is unavailable for secret(s): ${unavailable.join(", ")}`,
    );
  }
  return rows.map((row) => ({
    name: row.name,
    value: decryptProjectSecretValue({
      project_id,
      name: row.name,
      encrypted: encryptedValue(row.encrypted_value),
      key,
    }),
    revision: Number(row.revision ?? 1),
    value_bytes: Number(row.value_bytes ?? 0),
  }));
}

function parsedCourse(value: any): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export type CourseSecretTargetAssociationReason =
  | "eligible"
  | "not_found"
  | "not_student_project"
  | "wrong_course_project"
  | "wrong_course_path";

export async function validateCourseSecretTargetAssociation({
  project_id,
  course_project_id,
  course_path,
  db = pool(),
  lock = false,
}: {
  project_id: string;
  course_project_id: string;
  course_path: string;
  db?: Queryable;
  lock?: boolean;
}): Promise<CourseSecretTargetAssociationReason> {
  if (!isValidUUID(project_id) || !isValidUUID(course_project_id)) {
    throw new Error("invalid course-managed secret identity");
  }
  const normalizedPath = normalizeCoursePath(course_path);
  const { rows } = await db.query(
    `SELECT course FROM projects
     WHERE project_id=$1 AND deleted IS NOT TRUE
     ${lock ? "FOR UPDATE" : ""}`,
    [project_id],
  );
  if (!rows[0]) return "not_found";
  const course = parsedCourse(rows[0].course);
  if (course?.type !== "student") return "not_student_project";
  if (course.project_id !== course_project_id) return "wrong_course_project";
  try {
    if (normalizeCoursePath(course.path ?? "") !== normalizedPath) {
      return "wrong_course_path";
    }
  } catch {
    return "wrong_course_path";
  }
  return "eligible";
}

export async function installCourseManagedProjectSecrets({
  project_id,
  course_project_id,
  course_id,
  course_path,
  policy_id,
  secrets,
  account_id,
}: {
  project_id: string;
  course_project_id: string;
  course_id: string;
  course_path: string;
  policy_id: string;
  secrets: CourseManagedSecretInput[];
  account_id: string;
}): Promise<CourseManagedSecretsResult> {
  if (
    !isValidUUID(project_id) ||
    !isValidUUID(course_project_id) ||
    !isValidUUID(course_id) ||
    !isValidUUID(policy_id)
  ) {
    throw new Error("invalid course-managed secret identity");
  }
  const normalizedPath = normalizeCoursePath(course_path);
  const normalizedSecrets = secrets.map((secret) => ({
    ...secret,
    name: normalizeProjectSecretName(secret.name),
    grant_id: (() => {
      if (!isValidUUID(secret.grant_id)) {
        throw new Error("invalid course secret grant identity");
      }
      return secret.grant_id;
    })(),
    value_bytes: validateProjectSecretValue(secret.value),
  }));
  if (
    new Set(normalizedSecrets.map(({ name }) => name)).size !==
    normalizedSecrets.length
  ) {
    throw new Error("duplicate course-managed secret names");
  }
  if (normalizedSecrets.length === 0) {
    return { copied: [], unchanged: [], conflicts: [] };
  }
  const key = await getProjectSecretsKey();
  return await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const association = await validateCourseSecretTargetAssociation({
      project_id,
      course_project_id,
      course_path: normalizedPath,
      db,
      lock: true,
    });
    if (association !== "eligible") {
      throw new Error("target project is not linked to this course");
    }
    const names = normalizedSecrets.map(({ name }) => name);
    const { rows: existingRows } = await db.query(
      `SELECT secrets.name, managed.source_policy_id,
              managed.source_grant_id, managed.source_secret_revision
       FROM project_secrets AS secrets
       LEFT JOIN project_secret_managed_sources AS managed
         ON managed.project_id=secrets.project_id AND managed.name=secrets.name
       WHERE secrets.project_id=$1 AND secrets.name=ANY($2::TEXT[])`,
      [project_id, names],
    );
    const existing = new Map(existingRows.map((row) => [row.name, row]));
    const conflicts: string[] = [];
    const unchanged: string[] = [];
    const writable: typeof normalizedSecrets = [];
    for (const secret of normalizedSecrets) {
      const row = existing.get(secret.name);
      if (!row) {
        writable.push(secret);
      } else if (
        row.source_policy_id === policy_id &&
        row.source_grant_id === secret.grant_id
      ) {
        if (Number(row.source_secret_revision) === secret.source_revision) {
          unchanged.push(secret.name);
        } else {
          writable.push(secret);
        }
      } else {
        conflicts.push(secret.name);
      }
    }
    const { rows: countRows } = await db.query(
      "SELECT COUNT(*)::int AS count FROM project_secrets WHERE project_id=$1",
      [project_id],
    );
    const newCount = writable.filter(({ name }) => !existing.has(name)).length;
    if (
      Number(countRows[0]?.count ?? 0) + newCount >
      PROJECT_SECRETS_MAX_COUNT
    ) {
      throw new Error("project secret limit reached");
    }
    for (const secret of writable) {
      const encrypted = encryptProjectSecretValue({
        project_id,
        name: secret.name,
        value: secret.value,
        key,
      });
      await db.query(
        `INSERT INTO project_secrets
           (project_id, name, encrypted_value, value_bytes, created_by, updated_by,
            created_at, updated_at, allow_course_sharing, revision)
         VALUES ($1, $2, $3::JSONB, $4, $5, $5, NOW(), NOW(), FALSE, 1)
         ON CONFLICT (project_id, name) DO UPDATE SET
           encrypted_value=EXCLUDED.encrypted_value,
           value_bytes=EXCLUDED.value_bytes,
           updated_by=EXCLUDED.updated_by,
           updated_at=NOW(),
           revision=project_secrets.revision + 1`,
        [
          project_id,
          secret.name,
          JSON.stringify(encrypted),
          secret.value_bytes,
          account_id,
        ],
      );
      await db.query(
        `INSERT INTO project_secret_managed_sources
           (project_id, name, source_kind, source_project_id, source_course_id,
            source_policy_id, source_grant_id, source_secret_name,
            source_secret_revision, installed_by, installed_at, updated_at)
         VALUES ($1, $2, 'course', $3, $4, $5, $6, $2, $7, $8, NOW(), NOW())
         ON CONFLICT (project_id, name) DO UPDATE SET
           source_secret_revision=EXCLUDED.source_secret_revision,
           installed_by=EXCLUDED.installed_by,
           updated_at=NOW()`,
        [
          project_id,
          secret.name,
          course_project_id,
          course_id,
          policy_id,
          secret.grant_id,
          secret.source_revision,
          account_id,
        ],
      );
    }
    if (writable.length > 0) {
      await bumpRuntimeGeneration(db, project_id);
    }
    logger.info("course-managed project secrets installed", {
      project_id,
      course_project_id,
      policy_id,
      copied: writable.map(({ name }) => name),
      unchanged,
      conflicts,
      account_id,
    });
    return {
      copied: writable.map(({ name }) => name),
      unchanged,
      conflicts,
    };
  });
}

export async function removeCourseManagedProjectSecrets({
  project_id,
  policy_id,
  names,
  account_id,
}: {
  project_id: string;
  policy_id: string;
  names?: string[];
  account_id: string;
}): Promise<{ removed: string[] }> {
  const selected = normalizeNames(names);
  return await withTransaction(async (db) => {
    await ensureProjectSecretsSchema(db);
    const params: any[] = [project_id, policy_id];
    let selectedSql = "";
    if (selected) {
      params.push(selected);
      selectedSql = "AND name=ANY($3::TEXT[])";
    }
    const { rows } = await db.query(
      `SELECT name FROM project_secret_managed_sources
       WHERE project_id=$1 AND source_policy_id=$2 ${selectedSql}
       ORDER BY name`,
      params,
    );
    const removed = rows.map(({ name }) => name);
    if (removed.length > 0) {
      await db.query(
        `DELETE FROM project_secrets
         WHERE project_id=$1 AND name=ANY($2::TEXT[])`,
        [project_id, removed],
      );
      await bumpRuntimeGeneration(db, project_id);
    }
    logger.info("course-managed project secrets removed", {
      project_id,
      policy_id,
      removed,
      account_id,
    });
    return { removed };
  });
}
