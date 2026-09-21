import { exists } from "@cocalc/backend/misc/async-utils-node";
import { sudo } from "@cocalc/file-server/btrfs/util";

/** Prepare only the disposable clone; keep the live home intact for rollback. */
export async function prepareHomeSnapshotRootfs({
  current,
  staged,
}: {
  current: string;
  staged: string;
}): Promise<void> {
  if (current === staged)
    throw Error("Snapshot staging must differ from live rootfs");
  await sudo({ command: "rm", args: ["-rf", staged] });
  if (!(await exists(current))) return;
  // Ordinary directories cannot be renamed across Btrfs subvolumes. Use the
  // existing anchored helper, never a direct privileged path-based fallback.
  await sudo({ command: "copy-tree-reflink", args: [current, staged] });
}
