/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

import getLogger from "@cocalc/backend/logger";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import type { HostRootfsManifest } from "@cocalc/conat/project-host/api";
import { sudo } from "@cocalc/file-server/btrfs/util";
import {
  imageCachePath,
  inspectFilePath,
} from "@cocalc/project-runner/run/rootfs-base";
import {
  getRootfsMountpoint,
  isMounted,
} from "@cocalc/project-runner/run/rootfs";

const logger = getLogger("project-host:rootfs-manifest");
const ROOTFS_MANIFEST_TIMEOUT_S = 30 * 60;

type FileType =
  | "file"
  | "directory"
  | "symlink"
  | "block"
  | "char"
  | "fifo"
  | "socket"
  | "other";

type ManifestRecord = {
  type: FileType;
  path: string;
  mode: string;
  uid: string;
  gid: string;
  size: string;
  sha256?: string;
  target?: string;
  rdev?: string;
  hardlink_key?: string;
};

type BuildManifestOptions = {
  source_kind: HostRootfsManifest["source_kind"];
  root_path: string;
  image?: string;
  inspect_path?: string;
  project_id?: string;
};

function detectType(info: any): FileType {
  if (info.isFile()) return "file";
  if (info.isDirectory()) return "directory";
  if (info.isSymbolicLink()) return "symlink";
  if (info.isBlockDevice()) return "block";
  if (info.isCharacterDevice()) return "char";
  if (info.isFIFO()) return "fifo";
  if (info.isSocket()) return "socket";
  return "other";
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash as any);
  return hash.digest("hex");
}

function manifestLine({
  record,
  hardlink_group,
  hardlink_group_size,
}: {
  record: ManifestRecord;
  hardlink_group?: string;
  hardlink_group_size?: number;
}): string {
  return JSON.stringify([
    record.type,
    record.path,
    record.mode,
    record.uid,
    record.gid,
    record.size,
    record.sha256 ?? "",
    record.target ?? "",
    hardlink_group ?? "",
    hardlink_group_size ?? 1,
    record.rdev ?? "",
  ]);
}

async function walkTree({
  path,
  relative_path,
  records,
  hardlink_paths,
  counts,
}: {
  path: string;
  relative_path: string;
  records: ManifestRecord[];
  hardlink_paths: Map<string, string[]>;
  counts: {
    entry_count: number;
    regular_file_count: number;
    directory_count: number;
    symlink_count: number;
    other_count: number;
    total_regular_bytes: number;
  };
}): Promise<void> {
  const info = await lstat(path, { bigint: true });
  const type = detectType(info as any);
  const is_root_entry = relative_path === ".";
  const record: ManifestRecord = {
    type,
    path: relative_path,
    // The mounted/cache root directory itself is transport scaffolding, not
    // semantic RootFS content, so normalize its ownership/mode fields.
    mode: is_root_entry
      ? "0000"
      : `${Number(info.mode & BigInt(0o7777))
          .toString(8)
          .padStart(4, "0")}`,
    uid: is_root_entry ? "0" : `${info.uid}`,
    gid: is_root_entry ? "0" : `${info.gid}`,
    // Directory and special-file st_size values are not semantic content and
    // differ between overlay views and restored standalone trees.
    size: "0",
  };
  counts.entry_count += 1;
  switch (type) {
    case "file":
      counts.regular_file_count += 1;
      counts.total_regular_bytes += Number(info.size);
      record.size = `${info.size}`;
      record.sha256 = await sha256File(path);
      if (info.nlink > BigInt(1)) {
        const key = `${info.dev}:${info.ino}`;
        record.hardlink_key = key;
        const current = hardlink_paths.get(key);
        if (current) {
          current.push(relative_path);
        } else {
          hardlink_paths.set(key, [relative_path]);
        }
      }
      break;
    case "directory":
      counts.directory_count += 1;
      break;
    case "symlink":
      counts.symlink_count += 1;
      record.target = await readlink(path);
      break;
    case "block":
    case "char":
    case "fifo":
    case "socket":
    case "other":
      counts.other_count += 1;
      record.rdev = `${info.rdev}`;
      break;
  }
  records.push(record);
  if (type !== "directory") return;
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child_path = join(path, entry.name);
    const child_relative =
      relative_path === "." ? entry.name : `${relative_path}/${entry.name}`;
    await walkTree({
      path: child_path,
      relative_path: child_relative,
      records,
      hardlink_paths,
      counts,
    });
  }
}

async function buildManifest({
  source_kind,
  root_path,
  image,
  inspect_path,
  project_id,
}: BuildManifestOptions): Promise<HostRootfsManifest> {
  const baseFields = {
    format: "rootfs-manifest-v1" as const,
    source_kind,
    image,
    inspect_path,
    project_id,
    root_path,
  };
  if (process.env.NODE_ENV !== "test") {
    try {
      const { stdout } = await sudo({
        verbose: false,
        timeout: ROOTFS_MANIFEST_TIMEOUT_S,
        command: "rootfs-manifest",
        args: [root_path],
      });
      const manifest = JSON.parse(`${stdout ?? ""}`.trim());
      return {
        ...baseFields,
        generated_at: manifest.generated_at,
        manifest_sha256: manifest.manifest_sha256,
        hardlink_sha256: manifest.hardlink_sha256,
        entry_count: manifest.entry_count,
        regular_file_count: manifest.regular_file_count,
        directory_count: manifest.directory_count,
        symlink_count: manifest.symlink_count,
        other_count: manifest.other_count,
        hardlink_group_count: manifest.hardlink_group_count,
        hardlink_member_count: manifest.hardlink_member_count,
        total_regular_bytes: manifest.total_regular_bytes,
      };
    } catch (err) {
      logger.warn("privileged rootfs manifest failed; falling back locally", {
        root_path,
        source_kind,
        err: `${err}`,
      });
    }
  }
  const records: ManifestRecord[] = [];
  const hardlink_paths = new Map<string, string[]>();
  const counts = {
    entry_count: 0,
    regular_file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    other_count: 0,
    total_regular_bytes: 0,
  };
  await walkTree({
    path: root_path,
    relative_path: ".",
    records,
    hardlink_paths,
    counts,
  });
  const hardlink_groups = new Map<
    string,
    {
      group_id: string;
      visible_count: number;
    }
  >();
  let hardlink_group_count = 0;
  let hardlink_member_count = 0;
  for (const [key, paths] of hardlink_paths) {
    if (paths.length <= 1) continue;
    paths.sort((a, b) => a.localeCompare(b));
    hardlink_groups.set(key, {
      group_id: paths[0],
      visible_count: paths.length,
    });
    hardlink_group_count += 1;
    hardlink_member_count += paths.length;
  }
  const lines = records.map((record) =>
    manifestLine({
      record,
      hardlink_group: record.hardlink_key
        ? hardlink_groups.get(record.hardlink_key)?.group_id
        : undefined,
      hardlink_group_size: record.hardlink_key
        ? hardlink_groups.get(record.hardlink_key)?.visible_count
        : undefined,
    }),
  );
  const manifest_text = `${lines.join("\n")}\n`;
  const hardlink_text =
    Array.from(hardlink_groups.values())
      .map(({ group_id, visible_count }) =>
        JSON.stringify([group_id, visible_count]),
      )
      .join("\n") + (hardlink_groups.size > 0 ? "\n" : "");
  return {
    ...baseFields,
    generated_at: new Date().toISOString(),
    manifest_sha256: createHash("sha256").update(manifest_text).digest("hex"),
    hardlink_sha256: createHash("sha256").update(hardlink_text).digest("hex"),
    entry_count: counts.entry_count,
    regular_file_count: counts.regular_file_count,
    directory_count: counts.directory_count,
    symlink_count: counts.symlink_count,
    other_count: counts.other_count,
    hardlink_group_count,
    hardlink_member_count,
    total_regular_bytes: counts.total_regular_bytes,
  };
}

export async function buildCachedRootfsManifest(
  image: string,
): Promise<HostRootfsManifest> {
  const root_path = imageCachePath(image);
  if (!(await exists(root_path))) {
    throw new Error(`managed RootFS cache entry not found for '${image}'`);
  }
  const inspect_path = inspectFilePath(image);
  return await buildManifest({
    source_kind: "cached-image",
    image,
    inspect_path: (await exists(inspect_path)) ? inspect_path : undefined,
    root_path,
  });
}

export async function buildProjectRootfsManifest(
  project_id: string,
): Promise<HostRootfsManifest> {
  const root_path = getRootfsMountpoint(project_id);
  if (!(await exists(root_path)) || !(await isMounted({ project_id }))) {
    throw new Error(
      `project '${project_id}' RootFS mount is not available on this host`,
    );
  }
  return await buildManifest({
    source_kind: "project-rootfs",
    project_id,
    root_path,
  });
}
