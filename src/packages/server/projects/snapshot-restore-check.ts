import type {
  Fileserver,
  SnapshotRestoreMode,
} from "@cocalc/conat/files/file-server";

// Throws if the project's host would refuse to restore a snapshot with this
// mode (file-server checkSnapshotRestore), so the restore is refused before
// the project is stopped.  A host from before the check doesn't refuse.
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
    if (
      `${(err as any)?.message ?? err}`.includes(
        "unknown service method 'checkSnapshotRestore'",
      )
    ) {
      return;
    }
    throw err;
  }
}
