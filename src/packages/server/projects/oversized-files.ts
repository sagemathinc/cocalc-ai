/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
Moves, archives, and cross-host copies restore from backups, and backups leave
out files larger than the project's backup file size limit. These operations
must not silently drop such files: the user confirms the skipped list in the
UI, which sends allow_oversized_skip. Without that confirmation, including
unattended operations, they are refused.
*/

import getLogger from "@cocalc/backend/logger";
import {
  hasOversizedFiles,
  oversizedFilesMessage,
  type OversizedFilesReport,
} from "@cocalc/util/consts/backups";

const log = getLogger("server:projects:oversized-files");

const SCAN_TIMEOUT_MS = 10 * 60_000;

export class OversizedFilesError extends Error {
  constructor(
    action: string,
    public readonly report: OversizedFilesReport,
  ) {
    super(oversizedFilesMessage(action, report));
    this.name = "OversizedFilesError";
  }
}

function isUnsupportedHost(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`;
  return (
    text.includes("getOversizedFiles") &&
    (text.includes("not defined") || text.includes("unknown service method"))
  );
}

export async function getOversizedFiles({
  project_id,
  account_id,
  paths,
}: {
  project_id: string;
  account_id?: string;
  paths?: string[];
}): Promise<OversizedFilesReport | null> {
  try {
    const { getProjectFileServerClient } =
      await import("@cocalc/server/conat/file-server-client");
    const client = await getProjectFileServerClient({
      project_id,
      account_id,
      timeout: SCAN_TIMEOUT_MS,
    });
    return await client.getOversizedFiles({ project_id, paths });
  } catch (err) {
    // A host from before the size limit backs up every file.
    if (isUnsupportedHost(err)) return null;
    throw err;
  }
}

// Refuse the action if a backup of the project (or just of paths) would leave
// files out, unless the caller confirmed that they may be skipped.
export async function assertOversizedFilesAllowed({
  project_id,
  account_id,
  paths,
  action,
  allow_oversized_skip,
}: {
  project_id: string;
  account_id?: string;
  paths?: string[];
  action: string;
  allow_oversized_skip?: boolean;
}): Promise<void> {
  if (allow_oversized_skip) return;
  const report = await getOversizedFiles({ project_id, account_id, paths });
  if (hasOversizedFiles(report)) {
    log.info("refusing operation that would skip oversized files", {
      project_id,
      action,
      count: report.count,
    });
    throw new OversizedFilesError(action, report);
  }
}

// The authoritative check, on the backup an operation will restore from.
export function assertBackupOversizedFilesAllowed({
  backup_result,
  action,
  allow_oversized_skip,
}: {
  backup_result: { oversized_files?: unknown } | null | undefined;
  action: string;
  allow_oversized_skip?: boolean;
}): void {
  const report = backup_result?.oversized_files;
  if (!allow_oversized_skip && hasOversizedFiles(report)) {
    throw new OversizedFilesError(action, report);
  }
}
