/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import rustic from "@cocalc/backend/sandbox/rustic";
import { parseOutput } from "@cocalc/backend/sandbox/exec";
import { getProjectBackupConfigForRepo } from "@cocalc/server/project-backup";

const RUSTIC_TIMEOUT_MS = 30 * 60 * 1000;

function backupIndexHost(project_id: string): string {
  return `project-${project_id}-index`;
}

function extractSnapshotIds(payload: any): string[] {
  const ids = new Set<string>();
  if (!Array.isArray(payload)) return [];
  for (const row of payload) {
    const snapshots = Array.isArray(row?.snapshots)
      ? row.snapshots
      : Array.isArray(row?.[1])
        ? row[1]
        : [];
    for (const snapshot of snapshots) {
      const id = `${snapshot?.id ?? ""}`.trim();
      if (id) {
        ids.add(id);
      }
    }
  }
  return Array.from(ids);
}

async function forgetAllSnapshotsForHost({
  repo,
  host,
}: {
  repo: string;
  host: string;
}): Promise<number> {
  const { stdout } = parseOutput(
    await rustic(["snapshots", "--json"], {
      repo,
      host,
      timeout: RUSTIC_TIMEOUT_MS,
      maxSize: 20_000_000,
    }),
  );
  let snapshots: any[] = [];
  try {
    snapshots = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `unable to parse rustic snapshot list for host '${host}': ${err}`,
    );
  }
  const ids = extractSnapshotIds(snapshots);
  if (!ids.length) {
    return 0;
  }
  for (const id of ids) {
    parseOutput(
      await rustic(["forget", id], {
        repo,
        host,
        timeout: RUSTIC_TIMEOUT_MS,
      }),
    );
  }
  return ids.length;
}

export type ProjectBackupPurgeResult = {
  skipped: boolean;
  deleted_snapshots: number;
  deleted_index_snapshots: number;
  reason?: string;
};

export async function purgeProjectBackupsForRepo({
  project_id,
  backup_repo_id,
  region,
}: {
  project_id: string;
  backup_repo_id?: string | null;
  region?: string | null;
}): Promise<ProjectBackupPurgeResult> {
  const { toml } = await getProjectBackupConfigForRepo({
    backup_repo_id,
    region,
  });
  if (!toml.trim()) {
    return {
      skipped: true,
      deleted_snapshots: 0,
      deleted_index_snapshots: 0,
      reason: "no backup configuration",
    };
  }

  const tempDir = await mkdtemp(join(tmpdir(), "cocalc-backup-purge-"));
  const repoToml = join(tempDir, "repo.toml");
  try {
    await writeFile(repoToml, toml, { mode: 0o600 });
    const deletedSnapshots = await forgetAllSnapshotsForHost({
      repo: repoToml,
      host: `project-${project_id}`,
    });
    const deletedIndexSnapshots = await forgetAllSnapshotsForHost({
      repo: repoToml,
      host: backupIndexHost(project_id),
    });
    return {
      skipped: false,
      deleted_snapshots: deletedSnapshots,
      deleted_index_snapshots: deletedIndexSnapshots,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
