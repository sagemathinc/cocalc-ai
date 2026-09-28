import { sudo } from "@cocalc/file-server/btrfs/util";

export class SnapshotHomeSwapError extends Error {
  constructor(
    readonly errors: unknown[],
    previous: string,
  ) {
    super(
      `Snapshot home swap and rollback failed; preserved home may remain at ${previous}`,
    );
    this.name = "SnapshotHomeSwapError";
  }
}

/** All paths are host-generated siblings/subvolumes under the storage root. */
export async function swapSnapshotHome({
  home,
  replacement,
  previous,
  record,
}: {
  home: string;
  replacement: string;
  previous: string;
  record: () => Promise<void>;
}): Promise<void> {
  const move = async (source: string, destination: string) => {
    await sudo({ command: "mv", args: [source, destination] });
  };
  let originalMoved = false;
  let installed = false;
  try {
    await move(home, previous);
    originalMoved = true;
    await move(replacement, home);
    installed = true;
    await record();
  } catch (error) {
    try {
      // Return the failed replacement to staging without deleting either tree.
      if (installed) await move(home, replacement);
      if (originalMoved) await move(previous, home);
      await record();
    } catch (rollbackError) {
      throw new SnapshotHomeSwapError([error, rollbackError], previous);
    }
    throw error;
  }
}
