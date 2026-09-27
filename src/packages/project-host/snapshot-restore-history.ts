import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { btrfs, sudo } from "@cocalc/file-server/btrfs/util";
import { assertValidSnapshotName } from "@cocalc/util/snapshot-name";

export async function replaceSnapshotHome({
  home,
  replacement,
  retired,
  record,
}: {
  home: string;
  replacement: string;
  retired: string;
  record: () => Promise<unknown>;
}): Promise<void> {
  await sudo({ command: "mv", args: [home, retired] });
  let installed = false;
  try {
    await sudo({ command: "mv", args: [replacement, home] });
    installed = true;
    await record();
  } catch (err) {
    let restored = false;
    try {
      if (installed) {
        await sudo({ command: "mv", args: [home, replacement] });
      }
      await sudo({ command: "mv", args: [retired, home] });
      restored = true;
      await record();
    } catch (rollbackError) {
      throw new Error(
        `snapshot restore rollback failed; original HOME retained at ${restored ? home : retired}; restore: ${err}; rollback: ${rollbackError}`,
      );
    }
    throw err;
  }
}

// Btrfs snapshots are not recursive: a HOME clone contains empty placeholders,
// not the original nested snapshots. Populate history before replacing HOME.
export async function preserveSnapshotHistory({
  home,
  replacement,
  copied,
}: {
  home: string;
  replacement: string;
  copied: string[];
}): Promise<void> {
  const source = join(home, ".snapshots");
  const dest = join(replacement, ".snapshots");
  if (!(await lstat(source)).isDirectory()) {
    throw new Error("snapshot history must be a directory");
  }
  const entries = await readdir(source, { withFileTypes: true });
  // Fail closed on unrecognized entries rather than silently omitting history.
  for (const entry of entries) {
    if (entry.isDirectory()) {
      assertValidSnapshotName(entry.name);
    } else if (
      entry.isFile() &&
      entry.name.startsWith(".") &&
      entry.name.endsWith(".lock")
    ) {
      assertValidSnapshotName(entry.name.slice(1, -5));
    } else {
      throw new Error(`unexpected snapshot history entry: ${entry.name}`);
    }
  }
  // Only the private, newly-created nonrecursive clone is cleared here.
  await sudo({ command: "rm", args: ["-rf", dest] });
  await mkdir(dest, { mode: 0o700 });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await btrfs({
      args: [
        "subvolume",
        "snapshot",
        "-r",
        join(source, entry.name),
        join(dest, entry.name),
      ],
      err_on_exit: true,
      verbose: false,
    });
    copied.push(entry.name);
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      // Locks are empty presence markers, not user content to follow/copy.
      await writeFile(join(dest, entry.name), "", { flag: "wx" });
    }
  }
}

// Only use for redundant history: either a failed private clone while the
// original HOME is intact, or the retired HOME after all history was preserved.
// Delete exactly the copied snapshots, without invoking retention/lock policy.
export async function deleteRedundantSnapshotHome({
  home,
  copied,
}: {
  home: string;
  copied: string[];
}): Promise<void> {
  for (const name of copied) {
    await btrfs({
      args: [
        "subvolume",
        "delete",
        join(home, ".snapshots", assertValidSnapshotName(name)),
      ],
      err_on_exit: true,
      verbose: false,
    });
  }
  await btrfs({
    args: ["subvolume", "delete", home],
    err_on_exit: true,
    verbose: false,
  });
}
