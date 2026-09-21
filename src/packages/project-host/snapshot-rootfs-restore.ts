import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { sudo } from "@cocalc/file-server/btrfs/util";

/** The project and dependent rootfs mounts must be stopped before this call. */
export async function restoreSnapshotRootfs({
  current,
  snapshot,
}: {
  current: string;
  snapshot: string;
}): Promise<void> {
  if (current === snapshot)
    throw Error("Snapshot rootfs must differ from live rootfs");
  const id = randomUUID();
  // Keep both rename destinations in the live rootfs's subvolume. Ordinary
  // directories cannot be renamed across the snapshot clone's subvolume.
  const replacement = `${current}.restore-new-${id}`;
  const previous = `${current}.restore-old-${id}`;
  const move = (src: string, dest: string) =>
    sudo({ command: "mv", args: [src, dest] });
  let originalMoved = false;
  try {
    const hasSnapshot = await exists(snapshot);
    if (hasSnapshot) {
      await sudo({ command: "mkdir", args: ["-p", dirname(current)] });
      await sudo({
        command: "copy-tree-reflink",
        args: [snapshot, replacement],
      });
    }
    if (await exists(current)) {
      await move(current, previous);
      originalMoved = true;
    }
    try {
      if (hasSnapshot) await move(replacement, current);
    } catch (error) {
      if (originalMoved) {
        try {
          await move(previous, current);
          originalMoved = false;
        } catch {
          // Never delete the only preserved copy when rollback cannot finish.
          throw new Error(
            `Snapshot rootfs install and rollback failed; previous rootfs retained at ${previous}`,
          );
        }
      }
      throw error;
    }
    if (originalMoved) await sudo({ command: "rm", args: ["-rf", previous] });
  } finally {
    await sudo({ command: "rm", args: ["-rf", replacement] }).catch(() => {});
  }
}
