import { isDismissed } from "@cocalc/frontend/lro/utils";
import type { BackupLroState } from "@cocalc/frontend/project/backup-ops";
import { hasOversizedFiles } from "@cocalc/util/consts/backups";

export function shouldDisplayBackupOp(op: BackupLroState): boolean {
  const summary = op.summary;
  if (!summary) {
    return true;
  }
  if (isDismissed(summary)) {
    return false;
  }
  if (summary.status === "succeeded") {
    // Keep a finished backup visible when it skipped files, so the user sees
    // what is not protected.
    return hasOversizedFiles(summary.result?.oversized_files);
  }
  return true;
}
