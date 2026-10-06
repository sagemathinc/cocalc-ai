import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import getLogger from "@cocalc/backend/logger";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import cpExec from "@cocalc/backend/sandbox/cp";
import { parseOutput } from "@cocalc/backend/sandbox/exec";
import { exists } from "@cocalc/backend/misc/async-utils-node";
import { getMasterConatClient } from "./master-status";
import { getLocalHostId } from "./sqlite/hosts";
import callHub from "@cocalc/conat/hub/call-hub";
import { touchProjectLastEdited } from "./last-edited";
import {
  ensureVolume,
  getVolume,
  getScratchMountpoint,
  resolveRusticRepo,
} from "./file-server";
import { getRootfsMountpoint } from "@cocalc/project-runner/run/rootfs";
import type { ProjectCopyRow } from "@cocalc/conat/hub/api/projects";
import {
  PROJECT_RUNTIME_HOME_ALIASES,
  projectRuntimeHomeRelativePath,
} from "@cocalc/util/project-runtime";
import { installPathFromStaging } from "./path-copy-archive";

const logger = getLogger("project-host:pending-copies");

const COPY_STAGING_DIR = ".copy-staging";
const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;
// The hub hands an 'applying' row to another worker 35 minutes after the claim
// (STALE_APPLYING_MS in server/projects/copy-db.ts). Every row of a claimed
// batch, applied one after another, must stop before then, or two workers
// would write the same destination.
const CLAIM_BUDGET_MS = 30 * 60 * 1000;
const RESTORE_SNAPSHOT_NOT_FOUND_RETRY_DELAY_MS = Math.max(
  1,
  Number(process.env.COCALC_COPY_RESTORE_SNAPSHOT_NOT_FOUND_RETRY_DELAY_MS) ||
    (process.env.NODE_ENV === "test" ? 1 : 5000),
);
const RESTORE_SNAPSHOT_NOT_FOUND_RETRIES = Math.max(
  0,
  Number(process.env.COCALC_COPY_RESTORE_SNAPSHOT_NOT_FOUND_RETRIES) || 3,
);

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

function normalizeBackupPath(raw: string): string {
  const normalized = normalizeCopyPath(raw, "src_path");
  if (!normalized) return "";
  const runtimeRelative = projectRuntimeHomeRelativePath(normalized);
  if (runtimeRelative != null) {
    return runtimeRelative;
  }
  if (path.posix.isAbsolute(normalized)) {
    return normalized.replace(/^\/+/, "");
  }
  return normalized;
}

async function statIfExists(p: string) {
  try {
    return await stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return undefined;
    }
    throw err;
  }
}

function isSnapshotNotFoundError(err: unknown): boolean {
  const message = `${(err as any)?.message ?? err}`.toLowerCase();
  return (
    message.includes("no snapshot with id") ||
    (message.includes("snapshot") && message.includes("not found"))
  );
}

async function restoreSnapshotWithRetry({
  restoreFs,
  row,
  srcPath,
  stagingRel,
  deadline,
}: {
  restoreFs: SandboxedFilesystem;
  row: ProjectCopyRow;
  srcPath: string;
  stagingRel: string;
  deadline: number;
}): Promise<void> {
  const source = `${row.snapshot_id}${srcPath ? ":" + srcPath : ""}`;
  for (let retry = 0; ; retry += 1) {
    try {
      // A failed or killed restore leaves partial files in staging.
      parseOutput(
        await restoreFs.rustic(["restore", source, stagingRel], {
          timeout: Math.min(RESTORE_TIMEOUT_MS, remainingMs(deadline)),
        }),
      );
      return;
    } catch (err) {
      if (
        retry >= RESTORE_SNAPSHOT_NOT_FOUND_RETRIES ||
        !isSnapshotNotFoundError(err)
      ) {
        throw err;
      }
      logger.warn("copy snapshot not visible yet; retrying restore", {
        copy_id: row.copy_id,
        src_project_id: row.src_project_id,
        dest_project_id: row.dest_project_id,
        snapshot_id: row.snapshot_id,
        retry: retry + 1,
        retry_delay_ms: RESTORE_SNAPSHOT_NOT_FOUND_RETRY_DELAY_MS,
        err: `${err}`,
      });
      await delay(RESTORE_SNAPSHOT_NOT_FOUND_RETRY_DELAY_MS);
    }
  }
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw new Error("copy did not finish before its claim expired");
  }
  return remaining;
}

async function applyCopyRow(
  row: ProjectCopyRow,
  deadline: number,
): Promise<void> {
  const srcPath = normalizeBackupPath(row.src_path);
  let destPath = normalizeCopyPath(row.dest_path, "dest_path");
  const destHomeRelative = projectRuntimeHomeRelativePath(destPath);
  if (destHomeRelative != null) {
    destPath = destHomeRelative;
  }
  if (!destPath) {
    if (!srcPath) {
      throw new Error("dest_path cannot be empty when src_path is empty");
    }
    destPath = path.posix.basename(srcPath);
  }

  await ensureVolume(row.dest_project_id);
  const volume = await getVolume(row.dest_project_id);
  const projectRoot = volume.path;

  const destFs = new SandboxedFilesystem(projectRoot, {
    rootfs: getRootfsMountpoint(row.dest_project_id),
    scratch: getScratchMountpoint(row.dest_project_id),
    homeAliases: [...PROJECT_RUNTIME_HOME_ALIASES],
  });
  const destAbs = await destFs.safeAbsPath(destPath);
  if (destAbs === projectRoot) {
    throw new Error("dest_path cannot be project root");
  }

  const destStat = await statIfExists(destAbs);
  const destExists = destStat != null;
  if (row.exact && destExists && !(row.options?.force ?? true)) {
    if (row.options?.errorOnExist) {
      const err = new Error(
        "SystemError [ERR_FS_CP_EEXIST]: Target already exists",
      );
      // @ts-ignore -- Node's SystemError code is not part of Error.
      err.code = "ERR_FS_CP_EEXIST";
      throw err;
    }
    logger.debug("copy skipped (exact destination exists)", {
      copy_id: row.copy_id,
      dest_project_id: row.dest_project_id,
      dest_path: destPath,
    });
    return;
  }
  const stagingId = randomUUID();
  const stagingRel = path.posix.join(COPY_STAGING_DIR, stagingId, destPath);
  const stagingRoot = path.join(projectRoot, COPY_STAGING_DIR, stagingId);
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });

  const repo = await resolveRusticRepo(row.src_project_id);
  const restoreFs = new SandboxedFilesystem(projectRoot, {
    rusticRepo: repo,
    host: `project-${row.src_project_id}`,
    homeAliases: [...PROJECT_RUNTIME_HOME_ALIASES],
  });

  try {
    await restoreSnapshotWithRetry({
      restoreFs,
      row,
      srcPath,
      stagingRel,
      deadline,
    });
    const stagingAbs = await restoreFs.safeAbsPath(stagingRel);
    if (!(await exists(stagingAbs))) {
      throw new Error(`restore produced no data at ${stagingRel}`);
    }
    const installed = await installPathFromStaging({
      source: stagingAbs,
      destination: destAbs,
      destinationExists: destExists,
      exact: row.exact,
      options: row.options ?? undefined,
      copy: async (source, destination) => {
        await cpExec(source, destination, {
          ...row.options,
          recursive: row.options?.recursive ?? true,
          reflink: true,
          timeout: remainingMs(deadline),
        });
      },
    });
    if (installed) {
      void touchProjectLastEdited(row.dest_project_id, "pending-copy");
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function reportCopyStatus(
  row: ProjectCopyRow,
  status: "done" | "failed",
  last_error?: string,
) {
  const client = getMasterConatClient();
  const hostId = getLocalHostId();
  if (!client || !hostId) return;
  try {
    await callHub({
      client,
      host_id: hostId,
      name: "hosts.updateCopyStatus",
      args: [
        {
          copy_id: row.copy_id,
          src_project_id: row.src_project_id,
          src_path: row.src_path,
          dest_project_id: row.dest_project_id,
          dest_path: row.dest_path,
          status,
          last_error,
        },
      ],
      timeout: 30000,
    });
  } catch (err) {
    logger.warn("failed to report copy status", { err: `${err}` });
  }
}

export async function applyPendingCopies({
  project_id,
  limit = 10,
}: {
  project_id?: string;
  limit?: number;
} = {}): Promise<number> {
  const client = getMasterConatClient();
  const hostId = getLocalHostId();
  if (!client || !hostId) {
    logger.debug("pending copies skipped (no master client or host id)");
    return 0;
  }

  let rows: ProjectCopyRow[] = [];
  // Taken before the claim, so the budget never outlasts the hub's clock.
  const deadline = Date.now() + CLAIM_BUDGET_MS;
  try {
    rows = await callHub({
      client,
      host_id: hostId,
      name: "hosts.claimPendingCopies",
      args: [{ project_id, limit }],
      timeout: 30000,
    });
  } catch (err) {
    logger.warn("failed to claim pending copies", { err: `${err}` });
    return 0;
  }

  for (const row of rows) {
    if (Date.now() >= deadline) {
      // Too late to start: leave the row 'applying' so the hub reclaims it
      // once the claim goes stale, instead of failing it permanently.
      logger.warn("pending copy not started before its claim expired", {
        copy_id: row.copy_id,
        dest_project_id: row.dest_project_id,
      });
      continue;
    }
    try {
      await applyCopyRow(row, deadline);
      await reportCopyStatus(row, "done");
    } catch (err) {
      logger.warn("pending copy failed", {
        src_project_id: row.src_project_id,
        dest_project_id: row.dest_project_id,
        err: `${err}`,
      });
      await reportCopyStatus(row, "failed", `${err}`);
    }
  }
  return rows.length;
}

export function startCopyWorker(intervalMs = 30_000): () => void {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await applyPendingCopies();
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    tick().catch((err) =>
      logger.debug("pending copy tick failed", { err: `${err}` }),
    );
  }, intervalMs);
  timer.unref();
  tick().catch((err) =>
    logger.debug("pending copy initial tick failed", { err: `${err}` }),
  );
  return () => clearInterval(timer);
}
