import path from "node:path";
import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import getPool from "@cocalc/database/pool";
import { waitForCompletion as waitForLroCompletion } from "@cocalc/conat/lro/client";
import { type Fileserver } from "@cocalc/conat/files/file-server";
import { type CopyOptions } from "@cocalc/conat/files/fs";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { createBackup as createBackupLro } from "@cocalc/server/conat/api/project-backups";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { insertCopyRowIfMissing, upsertCopyRow } from "./copy-db";

const logger = getLogger("server:projects:copy");

const COPY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COPY_FILES_TIMEOUT_MS = 30 * 60 * 1000;

type CopyStep = {
  step: string;
  message?: string;
  detail?: any;
};

type CopyProgress = (update: CopyStep) => void;

type CopySource = { project_id: string; path: string | string[] };
type CopyDest = { project_id: string; path: string };
type CopyDestWithHost = CopyDest & { host_id: string };
type QueueMode = "upsert" | "insert";

export const COPY_CANCELED_CODE = "copy-canceled";

function copyCanceledError(): Error {
  const err = new Error("copy canceled");
  // @ts-ignore
  err.code = COPY_CANCELED_CODE;
  return err;
}

function report(progress: CopyProgress | undefined, update: CopyStep) {
  progress?.(update);
}

async function createBackupAndWait({
  account_id,
  project_id,
  tags,
}: {
  account_id: string;
  project_id: string;
  tags?: string[];
}): Promise<{ id: string; time?: string }> {
  const op = await createBackupLro(
    { account_id, project_id, tags },
    { skip_rootfs_portability_check: true },
  );
  const summary = await waitForLroCompletion({
    op_id: op.op_id,
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    client: conat(),
  });
  if (summary.status !== "succeeded") {
    const reason = summary.error ?? summary.status;
    throw new Error(`backup failed: ${reason}`);
  }
  const result = summary.result ?? {};
  const id = result.id ?? result.backup_id;
  if (!id) {
    throw new Error("backup completed without snapshot id");
  }
  return { id, time: result.time ?? result.backup_time };
}

function normalizeCopyPath(raw: string, label: string): string {
  if (typeof raw !== "string") {
    throw new Error(`${label} must be a string`);
  }
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (path.posix.isAbsolute(trimmed)) {
    return path.posix.normalize(trimmed);
  }
  const normalized = path.posix.normalize(trimmed);
  if (normalized === "." || normalized === "") return "";
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} must not escape project root`);
  }
  return normalized;
}

function normalizeSrcPaths(src: CopySource): string[] {
  const raw = Array.isArray(src.path) ? src.path : [src.path];
  if (!raw.length) {
    throw new Error("src.path must not be empty");
  }
  const normalized = raw.map((p, idx) =>
    normalizeCopyPath(p, `src.path[${idx}]`),
  );
  return normalized;
}

function normalizeHomePath(raw?: string): string | undefined {
  if (!raw) return;
  const normalized = normalizeCopyPath(raw, "src_home");
  if (!path.posix.isAbsolute(normalized)) {
    throw new Error("src_home must be an absolute path");
  }
  if (normalized === "/") return normalized;
  return normalized.replace(/\/+$/, "");
}

function normalizeBackupPath({
  raw,
  label,
  src_home,
}: {
  raw: string;
  label: string;
  src_home?: string;
}): string {
  const normalized = normalizeCopyPath(raw, label);
  if (!normalized) return "";
  if (src_home) {
    if (src_home === "/") {
      return normalized.replace(/^\/+/, "");
    }
    if (normalized === src_home) return "";
    if (normalized.startsWith(`${src_home}/`)) {
      return normalized.slice(src_home.length + 1);
    }
  }
  if (normalized === "/root") return "";
  if (normalized.startsWith("/root/")) {
    return normalized.slice("/root/".length);
  }
  if (path.posix.isAbsolute(normalized)) {
    return normalized.replace(/^\/+/, "");
  }
  return normalized;
}

function isProjectRootCopyDest(destPath: string): boolean {
  const canonical =
    destPath === "/"
      ? "/"
      : destPath.replace(/\/+$/, "") || (destPath.startsWith("/") ? "/" : "");
  return canonical === "" || canonical === "/" || canonical === "/root";
}

function resolveRemoteSingleDestPath({
  srcPath,
  destPath,
}: {
  srcPath: string;
  destPath: string;
}): string {
  if (!srcPath || !isProjectRootCopyDest(destPath)) {
    return destPath;
  }
  return normalizeCopyPath(
    path.posix.join("/root", path.posix.basename(srcPath)),
    "dest.path",
  );
}

async function getHostIds(project_ids: string[]): Promise<Map<string, string>> {
  const { rows } = await getPool().query<{
    project_id: string;
    host_id: string | null;
  }>(
    `
      SELECT project_id, host_id
      FROM projects
      WHERE project_id = ANY($1)
    `,
    [project_ids],
  );
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.host_id) {
      map.set(row.project_id, row.host_id);
    }
  }
  for (const project_id of project_ids) {
    if (!map.has(project_id)) {
      throw new Error(`project ${project_id} has no host assigned`);
    }
  }
  return map;
}

async function getProjectBackupFreshness({
  project_id,
}: {
  project_id: string;
}): Promise<{ last_edited: Date | null; last_backup: Date | null }> {
  const { rows } = await getPool().query<{
    last_edited: Date | null;
    last_backup: Date | null;
  }>(
    `
      SELECT last_edited, last_backup
      FROM projects
      WHERE project_id = $1
    `,
    [project_id],
  );
  return {
    last_edited: rows[0]?.last_edited ?? null,
    last_backup: rows[0]?.last_backup ?? null,
  };
}

const BACKUP_REUSE_SKEW_MS = 5_000;
const BACKUP_FILE_MTIME_SKEW_MS = 2_000;

async function latestIndexedBackup({
  client,
  project_id,
}: {
  client: Fileserver;
  project_id: string;
}): Promise<{ id: string; time?: string } | undefined> {
  const backups = await client.getBackups({
    project_id,
    indexed_only: true,
  });
  if (!backups.length) {
    return;
  }
  const latest = backups[backups.length - 1];
  return {
    id: latest.id,
    time:
      latest.time instanceof Date
        ? latest.time.toISOString()
        : `${latest.time}`,
  };
}

async function snapshotMatchesCurrentSourceFiles({
  client,
  project_id,
  src_paths,
  backup_src_paths,
  snapshot_id,
}: {
  client: Fileserver;
  project_id: string;
  src_paths: string[];
  backup_src_paths: string[];
  snapshot_id: string;
}): Promise<boolean> {
  if (
    src_paths.length === 0 ||
    src_paths.length !== backup_src_paths.length ||
    backup_src_paths.some((p) => !p)
  ) {
    return false;
  }
  const fs = conatWithProjectRouting().fs({ project_id });
  for (let i = 0; i < src_paths.length; i += 1) {
    const srcPath = src_paths[i];
    const backupPath = backup_src_paths[i];
    const stat = await fs.stat(srcPath).catch(() => undefined);
    if (!stat?.isFile()) {
      return false;
    }
    const parent = path.posix.dirname(backupPath);
    const base = path.posix.basename(backupPath);
    const listing = await client.getBackupFiles({
      project_id,
      id: snapshot_id,
      path: parent === "." ? "" : parent,
    });
    const entry = listing.find((item) => item.name === base);
    if (!entry || entry.isDir) {
      return false;
    }
    if (entry.size !== stat.size) {
      return false;
    }
    if (
      Math.abs(Number(entry.mtime ?? 0) - Math.floor(stat.mtimeMs)) >
      BACKUP_FILE_MTIME_SKEW_MS
    ) {
      return false;
    }
  }
  return true;
}

async function findReusableBackupSnapshot({
  client,
  project_id,
  src_paths,
  backup_src_paths,
}: {
  client: Fileserver;
  project_id: string;
  src_paths?: string[];
  backup_src_paths?: string[];
}): Promise<{ id: string; time?: string } | undefined> {
  const latest = await latestIndexedBackup({ client, project_id });
  if (!latest?.id) {
    return;
  }
  if (
    src_paths?.length &&
    backup_src_paths?.length &&
    (await snapshotMatchesCurrentSourceFiles({
      client,
      project_id,
      src_paths,
      backup_src_paths,
      snapshot_id: latest.id,
    }))
  ) {
    return latest;
  }

  const { last_edited, last_backup } = await getProjectBackupFreshness({
    project_id,
  });
  if (!last_backup) {
    return;
  }
  const lastEditedMs = last_edited ? new Date(last_edited).getTime() : 0;
  const lastBackupMs = new Date(last_backup).getTime();
  if (
    Number.isFinite(lastEditedMs) &&
    Number.isFinite(lastBackupMs) &&
    lastEditedMs > lastBackupMs + BACKUP_REUSE_SKEW_MS
  ) {
    return;
  }
  const latestMs = latest?.time ? new Date(latest.time).getTime() : NaN;
  if (!Number.isFinite(latestMs)) {
    return;
  }
  if (latestMs + BACKUP_REUSE_SKEW_MS < lastBackupMs) {
    return;
  }
  return latest;
}

async function triggerRemoteCopyApply({
  queuedByHost,
  timeout_ms,
}: {
  queuedByHost: Map<string, number>;
  timeout_ms: number;
}): Promise<void> {
  if (!queuedByHost.size) return;
  const client = conat();
  await Promise.all(
    Array.from(queuedByHost.entries()).map(async ([host_id, queued]) => {
      try {
        await createHostControlClient({
          host_id,
          client,
          timeout: Math.max(5_000, Math.min(timeout_ms, 30_000)),
        }).applyPendingCopies({
          limit: Math.max(queued, 10),
        });
      } catch (err) {
        logger.warn("copyProjectFiles: immediate remote copy trigger failed", {
          host_id,
          queued,
          err: `${err}`,
        });
      }
    }),
  );
}

async function assertBackupContainsPath({
  project_id,
  snapshot_id,
  path: srcPath,
  client,
}: {
  project_id: string;
  snapshot_id: string;
  path: string;
  client: Fileserver;
}): Promise<void> {
  if (!srcPath) return;
  const parent = path.posix.dirname(srcPath);
  const base = path.posix.basename(srcPath);
  const listing = await client.getBackupFiles({
    project_id,
    id: snapshot_id,
    path: parent === "." ? "" : parent,
  });
  if (!listing.some((entry) => entry.name === base)) {
    throw new Error(`path not found in backup: ${srcPath}`);
  }
}

export async function copyProjectFiles({
  src,
  src_home,
  dests,
  options,
  account_id,
  op_id,
  progress,
  snapshot_id,
  skip_queue = false,
  queue_mode = "upsert",
  timeout_ms = COPY_FILES_TIMEOUT_MS,
  shouldAbort,
}: {
  src: CopySource;
  src_home?: string;
  dests: CopyDest[];
  options?: CopyOptions;
  account_id: string;
  op_id?: string;
  progress?: CopyProgress;
  snapshot_id?: string;
  skip_queue?: boolean;
  queue_mode?: QueueMode;
  timeout_ms?: number;
  shouldAbort?: () => Promise<boolean>;
}): Promise<{ queued: number; local: number; snapshot_id?: string }> {
  if (!account_id) {
    throw new Error("account_id is required");
  }
  if (!dests.length) {
    throw new Error("at least one destination is required");
  }

  report(progress, { step: "validate" });
  if (shouldAbort && (await shouldAbort())) {
    throw copyCanceledError();
  }

  const srcPaths = normalizeSrcPaths(src);
  const normalizedSrcHome = normalizeHomePath(src_home);
  if (srcPaths.length > 1 && srcPaths.some((p) => !p)) {
    throw new Error("empty src path not allowed when copying multiple paths");
  }
  const backupSrcPaths = srcPaths.map((srcPath, idx) =>
    normalizeBackupPath({
      raw: srcPath,
      label: `src.path[${idx}]`,
      src_home: normalizedSrcHome,
    }),
  );
  if (backupSrcPaths.length > 1 && backupSrcPaths.some((p) => !p)) {
    throw new Error(
      "empty backup source path not allowed when copying multiple paths",
    );
  }
  const normalizedSrc: CopySource = {
    project_id: src.project_id,
    path: Array.isArray(src.path) ? srcPaths : srcPaths[0],
  };
  if (shouldAbort && (await shouldAbort())) {
    throw copyCanceledError();
  }

  const normalizedDests = dests.map((dest, idx) => ({
    project_id: dest.project_id,
    path: normalizeCopyPath(dest.path, `dests[${idx}].path`),
  }));

  const projectIds = new Set<string>([src.project_id]);
  for (const dest of normalizedDests) {
    projectIds.add(dest.project_id);
  }
  const hostIds = await getHostIds(Array.from(projectIds));
  const srcHostId = hostIds.get(src.project_id)!;
  const srcProjectClient = await getProjectFileServerClient({
    project_id: src.project_id,
    timeout: timeout_ms,
  });

  const localDests: CopyDest[] = [];
  const remoteDests: CopyDestWithHost[] = [];
  for (const dest of normalizedDests) {
    const destHostId = hostIds.get(dest.project_id)!;
    if (destHostId === srcHostId) {
      localDests.push(dest);
    } else {
      remoteDests.push({ ...dest, host_id: destHostId });
    }
  }

  let queuedCount = 0;
  let localCount = 0;

  if (remoteDests.length && !skip_queue) {
    if (srcPaths.some((p) => p === "/scratch" || p.startsWith("/scratch/"))) {
      throw new Error(
        "copying from /scratch across hosts is not supported because /scratch is not backed up",
      );
    }
    if (shouldAbort && (await shouldAbort())) {
      throw copyCanceledError();
    }
    report(progress, {
      step: "backup",
      detail: { paths: srcPaths.length, destinations: remoteDests.length },
    });
    // TODO: once last_edited is reliable, allow reusing a recent backup.
    const tags = [
      "purpose=copy",
      `src_project_id=${src.project_id}`,
      ...(op_id ? [`op_id=${op_id}`] : []),
      ...backupSrcPaths
        .filter((p) => p)
        .map((p) => `src_path=${encodeURIComponent(p)}`),
    ];
    const backupClient = srcProjectClient;
    let createdBackup = false;
    let reusedBackup = false;
    if (!snapshot_id) {
      const reusableBackup = await findReusableBackupSnapshot({
        client: backupClient,
        project_id: src.project_id,
        src_paths: srcPaths,
        backup_src_paths: backupSrcPaths,
      }).catch((err) => {
        logger.warn("copyProjectFiles: reusable backup lookup failed", {
          project_id: src.project_id,
          err: `${err}`,
        });
        return undefined;
      });
      if (reusableBackup?.id) {
        snapshot_id = reusableBackup.id;
        reusedBackup = true;
        report(progress, {
          step: "backup",
          message: "reusing recent backup",
          detail: { snapshot_id, time: reusableBackup.time },
        });
      } else {
        const backup = await createBackupAndWait({
          account_id,
          project_id: src.project_id,
          tags,
        });
        snapshot_id = backup.id;
        createdBackup = true;
      }
    }
    if (!snapshot_id) {
      throw new Error("backup creation failed (missing snapshot id)");
    }
    if (shouldAbort && (await shouldAbort())) {
      throw copyCanceledError();
    }
    try {
      const assertSnapshotContainsSources = async () => {
        for (const srcPath of backupSrcPaths) {
          if (shouldAbort && (await shouldAbort())) {
            throw copyCanceledError();
          }
          await assertBackupContainsPath({
            project_id: src.project_id,
            snapshot_id: snapshot_id!,
            path: srcPath,
            client: backupClient,
          });
        }
      };
      try {
        await assertSnapshotContainsSources();
      } catch (err) {
        if (!reusedBackup) {
          throw err;
        }
        report(progress, {
          step: "backup",
          message: "recent backup missing requested path; creating new backup",
          detail: { snapshot_id },
        });
        const backup = await createBackupAndWait({
          account_id,
          project_id: src.project_id,
          tags,
        });
        snapshot_id = backup.id;
        reusedBackup = false;
        createdBackup = true;
        await assertSnapshotContainsSources();
      }

      report(progress, {
        step: "queue",
        message: "queueing remote copies",
        detail: { snapshot_id, destinations: remoteDests.length },
      });
      const expiresAt = new Date(Date.now() + COPY_TTL_MS);
      const queuedByHost = new Map<string, number>();

      for (const dest of remoteDests) {
        if (shouldAbort && (await shouldAbort())) {
          throw copyCanceledError();
        }
        if (srcPaths.length > 1) {
          for (const srcPath of backupSrcPaths) {
            const base = path.posix.basename(srcPath);
            const destPath = normalizeCopyPath(
              path.posix.join(dest.path, base),
              "dest.path",
            );
            const inserted =
              queue_mode === "insert"
                ? await insertCopyRowIfMissing({
                    src_project_id: src.project_id,
                    src_path: srcPath,
                    dest_project_id: dest.project_id,
                    dest_path: destPath,
                    op_id,
                    snapshot_id,
                    options,
                    expires_at: expiresAt,
                  })
                : await upsertCopyRow({
                    src_project_id: src.project_id,
                    src_path: srcPath,
                    dest_project_id: dest.project_id,
                    dest_path: destPath,
                    op_id,
                    snapshot_id,
                    options,
                    expires_at: expiresAt,
                  });
            if (queue_mode === "upsert" || inserted) {
              queuedCount += 1;
              queuedByHost.set(
                dest.host_id,
                (queuedByHost.get(dest.host_id) ?? 0) + 1,
              );
            }
          }
        } else {
          const destPath = resolveRemoteSingleDestPath({
            srcPath: backupSrcPaths[0],
            destPath: dest.path,
          });
          const inserted =
            queue_mode === "insert"
              ? await insertCopyRowIfMissing({
                  src_project_id: src.project_id,
                  src_path: backupSrcPaths[0],
                  dest_project_id: dest.project_id,
                  dest_path: destPath,
                  op_id,
                  snapshot_id,
                  options,
                  expires_at: expiresAt,
                })
              : await upsertCopyRow({
                  src_project_id: src.project_id,
                  src_path: backupSrcPaths[0],
                  dest_project_id: dest.project_id,
                  dest_path: destPath,
                  op_id,
                  snapshot_id,
                  options,
                  expires_at: expiresAt,
                });
          if (queue_mode === "upsert" || inserted) {
            queuedCount += 1;
            queuedByHost.set(
              dest.host_id,
              (queuedByHost.get(dest.host_id) ?? 0) + 1,
            );
          }
        }
      }
      report(progress, {
        step: "queue",
        message: `queued ${queuedCount} remote copies`,
        detail: {
          snapshot_id,
          queued: queuedCount,
          local: localCount,
          total: queuedCount + localCount,
        },
      });
      await triggerRemoteCopyApply({ queuedByHost, timeout_ms });
    } catch (err) {
      if (createdBackup && snapshot_id) {
        try {
          await backupClient.deleteBackup({
            project_id: src.project_id,
            id: snapshot_id,
          });
        } catch (cleanupErr) {
          logger.warn("copyProjectFiles: backup cleanup failed", {
            project_id: src.project_id,
            snapshot_id,
            err: `${cleanupErr}`,
          });
        }
      }
      throw err;
    }
  }

  if (localDests.length) {
    if (shouldAbort && (await shouldAbort())) {
      throw copyCanceledError();
    }
    report(progress, {
      step: "copy-local",
      detail: { count: localDests.length, paths: srcPaths.length },
    });
    const client = srcProjectClient;
    for (const dest of localDests) {
      await client.cp({ src: normalizedSrc, dest, options });
      localCount += srcPaths.length;
    }
  }

  report(progress, { step: "done" });
  return { queued: queuedCount, local: localCount, snapshot_id };
}
