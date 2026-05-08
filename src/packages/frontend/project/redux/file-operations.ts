/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { join } from "path";

import { alert_message } from "@cocalc/frontend/alerts";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { CopyOptions, FilesystemClient } from "@cocalc/conat/files/fs";
import { migrateStarsOnMove } from "@cocalc/frontend/project/page/flyouts/store";
import { normalizeCpSourcePath } from "@cocalc/frontend/project/copy-paths";
import { notifyProjectFilesystemChange } from "@cocalc/frontend/project/user-filesystem-change";
import { getProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  moveDestinationPath,
  normalizeDirectoryDestination,
} from "@cocalc/frontend/project/action-paths";
import { getSnapshotPathTarget } from "@cocalc/util/consts/snapshots";
import * as misc from "@cocalc/util/misc";

type SetActivity = (opts: any) => Promise<void> | void;
type LogProjectEvent = (event: any) => string | undefined;

type FileOperationContext = {
  projectId: string;
  fs: () => FilesystemClient;
  setActivity: SetActivity;
  log: LogProjectEvent;
};

export async function copyPaths({
  src,
  dest,
  id,
  only_contents,
  fs,
  setActivity,
  log,
  appendSlashToDirectoryPaths,
}: {
  src: string[];
  dest: string;
  id?: string;
  only_contents?: boolean;
  fs: () => FilesystemClient;
  setActivity: SetActivity;
  log: LogProjectEvent;
  appendSlashToDirectoryPaths: (paths: string[]) => Promise<string[]>;
}): Promise<void> {
  const withSlashes = await appendSlashToDirectoryPaths(src);

  log({
    event: "file_action",
    action: "copied",
    files: withSlashes,
    count: src.length,
    dest: only_contents ? dest : normalizeDirectoryDestination(dest),
  });

  if (only_contents) {
    src = withSlashes;
  }

  src = src.map(normalizeCpSourcePath);

  id ??= misc.uuid();
  setActivity({
    id,
    status: `Copying ${src.length} ${misc.plural(
      src.length,
      "file",
    )} to ${dest}`,
  });

  try {
    await fs().cp(src, dest, { recursive: true, reflink: true });
    setActivity({ id, stop: "" });
  } catch (err) {
    setActivity({ id, error: `${err}` });
    setActivity({ id, stop: "" });
  }
}

export async function copyPathBetweenProjects({
  opts,
  projectId,
  copyOpsTrack,
  appendSlashToDirectoryPaths,
  setActivity,
  log,
}: {
  opts: {
    src: { project_id: string; path: string | string[] };
    src_home?: string;
    dest: { project_id: string; path: string };
    options?: CopyOptions;
  };
  projectId: string;
  copyOpsTrack: (op: any) => void;
  appendSlashToDirectoryPaths: (paths: string[]) => Promise<string[]>;
  setActivity: SetActivity;
  log: LogProjectEvent;
}): Promise<void> {
  const id = misc.uuid();
  const files =
    typeof opts.src.path == "string" ? [opts.src.path] : opts.src.path;
  setActivity({
    id,
    status: `Copying ${files.length} ${misc.plural(
      files.length,
      "path",
    )} to a project`,
  });
  let error: any = undefined;
  try {
    const src_home =
      opts.src_home ??
      (opts.src.project_id === projectId
        ? getProjectHomeDirectory(projectId)
        : undefined);
    const resp = await webapp_client.project_client.copyPathBetweenProjects({
      ...opts,
      ...(src_home ? { src_home } : {}),
    });
    copyOpsTrack(resp);
    setActivity({
      id,
      status: `Copy queued (${resp.op_id.slice(0, 8)})`,
    });
    const summary = await webapp_client.conat_client.lroWait({
      op_id: resp.op_id,
      scope_type: resp.scope_type,
      scope_id: resp.scope_id,
      onProgress: (event) => {
        const phase =
          typeof event.phase == "string" && event.phase.length > 0
            ? event.phase
            : typeof event.message == "string" && event.message.length > 0
              ? event.message
              : "running";
        const pct =
          typeof event.progress == "number" && Number.isFinite(event.progress)
            ? ` (${Math.max(0, Math.min(100, Math.round(event.progress)))}%)`
            : "";
        setActivity({
          id,
          status: `Copy ${phase}${pct}`,
        });
      },
    });
    if (summary.status === "succeeded") {
      notifyProjectFilesystemChange(opts.src.project_id);
      notifyProjectFilesystemChange(opts.dest.project_id);
      const withSlashes = await appendSlashToDirectoryPaths(files);
      log({
        event: "file_action",
        action: "copied",
        dest: opts.dest.path,
        files: withSlashes,
        count: files.length,
        project: opts.dest.project_id,
      });
    } else if (summary.status === "canceled") {
      error = summary.error ?? "Copy canceled";
      alert_message({
        type: "warning",
        title: "Copy canceled",
        message: error,
      });
    } else {
      error = summary.error ?? `Copy failed (${summary.status})`;
      alert_message({
        type: "error",
        title: "Copy failed",
        message: error,
      });
    }
  } catch (err) {
    error = `${err}`;
    alert_message({
      type: "error",
      title: "Copy failed",
      message: error,
    });
  } finally {
    setActivity({ id, stop: "", error });
  }
}

export async function renameFile({
  src,
  dest,
  fs,
  isDir,
  setActivity,
  log,
}: {
  src: string;
  dest: string;
  fs: () => FilesystemClient;
  isDir: (path: string) => Promise<boolean>;
  setActivity: SetActivity;
  log: LogProjectEvent;
}): Promise<void> {
  let error: any = undefined;
  const id = misc.uuid();
  const status = `Renaming ${src} to ${dest}`;
  setActivity({ id, status });
  try {
    await fs().rename(src, dest);
    log({
      event: "file_action",
      action: "renamed",
      src,
      dest: dest + ((await isDir(dest)) ? "/" : ""),
    });
  } catch (err) {
    error = err;
  } finally {
    setActivity({ id, stop: "", error });
  }
}

export async function moveFiles({
  src,
  dest,
  projectId,
  fs,
  setActivity,
  log,
}: {
  src: string[];
  dest: string;
} & FileOperationContext): Promise<void> {
  const id = misc.uuid();
  const status = `Moving ${src.length} ${misc.plural(
    src.length,
    "file",
  )} to ${dest}`;
  setActivity({ id, status });
  let error: any = undefined;
  try {
    const filesystem = fs();
    await Promise.all(
      src.map(async (path) =>
        filesystem.move(path, moveDestinationPath(dest, path), {
          overwrite: true,
        }),
      ),
    );
    await migrateStarsOnMove(projectId, src, dest);
    log({
      event: "file_action",
      action: "moved",
      files: src,
      dest: normalizeDirectoryDestination(dest),
    });
  } catch (err) {
    error = err;
  } finally {
    setActivity({ id, stop: "", error });
  }
}

export async function deleteFiles({
  paths,
  sudo = false,
  projectId,
  fs,
  setActivity,
  log,
}: {
  paths: string[];
  sudo?: boolean;
} & FileOperationContext): Promise<void> {
  if (paths.length == 0) {
    return;
  }
  const id = misc.uuid();
  const mesg = paths.length === 1 ? `${paths[0]}` : `${paths.length} files`;
  setActivity({ id, status: `Deleting ${mesg}...` });

  try {
    const snapshots: string[] = [];
    const nonSnapshotPaths: string[] = [];
    for (const path of paths) {
      const target = getSnapshotPathTarget(path);
      if (target?.kind === "snapshot") {
        snapshots.push(target.name);
        continue;
      }
      if (target?.kind === "snapshots-root") {
        throw new Error(
          "Delete snapshots individually, not the .snapshots directory.",
        );
      }
      if (target?.kind === "snapshot-entry") {
        throw new Error(
          `Snapshots are read-only. Delete the snapshot '${target.name}' instead of files inside it.`,
        );
      }
      nonSnapshotPaths.push(path);
    }
    if (snapshots.length > 0) {
      for (const name of snapshots) {
        await webapp_client.conat_client.hub.projects.deleteSnapshot({
          project_id: projectId,
          name,
        });
      }
    }
    if (nonSnapshotPaths.length > 0) {
      await fs().rm(nonSnapshotPaths, { force: true, recursive: true, sudo });
    }

    log({
      event: "file_action",
      action: "deleted",
      files: paths,
    });
    setActivity({
      id,
      status: `Successfully deleted ${mesg}.`,
      stop: "",
    });
  } catch (err) {
    setActivity({
      id,
      error: `Error deleting ${mesg} -- ${err}`,
      stop: "",
    });
  }
}

export async function deleteMatchingFiles({
  path,
  filter,
  recursive,
  fs,
  deleteFiles,
}: {
  path: string;
  filter: (path: string) => boolean;
  recursive?: boolean;
  fs: () => FilesystemClient;
  deleteFiles: (opts: { paths: string[] }) => Promise<void>;
}): Promise<string[]> {
  const options: string[] = ["-H", "-I"];
  if (!recursive) {
    options.push("-d", "1");
  }
  const { stdout } = await fs().fd(path, { options });
  const paths = Buffer.from(stdout)
    .toString()
    .split("\n")
    .slice(0, -1)
    .map((p) => join(path, p))
    .filter(filter);
  if (paths.length > 0) {
    await deleteFiles({ paths });
  }
  return paths;
}
