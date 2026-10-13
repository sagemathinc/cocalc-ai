import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { acquireProjectWriteLease } from "./project-write-fence";
import {
  getSnapshotPathTarget,
  type SnapshotPathTarget,
} from "@cocalc/util/consts/snapshots";
import { DEFAULT_PROJECT_RUNTIME_HOME } from "@cocalc/util/project-runtime";
import { posix } from "node:path";

export function createProjectSandboxFilesystem({
  project_id,
  home,
  rootfs,
  scratch,
  sharedScratch,
  deleteSnapshot,
}: {
  project_id: string;
  home: string;
  rootfs: string;
  scratch: string;
  sharedScratch?: string;
  deleteSnapshot?: (name: string) => Promise<void>;
}): SandboxedFilesystem {
  const fs = new SandboxedFilesystem(home, {
    host: project_id,
    rootfs,
    scratch,
    sharedScratch,
    // Keep the runtime HOME writable even when rootfs is stopped. Do not alias
    // /home itself; it must remain a rootfs path so directory listings do not
    // make project-home files appear to live directly in /home.
    homeAliases: [DEFAULT_PROJECT_RUNTIME_HOME],
  });
  const baseMkdir = fs.mkdir.bind(fs);
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
  fs.mkdir = async (path: string, options?) => {
    // Recursive copies into stopped projects create parents for /home/user/...
    // before writing into runtime HOME. Let that parent step succeed without
    // making /home itself an alias for project HOME listings and reads.
    if (
      posix.resolve("/", path) === "/home" &&
      options != null &&
      typeof options === "object" &&
      options.recursive
    ) {
      return;
    }
    await baseMkdir(path, options);
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
  holdWriteLeases(fs, project_id);
  return fs;
}

// Every method that can change files in the project. Each call holds a write
// lease (see project-write-fence) until it settles, and a write stream until
// it closes.
const WRITE_METHODS = [
  "appendFile",
  "chmod",
  "copyFile",
  "cp",
  "link",
  "mkdir",
  "move",
  "ouch",
  "rename",
  "rm",
  "rmdir",
  "symlink",
  "truncate",
  "unlink",
  "utimes",
  "writeFile",
  "writeFileDelta",
] as const;

function holdWriteLeases(fs: SandboxedFilesystem, project_id: string): void {
  for (const method of WRITE_METHODS) {
    const original = (fs as any)[method];
    if (typeof original !== "function") continue;
    const bound = original.bind(fs);
    (fs as any)[method] = async (...args: any[]) => {
      const release = await acquireProjectWriteLease(project_id);
      try {
        return await bound(...args);
      } finally {
        release();
      }
    };
  }
  const createWriteStream = fs.createWriteStream.bind(fs);
  fs.createWriteStream = async (path: string) => {
    const release = await acquireProjectWriteLease(project_id);
    try {
      const stream = await createWriteStream(path);
      stream.once("close", release);
      stream.once("error", release);
      return stream;
    } catch (err) {
      release();
      throw err;
    }
  };
}
