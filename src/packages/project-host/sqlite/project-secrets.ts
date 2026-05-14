/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getDatabase, initDatabase } from "@cocalc/lite/hub/sqlite/database";
import type {
  EncryptedProjectSecretValue,
  ProjectSecretRuntimeCacheEntry,
} from "@cocalc/util/project-secrets";

export interface CachedProjectSecretRow {
  project_id: string;
  name: string;
  encrypted_value: EncryptedProjectSecretValue;
  value_bytes: number;
  updated_at: number;
}

function ensureProjectSecretsTable(): void {
  const db = initDatabase();
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_secrets (
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      encrypted_value TEXT NOT NULL,
      value_bytes INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, name)
    )
  `);
  db.exec(
    "CREATE INDEX IF NOT EXISTS project_secrets_project_id_idx ON project_secrets(project_id)",
  );
}

function updatedAtMs(value?: string | number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

export function replaceCachedProjectSecrets({
  project_id,
  entries,
}: {
  project_id: string;
  entries: ProjectSecretRuntimeCacheEntry[];
}): void {
  ensureProjectSecretsTable();
  const db = getDatabase();
  const insert = db.prepare(`
    INSERT INTO project_secrets(project_id, name, encrypted_value, value_bytes, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  db.exec("BEGIN");
  try {
    db.prepare("DELETE FROM project_secrets WHERE project_id=?").run(
      project_id,
    );
    for (const entry of entries) {
      insert.run(
        project_id,
        entry.name,
        JSON.stringify(entry.encrypted_value),
        entry.value_bytes,
        updatedAtMs(entry.updated_at),
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}

export function getCachedProjectSecrets(
  project_id: string,
): CachedProjectSecretRow[] {
  ensureProjectSecretsTable();
  const rows = getDatabase()
    .prepare(
      `SELECT project_id, name, encrypted_value, value_bytes, updated_at
       FROM project_secrets
       WHERE project_id=?
       ORDER BY name`,
    )
    .all(project_id);
  return rows.map((row: any) => ({
    project_id: row.project_id,
    name: row.name,
    encrypted_value: JSON.parse(row.encrypted_value),
    value_bytes: Number(row.value_bytes ?? 0),
    updated_at: Number(row.updated_at ?? 0),
  }));
}
