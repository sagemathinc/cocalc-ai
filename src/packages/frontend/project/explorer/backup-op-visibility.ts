import { isDismissed } from "@cocalc/frontend/lro/utils";
import type { BackupLroState } from "@cocalc/frontend/project/backup-ops";

export function shouldDisplayBackupOp(op: BackupLroState): boolean {
  const summary = op.summary;
  if (!summary) {
    return true;
  }
  if (isDismissed(summary)) {
    return false;
  }
  return summary.status !== "succeeded";
}
