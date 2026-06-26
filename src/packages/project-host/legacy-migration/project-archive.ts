/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import * as zlib from "node:zlib";

import { data } from "@cocalc/backend/data";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { envToInt } from "@cocalc/backend/misc/env-to-number";
import type {
  LroRef,
  ProjectArchiveEntry,
  ProjectArchiveIndexResult,
  ProjectArchiveRestoreResult,
  SignedProjectArchiveDownload,
} from "@cocalc/conat/files/file-server";
import { publishLroEvent } from "../lro/stream";

import { normalizeArchivePath } from "../archive-path";

const PROJECT_ARCHIVE_RESTORE_TIMEOUT_MS = Math.max(
  60 * 60 * 1000,
  envToInt("COCALC_PROJECT_ARCHIVE_RESTORE_TIMEOUT_MS", 6 * 60 * 60 * 1000),
);
const PROJECT_ARCHIVE_PROGRESS_INTERVAL_MS = 1000;
const LEGACY_PROJECT_ARCHIVE_UID = 2001;
const LEGACY_PROJECT_ARCHIVE_GID = 2001;
const LEGACY_PROJECT_ARCHIVE_MANAGED_EXCLUDE_ROOTS = [
  ".local/share/cocalc",
  ".snapshots",
  ".smc",
  ".ssh/.cocalc",
  ".ssh/authorized_keys",
];

type LegacyProjectArchiveDeps = {
  getOrEnsureVolume: (project_id: string) => Promise<unknown>;
  getProjectQuota?: (project_id: string) => Promise<{
    size: number;
    used: number;
    warning?: string;
  }>;
  setProjectQuota?: (
    project_id: string,
    size: number | string,
  ) => Promise<void>;
  setProjectQuotaGraceActive?: (project_id: string, active: boolean) => void;
  projectMountpoint: (project_id: string) => string;
  invalidateProjectFsServer: (project_id: string) => void;
  touchProjectLastEdited: (project_id: string, reason: string) => void;
  logger: {
    warn: (message: string, metadata?: Record<string, unknown>) => void;
  };
};

function archiveRestoreTmpRoot(): string {
  return join(data, "tmp", "legacy-project-restore");
}

function publishArchiveProgress({
  lro,
  phase,
  message,
  progress,
  detail,
}: {
  lro?: LroRef;
  phase: string;
  message: string;
  progress: number;
  detail?: any;
}): void {
  if (!lro) return;
  void publishLroEvent({
    scope_type: lro.scope_type,
    scope_id: lro.scope_id,
    op_id: lro.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase,
      message,
      progress,
      detail,
    },
  }).catch(() => {});
}

function truncateProgressPath(path: string): string {
  const value = path.trim();
  if (value.length <= 240) return value;
  return `...${value.slice(value.length - 237)}`;
}

function assertSafeArchivePath(raw: string): void {
  const value = raw.trim();
  if (!value || value === ".") return;
  if (value.includes("\0")) {
    throw new Error("archive contains a path with a NUL byte");
  }
  const slashPath = value.replace(/\\/g, "/");
  if (slashPath.split("/").includes("..")) {
    throw new Error(`archive contains a parent-directory path: ${value}`);
  }
  const normalized = path.posix.normalize(slashPath);
  if (path.posix.isAbsolute(value) || path.posix.isAbsolute(normalized)) {
    throw new Error(`archive contains an absolute path: ${value}`);
  }
  const parts = normalized.split("/");
  if (parts.includes("..")) {
    throw new Error(`archive contains a parent-directory path: ${value}`);
  }
}

function normalizeProjectArchiveMemberPath(raw: string): string {
  return normalizeArchivePath(raw).replace(/\/+$/, "");
}

function normalizeProjectArchivePathRoots(
  paths?: string[],
): string[] | undefined {
  const normalized = Array.from(
    new Set(
      (paths ?? [])
        .map((entry) => normalizeProjectArchiveMemberPath(entry))
        .filter(Boolean),
    ),
  );
  return normalized.length > 0 ? normalized : undefined;
}

function mergeProjectArchivePathRoots(
  ...pathLists: (string[] | undefined)[]
): string[] | undefined {
  return normalizeProjectArchivePathRoots(
    pathLists.flatMap((paths) => paths ?? []),
  );
}

function archivePathMatchesRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function shouldRestoreArchivePath({
  archivePath,
  include,
  exclude,
}: {
  archivePath: string;
  include?: string[];
  exclude?: string[];
}): boolean {
  const normalized = normalizeProjectArchiveMemberPath(archivePath);
  if (!normalized) return include == null && exclude == null;
  if (exclude?.some((root) => archivePathMatchesRoot(normalized, root))) {
    return false;
  }
  if (include == null) return true;
  return include.some((root) => archivePathMatchesRoot(normalized, root));
}

function projectArchiveCacheRoot(project_id: string): string {
  return join(data, "cache", "legacy-project-archives", project_id);
}

function projectArchiveCacheId(download: SignedProjectArchiveDownload): string {
  return createHash("sha256")
    .update(`${download.bucket ?? ""}\0${download.key ?? ""}\0`)
    .update(`${download.sha256 ?? ""}\0${download.bytes ?? ""}`)
    .digest("hex")
    .slice(0, 32);
}

function assertSafeArchiveCacheId(cache_id: string): void {
  if (!/^[0-9a-f]{32,64}$/i.test(cache_id)) {
    throw new Error("invalid project archive cache id");
  }
}

function projectArchiveCachePaths({
  project_id,
  cache_id,
}: {
  project_id: string;
  cache_id: string;
}): { dir: string; archive: string; index: string } {
  assertSafeArchiveCacheId(cache_id);
  const dir = join(projectArchiveCacheRoot(project_id), cache_id);
  return {
    dir,
    archive: join(dir, "project.tar.zst"),
    index: join(dir, "index.json"),
  };
}

function runProjectArchiveTarCommand({
  archivePath,
  args,
  onStdoutLine,
}: {
  archivePath: string;
  args: string[];
  onStdoutLine?: (line: string) => void;
}): Promise<{ stderr: string }> {
  const createZstdDecompress = (zlib as any).createZstdDecompress;
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdin = child.stdin;
    if (stdin == null) {
      reject(new Error("tar stdin pipe was not created"));
      return;
    }
    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let inputError: Error | undefined;
    let inputStreamClosedEarly = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new Error("tar command timed out"));
    }, PROJECT_ARCHIVE_RESTORE_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk) => {
      if (onStdoutLine == null) return;
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/g);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          onStdoutLine(line);
        } catch (err) {
          inputError = err instanceof Error ? err : new Error(`${err}`);
          child.kill("SIGTERM");
          return;
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20_000) {
        stderr = stderr.slice(stderr.length - 20_000);
      }
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (stdoutBuffer && onStdoutLine != null && inputError == null) {
        try {
          onStdoutLine(stdoutBuffer);
        } catch (err) {
          inputError = err instanceof Error ? err : new Error(`${err}`);
        }
      }
      if (code !== 0) {
        reject(
          new Error(
            `tar failed with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr.trim() || inputError?.message || "unknown error"}`,
          ),
        );
        return;
      }
      if (inputError) {
        reject(inputError);
        return;
      }
      if (inputStreamClosedEarly && code !== 0) {
        reject(new Error("archive input stream closed before tar completed"));
        return;
      }
      resolve({ stderr });
    });

    const failInput = (err: unknown) => {
      if (settled) return;
      const error = err instanceof Error ? err : new Error(`${err}`);
      if (
        (error as any).code === "ERR_STREAM_PREMATURE_CLOSE" ||
        error.message === "Premature close"
      ) {
        inputStreamClosedEarly = true;
        return;
      }
      inputError ??= error;
      child.kill("SIGTERM");
    };
    if (typeof createZstdDecompress !== "function") {
      failInput(
        new Error(
          "Node runtime does not provide zstd decompression for project archive restore",
        ),
      );
      return;
    }
    const decompressor = createZstdDecompress();
    pipeline(createReadStream(archivePath), decompressor, stdin).catch(
      failInput,
    );
  });
}

function runProjectArchiveCommand({
  command,
  args,
}: {
  command: string;
  args: string[];
}): Promise<{ stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20_000) {
        stderr = stderr.slice(stderr.length - 20_000);
      }
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({ stderr });
        return;
      }
      reject(
        new Error(
          `${command} failed with code ${code ?? "null"} signal ${signal ?? "null"}: ${stderr.trim() || "unknown error"}`,
        ),
      );
    });
  });
}

async function mapLegacyArchiveOwnership({
  dest,
  progress,
  lro,
}: {
  dest: string;
  progress: number;
  lro?: LroRef;
}): Promise<void> {
  const destStat = await stat(dest);
  if (
    destStat.uid === LEGACY_PROJECT_ARCHIVE_UID &&
    destStat.gid === LEGACY_PROJECT_ARCHIVE_GID
  ) {
    return;
  }
  publishArchiveProgress({
    lro,
    phase: "permissions",
    message: "mapping legacy archive ownership",
    progress,
    detail: {
      legacy_uid: LEGACY_PROJECT_ARCHIVE_UID,
      legacy_gid: LEGACY_PROJECT_ARCHIVE_GID,
      project_uid: destStat.uid,
      project_gid: destStat.gid,
    },
  });
  await runProjectArchiveCommand({
    command: "chown",
    args: [
      "-hR",
      `--from=${LEGACY_PROJECT_ARCHIVE_UID}:${LEGACY_PROJECT_ARCHIVE_GID}`,
      `${destStat.uid}:${destStat.gid}`,
      dest,
    ],
  });
}

function parseTarVerboseLine(line: string):
  | {
      path: string;
      size: number;
      type: ProjectArchiveEntry["type"];
      mtime?: string;
    }
  | undefined {
  const match = line.match(
    /^(\S+)\s+\S+\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s+(.+)$/,
  );
  if (!match) return;
  const size = Number(match[2]);
  if (!Number.isFinite(size) || size < 0) return;
  const mode = match[1];
  const name = match[5]
    .replace(/\s+->\s+.*$/, "")
    .replace(/\s+link to\s+.*$/, "");
  const kind = mode[0];
  const type =
    kind === "d"
      ? "directory"
      : kind === "l"
        ? "symlink"
        : kind === "-"
          ? "file"
          : "other";
  return { path: name, size, type, mtime: `${match[3]}T${match[4]}Z` };
}

async function scanProjectArchiveTar({
  archivePath,
  include,
  exclude,
  member_list_path,
  collect_entries,
  max_entries,
  max_uncompressed_bytes,
  lro,
}: {
  archivePath: string;
  include?: string[];
  exclude?: string[];
  member_list_path?: string;
  collect_entries?: boolean;
  max_entries?: number;
  max_uncompressed_bytes?: number;
  lro?: LroRef;
}): Promise<{
  file_count: number;
  uncompressed_bytes: number;
  entries: ProjectArchiveEntry[];
  truncated: boolean;
}> {
  let file_count = 0;
  let uncompressed_bytes = 0;
  const entries: ProjectArchiveEntry[] = [];
  let truncated = false;
  const entryLimit =
    typeof max_entries === "number" && Number.isFinite(max_entries)
      ? Math.max(0, Math.floor(max_entries))
      : 0;
  const memberList =
    member_list_path != null ? createWriteStream(member_list_path) : undefined;
  let lastProgress = 0;
  const closeMemberList = async () => {
    if (memberList == null) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      memberList.once("error", onError);
      memberList.end(() => {
        memberList.off("error", onError);
        resolve();
      });
    });
  };
  try {
    await runProjectArchiveTarCommand({
      archivePath,
      args: ["-tvf", "-"],
      onStdoutLine: (line) => {
        const parsed = parseTarVerboseLine(line);
        if (parsed == null) {
          if (line.trim()) {
            throw new Error(`unable to parse tar listing line: ${line}`);
          }
          return;
        }
        assertSafeArchivePath(parsed.path);
        if (
          !shouldRestoreArchivePath({
            archivePath: parsed.path,
            include,
            exclude,
          })
        ) {
          return;
        }
        if (parsed.path.trim()) {
          file_count += 1;
          memberList?.write(`${parsed.path}\n`);
          if (collect_entries) {
            if (entryLimit === 0 || entries.length < entryLimit) {
              const normalized = normalizeProjectArchiveMemberPath(parsed.path);
              if (normalized) {
                entries.push({
                  path: normalized,
                  size: parsed.size,
                  type: parsed.type,
                  mtime: parsed.mtime,
                });
              }
            } else {
              truncated = true;
            }
          }
        }
        uncompressed_bytes += parsed.size;
        const now = Date.now();
        if (now - lastProgress >= PROJECT_ARCHIVE_PROGRESS_INTERVAL_MS) {
          lastProgress = now;
          publishArchiveProgress({
            lro,
            phase: "scan",
            message: "checking archive contents",
            progress: 55,
            detail: {
              file_count,
              uncompressed_bytes,
            },
          });
        }
        if (
          max_uncompressed_bytes != null &&
          uncompressed_bytes > max_uncompressed_bytes
        ) {
          throw new Error(
            `legacy project archive is too large for current storage quota (${uncompressed_bytes} > ${max_uncompressed_bytes} bytes)`,
          );
        }
      },
    });
  } finally {
    await closeMemberList();
  }
  return { file_count, uncompressed_bytes, entries, truncated };
}

async function extractProjectArchiveTar({
  archivePath,
  dest,
  member_list_path,
  expected_file_count,
  expected_uncompressed_bytes,
  lro,
}: {
  archivePath: string;
  dest: string;
  member_list_path?: string;
  expected_file_count?: number;
  expected_uncompressed_bytes?: number;
  lro?: LroRef;
}): Promise<void> {
  publishArchiveProgress({
    lro,
    phase: "extract",
    message: "extracting archive files",
    progress: 70,
  });
  const args = [
    "--delay-directory-restore",
    "--no-overwrite-dir",
    "-xvf",
    "-",
    "-C",
    dest,
  ];
  if (member_list_path != null) {
    args.push(
      "--verbatim-files-from",
      "--no-recursion",
      "-T",
      member_list_path,
    );
  }
  let extracted_count = 0;
  let lastProgress = 0;
  await runProjectArchiveTarCommand({
    archivePath,
    args,
    onStdoutLine: (line) => {
      const path = normalizeProjectArchiveMemberPath(line);
      if (!path) return;
      assertSafeArchivePath(path);
      extracted_count += 1;
      const now = Date.now();
      if (now - lastProgress < PROJECT_ARCHIVE_PROGRESS_INTERVAL_MS) return;
      lastProgress = now;
      const progress =
        expected_file_count != null && expected_file_count > 0
          ? Math.min(88, 70 + (extracted_count / expected_file_count) * 18)
          : 75;
      publishArchiveProgress({
        lro,
        phase: "extract",
        message: "extracting archive files",
        progress,
        detail: {
          current_path: truncateProgressPath(path),
          extracted_count,
          file_count: expected_file_count,
          uncompressed_bytes: expected_uncompressed_bytes,
        },
      });
    },
  });
}

async function downloadSignedProjectArchive({
  download,
  dest,
  lro,
}: {
  download: SignedProjectArchiveDownload;
  dest: string;
  lro?: LroRef;
}): Promise<{ bytes: number; sha256: string }> {
  const response = await fetch(download.url, {
    headers: download.headers ?? {},
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `project archive download failed (${response.status}): ${response.statusText || "unknown error"}`,
    );
  }
  const hash = createHash("sha256");
  const expectedBytes =
    typeof download.bytes === "number" && Number.isFinite(download.bytes)
      ? download.bytes
      : undefined;
  let bytes = 0;
  let lastProgress = 0;
  const monitor = new Transform({
    transform(chunk: Buffer, _encoding, cb) {
      bytes += chunk.length;
      hash.update(chunk);
      const now = Date.now();
      if (now - lastProgress >= PROJECT_ARCHIVE_PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        publishArchiveProgress({
          lro,
          phase: "download",
          message: "downloading archive",
          progress:
            expectedBytes != null && expectedBytes > 0
              ? Math.min(45, 20 + (bytes / expectedBytes) * 25)
              : 30,
          detail: {
            bytes,
            expected_bytes: expectedBytes,
          },
        });
      }
      cb(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body as NodeReadableStream),
    monitor,
    createWriteStream(dest),
  );
  const sha256 = hash.digest("hex");
  const expectedSha256 = `${download.sha256 ?? ""}`.trim().toLowerCase();
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(
      `project archive sha256 mismatch: expected ${expectedSha256}, got ${sha256}`,
    );
  }
  return { bytes, sha256 };
}

async function readCachedProjectArchiveIndex({
  indexPath,
}: {
  indexPath: string;
}): Promise<ProjectArchiveIndexResult | undefined> {
  if (!(await exists(indexPath))) return;
  const raw = JSON.parse(await readFile(indexPath, "utf8"));
  if (!raw || typeof raw !== "object" || !raw.cache_id) return;
  return raw as ProjectArchiveIndexResult;
}

async function hashProjectArchiveFile(
  archivePath: string,
): Promise<{ bytes: number; sha256: string }> {
  const archiveStat = await stat(archivePath);
  const sha256 = await new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(archivePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
  return { bytes: archiveStat.size, sha256 };
}

export function createLegacyProjectArchiveHandlers({
  getOrEnsureVolume,
  getProjectQuota,
  setProjectQuota,
  setProjectQuotaGraceActive,
  projectMountpoint,
  invalidateProjectFsServer,
  touchProjectLastEdited,
  logger,
}: LegacyProjectArchiveDeps): {
  cacheProjectArchive: (opts: {
    project_id: string;
    download: SignedProjectArchiveDownload;
    max_entries?: number;
    lro?: LroRef;
  }) => Promise<ProjectArchiveIndexResult>;
  restoreProjectArchive: (opts: {
    project_id: string;
    download?: SignedProjectArchiveDownload;
    cache_id?: string;
    include_paths?: string[];
    exclude_paths?: string[];
    max_uncompressed_bytes?: number;
    temporary_quota_grace?: boolean;
    lro?: LroRef;
  }) => Promise<ProjectArchiveRestoreResult>;
} {
  return {
    async cacheProjectArchive({
      project_id,
      download,
      max_entries,
      lro,
    }: {
      project_id: string;
      download: SignedProjectArchiveDownload;
      max_entries?: number;
      lro?: LroRef;
    }): Promise<ProjectArchiveIndexResult> {
      const started = Date.now();
      await getOrEnsureVolume(project_id);
      const cache_id = projectArchiveCacheId(download);
      const paths = projectArchiveCachePaths({ project_id, cache_id });
      await mkdir(paths.dir, { recursive: true });
      const cached = await readCachedProjectArchiveIndex({
        indexPath: paths.index,
      });
      const archiveExists = await exists(paths.archive);
      if (cached != null && archiveExists) {
        const requestedEntryLimit =
          typeof max_entries === "number" && Number.isFinite(max_entries)
            ? Math.max(0, Math.floor(max_entries))
            : 0;
        if (
          !cached.truncated ||
          requestedEntryLimit === 0 ||
          requestedEntryLimit <= (cached.entries?.length ?? 0)
        ) {
          return cached;
        }
      }

      const downloaded = archiveExists
        ? await hashProjectArchiveFile(paths.archive)
        : await downloadSignedProjectArchive({
            download,
            dest: paths.archive,
            lro,
          });
      const { file_count, uncompressed_bytes, entries, truncated } =
        await scanProjectArchiveTar({
          archivePath: paths.archive,
          exclude: normalizeProjectArchivePathRoots(
            LEGACY_PROJECT_ARCHIVE_MANAGED_EXCLUDE_ROOTS,
          ),
          collect_entries: true,
          max_entries,
          lro,
        });
      const result: ProjectArchiveIndexResult = {
        cache_id,
        ...downloaded,
        file_count,
        uncompressed_bytes,
        entries,
        truncated,
        duration_ms: Date.now() - started,
      };
      await writeFile(paths.index, JSON.stringify(result), "utf8");
      return result;
    },

    async restoreProjectArchive({
      project_id,
      download,
      cache_id,
      include_paths,
      exclude_paths,
      max_uncompressed_bytes,
      temporary_quota_grace,
      lro,
    }: {
      project_id: string;
      download?: SignedProjectArchiveDownload;
      cache_id?: string;
      include_paths?: string[];
      exclude_paths?: string[];
      max_uncompressed_bytes?: number;
      temporary_quota_grace?: boolean;
      lro?: LroRef;
    }): Promise<ProjectArchiveRestoreResult> {
      const started = Date.now();
      await getOrEnsureVolume(project_id);
      const home = projectMountpoint(project_id);
      let tmpDir: string | undefined;
      let memberListTmpDir: string | undefined;
      let archivePath: string;
      let savedQuotaSize: number | undefined;
      let quotaGraceEnabled = false;
      let quotaGraceMarkedActive = false;
      if (cache_id) {
        archivePath = projectArchiveCachePaths({
          project_id,
          cache_id,
        }).archive;
        if (!(await exists(archivePath))) {
          throw new Error("cached project archive is not available");
        }
      } else {
        if (download == null) {
          throw new Error(
            "project archive restore requires download or cache_id",
          );
        }
        const tmpRoot = archiveRestoreTmpRoot();
        await mkdir(tmpRoot, { recursive: true });
        tmpDir = await mkdtemp(join(tmpRoot, `${project_id}-`));
        archivePath = join(tmpDir, "project.tar.zst");
      }
      try {
        const downloaded =
          download != null && !cache_id
            ? await downloadSignedProjectArchive({
                download,
                dest: archivePath,
                lro,
              })
            : await hashProjectArchiveFile(archivePath);
        if (temporary_quota_grace) {
          if (getProjectQuota == null || setProjectQuota == null) {
            throw new Error(
              "legacy project archive restore requested quota grace without quota helpers",
            );
          } else {
            try {
              setProjectQuotaGraceActive?.(project_id, true);
              quotaGraceMarkedActive = true;
              const quota = await getProjectQuota(project_id);
              if (quota.size > 0) {
                savedQuotaSize = quota.size;
                publishArchiveProgress({
                  lro,
                  phase: "quota",
                  message: "temporarily lifting project quota for migration",
                  progress: 47,
                  detail: {
                    previous_quota_bytes: quota.size,
                    used_bytes: quota.used,
                    warning: quota.warning,
                  },
                });
                await setProjectQuota(project_id, "none");
                quotaGraceEnabled = true;
              }
            } catch (err) {
              logger.warn(
                "legacy project archive restore failed to enable quota grace",
                { project_id, err: `${err}` },
              );
              throw err;
            }
          }
        }
        const include = normalizeProjectArchivePathRoots(include_paths);
        const exclude = mergeProjectArchivePathRoots(
          LEGACY_PROJECT_ARCHIVE_MANAGED_EXCLUDE_ROOTS,
          exclude_paths,
        );
        const useSelection = include != null || exclude != null;
        let member_list_path: string | undefined;
        if (useSelection) {
          if (tmpDir == null) {
            const tmpRoot = archiveRestoreTmpRoot();
            await mkdir(tmpRoot, { recursive: true });
            memberListTmpDir = await mkdtemp(
              join(tmpRoot, `${project_id}-list-`),
            );
          }
          member_list_path = join(
            tmpDir ?? memberListTmpDir!,
            "selected-members.txt",
          );
        }
        const { file_count, uncompressed_bytes } = await scanProjectArchiveTar({
          archivePath,
          include,
          exclude,
          member_list_path,
          max_uncompressed_bytes,
          lro,
        });
        if (useSelection && file_count === 0) {
          throw new Error("selected archive paths matched no files");
        }
        // A legacy cocalc.com archive stores files as uid/gid 2001. On a
        // rootless project host that literal host owner is wrong; project files
        // must match the mapped uid/gid of the freshly created project volume.
        await mapLegacyArchiveOwnership({ dest: home, progress: 68, lro });
        await extractProjectArchiveTar({
          archivePath,
          dest: home,
          member_list_path,
          expected_file_count: file_count,
          expected_uncompressed_bytes: uncompressed_bytes,
          lro,
        });
        await mapLegacyArchiveOwnership({ dest: home, progress: 90, lro });
        publishArchiveProgress({
          lro,
          phase: "finish",
          message: "legacy project files restored",
          progress: 95,
          detail: {
            file_count,
            uncompressed_bytes,
          },
        });
        invalidateProjectFsServer(project_id);
        void touchProjectLastEdited(project_id, "legacy-migration-restore");
        return {
          ...downloaded,
          file_count,
          uncompressed_bytes,
          duration_ms: Date.now() - started,
        };
      } finally {
        if (quotaGraceEnabled && savedQuotaSize != null) {
          try {
            await setProjectQuota?.(project_id, savedQuotaSize);
            publishArchiveProgress({
              lro,
              phase: "quota",
              message: "restored project quota after migration",
              progress: 98,
              detail: {
                quota_bytes: savedQuotaSize,
              },
            });
          } catch (err) {
            logger.warn(
              "legacy project archive restore failed to restore project quota",
              { project_id, savedQuotaSize, err: `${err}` },
            );
          }
        }
        if (quotaGraceMarkedActive) {
          setProjectQuotaGraceActive?.(project_id, false);
        }
        if (tmpDir) {
          await rm(tmpDir, { recursive: true, force: true }).catch((err) => {
            logger.warn("legacy project archive temp cleanup failed", {
              project_id,
              tmpDir,
              err: `${err}`,
            });
          });
        }
        if (memberListTmpDir) {
          await rm(memberListTmpDir, { recursive: true, force: true }).catch(
            (err) => {
              logger.warn("legacy project archive member-list cleanup failed", {
                project_id,
                memberListTmpDir,
                err: `${err}`,
              });
            },
          );
        }
      }
    },
  };
}
