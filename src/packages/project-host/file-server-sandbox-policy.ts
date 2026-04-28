import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import {
  getSnapshotPathTarget,
  type SnapshotPathTarget,
} from "@cocalc/util/consts/snapshots";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";

export function createProjectSandboxFilesystem({
  project_id,
  home,
  rootfs,
  scratch,
  deleteSnapshot,
}: {
  project_id: string;
  home: string;
  rootfs: string;
  scratch: string;
  deleteSnapshot?: (name: string) => Promise<void>;
}): SandboxedFilesystem {
  const fs = new SandboxedFilesystem(home, {
    host: project_id,
    rootfs,
    scratch,
    homeAliases: [DEFAULT_PROJECT_RUNTIME_HOME],
  });
  const baseRm = fs.rm.bind(fs);
  const baseRmdir = fs.rmdir.bind(fs);
  const classifySnapshotTarget = (
    inputPath: string,
  ): SnapshotPathTarget | undefined =>
    getSnapshotPathTarget(inputPath, { homePath: home });
  const assertSupportedSnapshotDeleteTarget = (
    inputPath: string,
    target: SnapshotPathTarget,
  ): string => {
    if (target.kind === "snapshot") {
      return target.name;
    }
    if (target.kind === "snapshots-root") {
      throw new Error(
        "Delete snapshots individually, not the .snapshots directory.",
      );
    }
    throw new Error(
      `Snapshots are read-only. Delete the snapshot '${target.name}' instead of files inside it (${inputPath}).`,
    );
  };
  fs.rm = async (path: string | string[], options?) => {
    const paths = typeof path === "string" ? [path] : path;
    const nonSnapshotPaths: string[] = [];
    const snapshotNames = new Set<string>();
    const deleteSnapshotHandler = deleteSnapshot;
    for (const inputPath of paths) {
      const target = classifySnapshotTarget(inputPath);
      if (target == null) {
        nonSnapshotPaths.push(inputPath);
        continue;
      }
      if (deleteSnapshotHandler == null) {
        nonSnapshotPaths.push(inputPath);
        continue;
      }
      snapshotNames.add(assertSupportedSnapshotDeleteTarget(inputPath, target));
    }
    if (snapshotNames.size > 0) {
      if (deleteSnapshotHandler == null) {
        throw new Error("snapshot deletion is not configured");
      }
      for (const name of snapshotNames) {
        await deleteSnapshotHandler(name);
      }
    }
    if (typeof path === "string") {
      if (snapshotNames.size > 0) {
        return;
      }
      return await baseRm(path, options);
    }
    if (nonSnapshotPaths.length > 0) {
      await baseRm(nonSnapshotPaths, options);
    }
  };
  fs.rmdir = async (inputPath: string, options?) => {
    const target = classifySnapshotTarget(inputPath);
    if (target != null && deleteSnapshot != null) {
      await deleteSnapshot(
        assertSupportedSnapshotDeleteTarget(inputPath, target),
      );
      return;
    }
    await baseRmdir(inputPath, options);
  };
  return fs;
}
