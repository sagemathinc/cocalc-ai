/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */
import { randomUUID } from "node:crypto";
import type { BackupAttemptUpdate } from "@cocalc/util/types/backup-attempt";

export async function withBackupAttempt<T>({
  enabled,
  project_id,
  record,
  run,
  reportingFailed,
}: {
  enabled: boolean;
  project_id: string;
  record: (update: BackupAttemptUpdate) => Promise<void>;
  run: (confirm: (backup_id: string) => Promise<void>) => Promise<T>;
  reportingFailed: (error: unknown) => void;
}): Promise<T> {
  if (!enabled) return await run(async () => {});
  const attempt_id = randomUUID();
  // No backup work starts if its attempt cannot be recorded durably. A worker
  // death subsequently leaves "unconfirmed", never an invented successful run.
  await record({ project_id, attempt_id, action: "start" });
  let confirmed = false;
  try {
    const result = await run(async (backup_id) => {
      await record({ project_id, attempt_id, action: "finish", backup_id });
      confirmed = true;
    });
    if (!confirmed)
      throw new Error(
        "Backup returned without confirming protected completion evidence",
      );
    return result;
  } catch (error) {
    if (!confirmed) {
      try {
        await record({ project_id, attempt_id, action: "finish" });
      } catch (reportError) {
        reportingFailed(reportError);
      }
    }
    throw error;
  }
}
