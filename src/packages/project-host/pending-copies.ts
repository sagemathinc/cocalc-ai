import path from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import getLogger from "@cocalc/backend/logger";
import { SandboxedFilesystem } from "@cocalc/backend/sandbox";
import { parseOutput } from "@cocalc/backend/sandbox/exec";
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
import {
  rootfsCopyReadiness,
  rootfsSandboxOptions,
} from "@cocalc/project-runner/run/rootfs-agent/registry";
import { rootfsContainerPath } from "@cocalc/backend/sandbox/rootfs-agent-routes";
import type { ProjectCopyRow } from "@cocalc/conat/hub/api/projects";
import {
  PROJECT_RUNTIME_HOME_ALIASES,
  projectRuntimeHomeRelativePath,
} from "@cocalc/util/project-runtime";
import { installPathFromStaging } from "./path-copy-archive";
import { beneathRelative, kindBeneath } from "./beneath-copy";
import { installThroughAgent, type AgentLike } from "./agent-copy";

const logger = getLogger("project-host:pending-copies");

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

// A rootfs copy that can't be installed yet (B5): the row goes back to
// "queued" (nothing was written), and runs once the project is running.
// "stopped": the project isn't running, and the copy waits for its start
// however long that takes; "not-ready": it runs, but its rootfs or agent
// isn't ready yet, which should pass soon (bounded below).
class DeferredCopy extends Error {
  constructor(
    message: string,
    readonly reason: "stopped" | "not-ready",
  ) {
    super(message);
  }
}

// for tests
export const copyDeps = { rootfsCopyReadiness };

// N1: a copy into a running project that stays not ready (or whose agent
// keeps going away) fails, with the reason, once that has lasted an hour
// over at least 10 passes on this host, instead of waiting until the row
// expires. A copy waiting for a stopped project is never bounded here (B5):
// a stopped pass ends the streak. Kept in memory, since the hub's claim
// clears last_error: a restart of this daemon only delays a failure.
export const DEFER_LIMITS = {
  maxNotReadyMs: 60 * 60 * 1000,
  minNotReadyPasses: 10,
};
const notReady = new Map<string, { since: number; passes: number }>();
// for tests
export const notReadyStreaks = notReady;

// true once this not-ready pass ends the row (it then fails)
function notReadyTooLong(copy_id: string): boolean {
  const now = Date.now();
  const streak = notReady.get(copy_id) ?? { since: now, passes: 0 };
  streak.passes += 1;
  notReady.set(copy_id, streak);
  return (
    now - streak.since >= DEFER_LIMITS.maxNotReadyMs &&
    streak.passes >= DEFER_LIMITS.minNotReadyPasses
  );
}

// rows that left this host's queue some other way (canceled, expired)
function pruneNotReady(): void {
  const old = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [id, streak] of notReady) {
    if (streak.since < old) notReady.delete(id);
  }
}

// The agent's operations that change the destination: once one has been
// sent, the copy may be partly placed and is never queued again (N1).
const MUTATING_AGENT_OPS = new Set([
  "writeFile",
  "mkdir",
  "symlink",
  "unlink",
  "rm",
  "rename",
  "chmod",
  "utimes",
]);

export function countingAgent(agent: AgentLike): {
  agent: AgentLike;
  changes: () => number;
} {
  let changes = 0;
  return {
    agent: {
      call: async (op, args, data) => {
        // counted unless refused before it was sent, not only when answered:
        // the agent may have acted on a request whose reply never came
        const mutating = MUTATING_AGENT_OPS.has(op);
        try {
          const reply = await agent.call(op, args, data);
          if (mutating) changes += 1;
          return reply;
        } catch (err) {
          if (mutating && (err as { unsent?: boolean })?.unsent !== true) {
            changes += 1;
          }
          throw err;
        }
      },
    },
    changes: () => changes,
  };
}

// thrown for a retryable agent failure after the copy changed something
class PartlyPlacedCopy extends Error {}

function isRetryableAgentError(err: unknown): boolean {
  return (
    (err as { name?: string })?.name === "AgentUnavailableError" &&
    (err as { retryable?: boolean })?.retryable === true
  );
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

  const scratch = getScratchMountpoint(row.dest_project_id);
  const destFs = new SandboxedFilesystem(projectRoot, {
    ...rootfsSandboxOptions(row.dest_project_id),
    scratch,
    homeAliases: [...PROJECT_RUNTIME_HOME_ALIASES],
  });
  // A separate-uid project's rootfs is written only by its rootfs agent,
  // inside its container (R1 PR3b): the host keeps its staging and sends the
  // tree. Otherwise the destination project's user can plant symlinks
  // anywhere in its tree: the install below is anchored beneath its root
  // and refuses them.
  // B5: a destination in the rootfs is installed only into the project's
  // live rootfs, never into a directory that isn't (or isn't yet) it
  const intoRootfs =
    rootfsContainerPath(destPath, {
      homeAliases: [...PROJECT_RUNTIME_HOME_ALIASES],
      // N2: the same classifier destFs routes by
      hasScratch: !!scratch,
      hasSharedScratch: false,
      containerHome: "/home/user",
    }) != null;
  const readiness = intoRootfs
    ? await copyDeps.rootfsCopyReadiness(row.dest_project_id)
    : "host";
  if (readiness === "stopped") {
    throw new DeferredCopy(
      "the destination project isn't running; the copy runs once it is",
      "stopped",
    );
  }
  if (readiness === "defer") {
    throw new DeferredCopy(
      "the destination project's rootfs isn't live yet; the copy runs once it is",
      "not-ready",
    );
  }
  const viaAgent = intoRootfs
    ? destFs.rootfsAgentDestination(destPath)
    : undefined;
  if (readiness === "agent" && viaAgent == null) {
    throw new DeferredCopy(
      "the destination project's rootfs agent isn't available yet",
      "not-ready",
    );
  }
  const destination = viaAgent
    ? undefined
    : await destFs.resolveAnchoredPath(destPath);
  if (destination != null && !destination.path) {
    throw new Error("dest_path cannot be project root");
  }
  const destExists = async (): Promise<boolean> => {
    if (viaAgent == null) {
      return (
        (await kindBeneath(destination!.root, destination!.path)) !== "missing"
      );
    }
    try {
      await viaAgent.agent.call("lstat", { path: viaAgent.containerPath });
      return true;
    } catch (err) {
      if ((err as { code?: string })?.code === "ENOENT") return false;
      throw err;
    }
  };

  if (row.exact && !(row.options?.force ?? true) && (await destExists())) {
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
  // Restore into a host-private directory, never inside the project (where
  // its user could swap in a symlink and redirect the restore's writes). The
  // host's TMPDIR is on the same filesystem, so the install can clone.
  const stagingRoot = await mkdtemp(
    path.join(tmpdir(), "cocalc-pending-copy-"),
  );
  const stagingRel = beneathRelative(
    path.posix.join(
      "restore",
      viaAgent ? viaAgent.containerPath.replace(/^\/+/, "") : destination!.path,
    ),
  );

  const repo = await resolveRusticRepo(row.src_project_id);
  const restoreFs = new SandboxedFilesystem(stagingRoot, {
    rusticRepo: repo,
    host: `project-${row.src_project_id}`,
  });

  try {
    await restoreSnapshotWithRetry({
      restoreFs,
      row,
      srcPath,
      stagingRel,
      deadline,
    });
    if ((await kindBeneath(stagingRoot, stagingRel)) === "missing") {
      throw new Error(`restore produced no data at ${stagingRel}`);
    }
    const options = {
      force: row.options?.force,
      errorOnExist: row.options?.errorOnExist,
      preserveTimestamps: row.options?.preserveTimestamps,
      recursive: row.options?.recursive ?? true,
      dereference: row.options?.dereference,
      // Stop between files once the claim's budget is spent.
      checkpoint: () => {
        remainingMs(deadline);
      },
    };
    // S2: the agent's answers decide only this row's outcome; the staging is
    // removed below by the host's own bookkeeping, whatever they say.
    let installed: boolean;
    if (viaAgent) {
      const counted = countingAgent(viaAgent.agent);
      try {
        installed = await installThroughAgent({
          src: path.join(stagingRoot, stagingRel),
          agent: counted.agent,
          dest: viaAgent.containerPath,
          exact: row.exact,
          options,
        });
      } catch (err) {
        if (isRetryableAgentError(err) && counted.changes() > 0) {
          throw new PartlyPlacedCopy(
            `the copy stopped after ${counted.changes()} changes were sent to the destination: ${err}`,
          );
        }
        throw err;
      }
    } else {
      installed = await installPathFromStaging({
        source: { root: stagingRoot, path: stagingRel },
        destination: destination!,
        exact: row.exact,
        options,
      });
    }
    if (installed) {
      void touchProjectLastEdited(row.dest_project_id, "pending-copy");
    }
  } finally {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function reportCopyStatus(
  row: ProjectCopyRow,
  status: "done" | "failed" | "queued",
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

  pruneNotReady();
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
      notReady.delete(row.copy_id);
      await reportCopyStatus(row, "done");
    } catch (err) {
      // a PartlyPlacedCopy is neither: it fails (N1)
      const deferrable =
        err instanceof DeferredCopy || isRetryableAgentError(err);
      const stopped = err instanceof DeferredCopy && err.reason === "stopped";
      if (!deferrable || stopped) {
        notReady.delete(row.copy_id);
      } else if (notReadyTooLong(row.copy_id)) {
        const streak = notReady.get(row.copy_id)!;
        notReady.delete(row.copy_id);
        logger.warn("pending copy not ready for too long", {
          dest_project_id: row.dest_project_id,
          passes: streak.passes,
        });
        await reportCopyStatus(
          row,
          "failed",
          `the destination project was running but not ready for over ${Math.round(
            (Date.now() - streak.since) / 60000,
          )} minutes (${streak.passes} tries): ${err}`,
        );
        continue;
      }
      if (deferrable) {
        // nothing of it was placed: queued again, never "done" or "failed"
        logger.debug("pending copy deferred", {
          dest_project_id: row.dest_project_id,
          err: `${err}`,
        });
        await reportCopyStatus(row, "queued", `${err}`);
        continue;
      }
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
