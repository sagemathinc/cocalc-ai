import {
  SNAPSHOT_HOME_RESTORE_UNAVAILABLE,
  type Fileserver,
  type SnapshotRestoreMode,
} from "@cocalc/conat/files/file-server";

// Throws if the project's host would refuse to restore a snapshot with this
// mode (file-server checkSnapshotRestore), so the restore is refused before
// the project is stopped.  A host from before the check would restore a
// files-only snapshot (made by a newer host, e.g. before a rollback or a
// move) as if it held the history: a whole-home restore is refused there too.
export async function assertSnapshotRestoreAllowed({
  client,
  project_id,
  mode,
}: {
  client: Fileserver;
  project_id: string;
  mode: SnapshotRestoreMode;
}): Promise<void> {
  try {
    await client.checkSnapshotRestore({ project_id, mode });
  } catch (err) {
    if (isMissingCheck(err)) {
      if (mode === "rootfs") return;
      throw new Error(SNAPSHOT_HOME_RESTORE_UNAVAILABLE);
    }
    throw err;
  }
}

// How a host without checkSnapshotRestore answers, depending on the transport
// (fast-rpc, the core client's call, the request service).
function isMissingCheck(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err}`;
  return (
    (message.includes("checkSnapshotRestore") &&
      (message.includes("unknown service method") ||
        message.includes("not defined"))) ||
    message.includes("impl[mesg.name] is not a function")
  );
}
