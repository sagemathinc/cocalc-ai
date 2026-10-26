/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
The last health-probe result of each shared project-backup repository.

repo-health.ts writes one row per repository after each probe; the shard
admin status and admin health read them. The rows are observations about
project_backup_repos rows on the same (repository-authoritative) bay.
*/

import getPool from "@cocalc/database/pool";

export type ProjectBackupRepoProbeResult = "ok" | "failed";

// Why a probe failed. All but "timeout" and "error" are deterministic:
// retrying will not help until someone acts. "cleanup_failed" means the
// temporary profile, which holds the repository credentials, was left on
// disk.
export type ProjectBackupRepoProbeErrorKind =
  | "wrong_password"
  | "missing_config"
  | "no_config"
  | "cleanup_failed"
  | "timeout"
  | "error";

export const DETERMINISTIC_PROBE_ERROR_KINDS: ReadonlySet<ProjectBackupRepoProbeErrorKind> =
  new Set(["wrong_password", "missing_config", "no_config", "cleanup_failed"]);

export interface ProjectBackupRepoProbeRow {
  repo_id: string;
  last_probe_at: Date;
  last_result: ProjectBackupRepoProbeResult;
  last_error_kind: ProjectBackupRepoProbeErrorKind | null;
  last_error: string | null;
  last_ok_at: Date | null;
  failing_since: Date | null;
  consecutive_failures: number;
  duration_ms: number | null;
}

let schemaReady: Promise<void> | undefined;

export async function ensureProjectBackupRepoProbeSchema(): Promise<void> {
  schemaReady ??= getPool()
    .query(
      `CREATE TABLE IF NOT EXISTS project_backup_repo_probes (
        repo_id UUID PRIMARY KEY,
        last_probe_at TIMESTAMPTZ NOT NULL,
        last_result TEXT NOT NULL,
        last_error_kind TEXT,
        last_error TEXT,
        last_ok_at TIMESTAMPTZ,
        failing_since TIMESTAMPTZ,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER
      )`,
    )
    .then(() => undefined)
    .catch((err) => {
      schemaReady = undefined;
      throw err;
    });
  await schemaReady;
}

export async function recordProjectBackupRepoProbe({
  repo_id,
  probed_at,
  result,
  error_kind,
  error,
  duration_ms,
}: {
  repo_id: string;
  probed_at: Date;
  result: ProjectBackupRepoProbeResult;
  error_kind?: ProjectBackupRepoProbeErrorKind | null;
  error?: string | null;
  duration_ms?: number | null;
}): Promise<void> {
  await ensureProjectBackupRepoProbeSchema();
  const ok = result === "ok";
  await getPool().query(
    `INSERT INTO project_backup_repo_probes AS p
       (repo_id, last_probe_at, last_result, last_error_kind, last_error,
        last_ok_at, failing_since, consecutive_failures, duration_ms)
     VALUES ($1::UUID, $2, $3, $4, $5,
             CASE WHEN $6 THEN $2::TIMESTAMPTZ END,
             CASE WHEN $6 THEN NULL ELSE $2::TIMESTAMPTZ END,
             CASE WHEN $6 THEN 0 ELSE 1 END,
             $7)
     ON CONFLICT (repo_id) DO UPDATE SET
       last_probe_at = EXCLUDED.last_probe_at,
       last_result = EXCLUDED.last_result,
       last_error_kind = EXCLUDED.last_error_kind,
       last_error = EXCLUDED.last_error,
       last_ok_at = COALESCE(EXCLUDED.last_ok_at, p.last_ok_at),
       failing_since = CASE WHEN $6 THEN NULL
                            ELSE COALESCE(p.failing_since, EXCLUDED.failing_since)
                       END,
       consecutive_failures = CASE WHEN $6 THEN 0
                                   ELSE p.consecutive_failures + 1
                              END,
       duration_ms = EXCLUDED.duration_ms`,
    [
      repo_id,
      probed_at,
      result,
      ok ? null : (error_kind ?? "error"),
      ok ? null : (error ?? null),
      ok,
      duration_ms ?? null,
    ],
  );
}
