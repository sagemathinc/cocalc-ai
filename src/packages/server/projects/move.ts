import { randomUUID } from "node:crypto";
import { posix as pathPosix } from "node:path";
import getPool from "@cocalc/database/pool";
import getLogger from "@cocalc/backend/logger";
import { conat } from "@cocalc/backend/conat";
import type { LroEvent, LroSummary } from "@cocalc/conat/hub/api/lro";
import {
  PROJECT_LOG_STREAM_NAME,
  type ProjectLogRow,
} from "@cocalc/conat/hub/api/projects";
import {
  DEFAULT_R2_REGION,
  mapCloudRegionToR2Region,
  parseR2Region,
} from "@cocalc/util/consts";
import {
  loadHostFromRegistry,
  selectActiveHost,
  deleteProjectDataOnHost,
  savePlacement,
  stopProjectOnHost,
} from "../project-host/control";
import { getConfiguredBayId } from "../bay-config";
import { start as startProjectLro } from "../conat/api/projects";
import { createBackup as createBackupLro } from "../conat/api/project-backups";
import type { ManagedBackupEgressOverride } from "@cocalc/conat/files/file-server";
import { resolveHostConnection } from "../conat/api/hosts";
import { getExplicitProjectRoutedClient } from "@cocalc/server/conat/route-client";
import {
  get as getLroStream,
  waitForCompletion as waitForLroCompletion,
} from "@cocalc/conat/lro/client";
import {
  getProjectBackupAssignmentState,
  resolveProjectBackupRepoAssignment,
  setProjectBackupRegion,
} from "../project-backup";
import {
  makeOfflineMoveConfirmationPayload,
  offlineMoveConfirmationError,
} from "./offline-move-confirmation";
import { assertPortableProjectRootfs } from "./rootfs-state";
import {
  purgeProjectBackupsForRepo,
  type ProjectBackupPurgeResult,
} from "./backup-purge";
import { getLro } from "@cocalc/server/lro/lro-db";

const log = getLogger("server:projects:move");
const BACKUP_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const MOVE_STOP_PROJECT_TIMEOUT_MS = 3 * 60 * 1000;
// Destination start can include backup restore, rootfs preparation, and
// cross-region downloads, so it needs a much longer budget than a simple
// steady-state process start.
const MOVE_START_DEST_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.COCALC_MOVE_START_DEST_TIMEOUT_MS) || 2 * 60 * 60 * 1000,
);
const TRANSIENT_MOVE_RPC_RETRY_DELAY_MS = 1000;
const MOVE_SENTINEL_PATH = ".move-sentinel.json";
const MOVE_SENTINEL_VERIFY_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.COCALC_MOVE_SENTINEL_VERIFY_TIMEOUT_MS) || 30 * 1000,
);
const MOVE_SENTINEL_VERIFY_RETRY_MS = Math.max(
  1,
  Number(process.env.COCALC_MOVE_SENTINEL_VERIFY_RETRY_MS) || 1000,
);
const MOVE_SENTINEL_IO_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.COCALC_MOVE_SENTINEL_IO_TIMEOUT_MS) || 5000,
);
const MOVE_PROJECT_FS_READY_TIMEOUT_MS = Math.max(
  1,
  Number(process.env.COCALC_MOVE_PROJECT_FS_READY_TIMEOUT_MS) || 30 * 1000,
);
const MOVE_PROJECT_FS_READY_RETRY_MS = Math.max(
  1,
  Number(process.env.COCALC_MOVE_PROJECT_FS_READY_RETRY_MS) || 1000,
);
const CHILD_LRO_POLL_INTERVAL_MS = Math.max(
  250,
  Number(process.env.COCALC_MOVE_CHILD_LRO_POLL_INTERVAL_MS) || 1000,
);
const TERMINAL_LRO_STATUSES = new Set([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);

export const MOVE_CANCELED_CODE = "move-canceled";

class MoveCanceledError extends Error {
  code = MOVE_CANCELED_CODE;
  stage: string;

  constructor(stage: string) {
    super(`move canceled (${stage})`);
    this.name = "MoveCanceledError";
    this.stage = stage;
  }
}

export type MoveProjectToHostInput = {
  project_id: string;
  dest_host_id?: string;
  account_id: string;
  allow_offline?: boolean;
  start_dest?: boolean;
  stop_dest_after_start?: boolean;
  backup_region_cutover?: boolean;
  managed_egress_override?: ManagedBackupEgressOverride;
};

type MoveProjectContext = {
  project_id: string;
  dest_host_id: string;
  dest_host_name?: string | null;
  account_id: string;
  project_owning_bay_id: string;
  project_region: string;
  dest_region: string;
  project_host_id?: string | null;
  project_host_name?: string | null;
  project_state?: string | null;
  provisioned?: boolean | null;
  source_host_status?: string | null;
  source_host_deleted?: boolean;
  source_host_last_seen?: Date | null;
  last_backup?: Date | null;
  last_edited?: Date | null;
  backup_region_cutover?: boolean;
};

export type MoveProjectProgressUpdate = {
  step: string;
  message?: string;
  detail?: Record<string, any>;
  progress?: number;
};

type MoveChildProgressKind = "project-backup" | "project-start";

type MoveChildProgressDetail = {
  kind: MoveChildProgressKind;
  op_id: string;
  phase?: string;
  message?: string;
  progress?: number;
  detail?: any;
};

type MoveProjectLogEvent =
  | "project_move_requested"
  | "project_moved"
  | "project_move_failed"
  | "project_move_canceled";

type MoveBackupRegionCutoverResult = {
  performed: boolean;
  previous_backup_repo_id: string | null;
  next_backup_repo_id: string | null;
  purge: ProjectBackupPurgeResult;
  purge_error?: string;
};

type MoveSentinel = {
  path: string;
  content: string;
};

function summarizeMoveSentinelContent(content: string): Record<string, string> {
  try {
    const parsed = JSON.parse(content);
    return {
      move_log_id: `${parsed?.move_log_id ?? ""}`,
      op_id: `${parsed?.op_id ?? ""}`,
      source_host_id: `${parsed?.source_host_id ?? ""}`,
      dest_host_id: `${parsed?.dest_host_id ?? ""}`,
      token: `${parsed?.token ?? ""}`,
      written_at: `${parsed?.written_at ?? ""}`,
    };
  } catch {
    return {
      preview: `${content}`.slice(0, 200),
    };
  }
}

async function openProjectLogStream(
  project_id: string,
  opts?: { fresh?: boolean },
) {
  const client = await getExplicitProjectRoutedClient({
    project_id,
    fresh: opts?.fresh,
  });
  return await client.sync.dstream<ProjectLogRow>({
    project_id,
    name: PROJECT_LOG_STREAM_NAME,
    noAutosave: true,
    noCache: true,
    noInventory: true,
  });
}

async function openProjectFs(project_id: string, opts?: { fresh?: boolean }) {
  const client = await getExplicitProjectRoutedClient({
    project_id,
    fresh: opts?.fresh,
  });
  return client.fs({ project_id });
}

function isProjectFsNotInitializedError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return text.includes("file server not initialized");
}

function isRetryableProjectFsReadyError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    isProjectFsNotInitializedError(err) ||
    isRetryableTransientMoveError(err) ||
    text.includes("timed out after")
  );
}

async function waitForProjectFsReady(
  project_id: string,
  opts?: { fresh?: boolean; timeout_ms?: number },
) {
  const timeout_ms = Math.max(
    1,
    opts?.timeout_ms ?? MOVE_PROJECT_FS_READY_TIMEOUT_MS,
  );
  const deadline = Date.now() + timeout_ms;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    try {
      const fs = await openProjectFs(project_id, { fresh: opts?.fresh });
      await withTimeout({
        promise: fs.exists("."),
        timeout_ms: Math.min(MOVE_SENTINEL_IO_TIMEOUT_MS, remaining),
        label: `probing project fs readiness for ${project_id}`,
      });
      return fs;
    } catch (err) {
      lastError = err;
      if (!isRetryableProjectFsReadyError(err)) {
        throw err;
      }
    }
    await delay(Math.min(MOVE_PROJECT_FS_READY_RETRY_MS, remaining));
  }
  throw new Error(
    `project fs did not become ready for move after ${timeout_ms}ms: ${lastError ?? "unknown error"}`,
  );
}

async function createMoveSentinel({
  context,
  move_log_id,
  op_id,
}: {
  context: MoveProjectContext;
  move_log_id: string;
  op_id?: string;
}): Promise<MoveSentinel> {
  const fs = await waitForProjectFsReady(context.project_id, { fresh: true });
  const parentDir = pathPosix.dirname(MOVE_SENTINEL_PATH);
  if (parentDir && parentDir !== ".") {
    await fs.mkdir(parentDir, { recursive: true });
  }
  const content = `${JSON.stringify(
    {
      version: 1,
      move_log_id,
      op_id: op_id ?? null,
      project_id: context.project_id,
      source_host_id: context.project_host_id ?? null,
      dest_host_id: context.dest_host_id,
      source_region: context.project_region,
      dest_region: context.dest_region,
      token: randomUUID(),
      written_at: new Date().toISOString(),
    },
    null,
    2,
  )}\n`;
  await fs.writeFile(MOVE_SENTINEL_PATH, content);
  return { path: MOVE_SENTINEL_PATH, content };
}

async function withTimeout<T>({
  promise,
  timeout_ms,
  label,
}: {
  promise: Promise<T>;
  timeout_ms: number;
  label: string;
}): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  return await new Promise<T>((resolve, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeout_ms}ms`));
    }, timeout_ms);
    timeoutId.unref?.();
    promise.then(resolve, reject).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
  });
}

async function verifyMoveSentinel({
  project_id,
  sentinel,
}: {
  project_id: string;
  sentinel: MoveSentinel;
}): Promise<void> {
  const deadline = Date.now() + MOVE_SENTINEL_VERIFY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const fs = await withTimeout({
        promise: waitForProjectFsReady(project_id, {
          fresh: true,
          timeout_ms: Math.min(
            MOVE_PROJECT_FS_READY_TIMEOUT_MS,
            Math.max(1, deadline - Date.now()),
          ),
        }),
        timeout_ms: Math.min(
          MOVE_PROJECT_FS_READY_TIMEOUT_MS,
          Math.max(1, deadline - Date.now()),
        ),
        label: "opening destination project fs for move sentinel verification",
      });
      const actual = `${await withTimeout({
        promise: fs.readFile(sentinel.path, "utf8"),
        timeout_ms: MOVE_SENTINEL_IO_TIMEOUT_MS,
        label: `reading move sentinel at ${sentinel.path}`,
      })}`;
      if (actual === sentinel.content) {
        return;
      }
      const expectedSummary = summarizeMoveSentinelContent(sentinel.content);
      const actualSummary = summarizeMoveSentinelContent(actual);
      log.warn("moveProjectToHost sentinel mismatch", {
        project_id,
        path: sentinel.path,
        expected: expectedSummary,
        actual: actualSummary,
      });
      lastError = new Error(
        `sentinel content mismatch at ${sentinel.path} on destination (expected move_log_id=${expectedSummary.move_log_id || "unknown"} actual move_log_id=${actualSummary.move_log_id || "unknown"})`,
      );
    } catch (err) {
      lastError = err;
    }
    await delay(MOVE_SENTINEL_VERIFY_RETRY_MS);
  }
  throw new Error(
    `destination verification failed: ${lastError ?? `missing move sentinel at ${sentinel.path}`}`,
  );
}

async function deleteMoveSentinelBestEffort({
  project_id,
  stage,
}: {
  project_id: string;
  stage: string;
}): Promise<void> {
  try {
    const fs = await waitForProjectFsReady(project_id, {
      fresh: true,
      timeout_ms: MOVE_SENTINEL_IO_TIMEOUT_MS,
    });
    await fs.rm(MOVE_SENTINEL_PATH, { force: true });
  } catch (err) {
    log.warn("moveProjectToHost sentinel cleanup failed", {
      project_id,
      stage,
      err,
    });
  }
}

async function appendProjectMoveLogEntry({
  project_id,
  account_id,
  move_log_id,
  event,
  source_host_id,
  source_host_name,
  dest_host_id,
  dest_host_name,
  duration_ms,
  error,
  op_id,
  stage,
  extra_event,
  fresh,
}: {
  project_id: string;
  account_id: string;
  move_log_id: string;
  event: MoveProjectLogEvent;
  source_host_id?: string | null;
  source_host_name?: string | null;
  dest_host_id?: string | null;
  dest_host_name?: string | null;
  duration_ms?: number;
  error?: string;
  op_id?: string;
  stage?: string;
  extra_event?: Record<string, any>;
  fresh?: boolean;
}): Promise<boolean> {
  const row: ProjectLogRow = {
    id: `project-move:${move_log_id}:${event}`,
    project_id,
    account_id,
    time: new Date(),
    event: {
      event,
      ...(op_id ? { op_id } : {}),
      ...(source_host_id ? { source_host_id } : {}),
      ...(source_host_name ? { source_host_name } : {}),
      ...(dest_host_id ? { dest_host_id } : {}),
      ...(dest_host_name ? { dest_host_name } : {}),
      ...(duration_ms != null ? { duration_ms } : {}),
      ...(error ? { error } : {}),
      ...(stage ? { stage } : {}),
      ...(extra_event ?? {}),
    },
  };
  try {
    const stream = await openProjectLogStream(project_id, { fresh });
    try {
      const existing = new Set(
        ((stream.getAll?.() as ProjectLogRow[] | undefined) ?? []).map(
          ({ id }) => id,
        ),
      );
      if (existing.has(row.id)) {
        return false;
      }
      stream.publish(row);
      await stream.save();
      return true;
    } finally {
      stream.close();
    }
  } catch (err) {
    log.warn("moveProjectToHost failed to write project-log entry", {
      project_id,
      event,
      source_host_id,
      dest_host_id,
      err,
    });
    return false;
  }
}

async function revertPlacementIfPossible(
  context: MoveProjectContext,
  progress: (update: MoveProjectProgressUpdate) => void,
) {
  if (
    !context.project_host_id ||
    context.project_host_id === context.dest_host_id
  ) {
    return;
  }
  progress({
    step: "revert-placement",
    message: "restoring source placement",
    detail: { source_host_id: context.project_host_id },
  });
  await savePlacement(context.project_id, {
    host_id: context.project_host_id,
  });
  progress({
    step: "revert-placement",
    message: "source placement restored",
    detail: { source_host_id: context.project_host_id },
  });
}

async function cleanupDestinationOnFailure(
  context: MoveProjectContext,
  progress: (update: MoveProjectProgressUpdate) => void,
) {
  if (
    !context.dest_host_id ||
    context.dest_host_id === context.project_host_id
  ) {
    return;
  }
  progress({
    step: "cleanup-dest",
    message: "removing destination data after failed move",
    detail: { dest_host_id: context.dest_host_id },
  });
  await deleteProjectDataOnHost({
    project_id: context.project_id,
    host_id: context.dest_host_id,
  });
  progress({
    step: "cleanup-dest",
    message: "destination data removed",
    detail: { dest_host_id: context.dest_host_id },
  });
}

async function buildMoveProjectContext(
  input: MoveProjectToHostInput,
): Promise<MoveProjectContext> {
  const { project_id, account_id } = input;
  const pool = getPool();
  const projectResult = await pool.query<{
    project_id: string;
    host_id: string | null;
    region: string | null;
    project_state: string | null;
    provisioned: boolean | null;
    last_backup: Date | null;
    last_edited: Date | null;
    project_owning_bay_id: string;
    host_bay_id: string;
  }>(
    `
      SELECT
        projects.project_id,
        projects.host_id,
        projects.region,
        projects.state->>'state' AS project_state,
        projects.provisioned,
        projects.last_backup,
        projects.last_edited,
        COALESCE(projects.owning_bay_id, $2) AS project_owning_bay_id,
        COALESCE(project_hosts.bay_id, $2) AS host_bay_id
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE projects.project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const projectRow = projectResult.rows[0];
  if (!projectRow) {
    throw new Error(`project ${project_id} not found`);
  }
  const source_host_id =
    typeof projectRow.host_id === "string" && projectRow.host_id.trim()
      ? projectRow.host_id
      : null;
  let contextSourceHostName: string | null = null;
  let source_host_status: string | null = null;
  let source_host_deleted = false;
  let source_host_last_seen: Date | null = null;
  if (source_host_id) {
    const hostResult = await pool.query<{
      status: string | null;
      deleted: Date | null;
      last_seen: Date | null;
      name: string | null;
    }>(
      "SELECT status, deleted, last_seen, name FROM project_hosts WHERE id=$1",
      [source_host_id],
    );
    const hostRow = hostResult.rows[0];
    let source_host_name: string | null = null;
    if (hostRow) {
      source_host_status = hostRow.status ?? null;
      source_host_deleted = !!hostRow.deleted;
      source_host_last_seen = hostRow.last_seen ?? null;
      source_host_name = hostRow.name ?? null;
    }
    contextSourceHostName = source_host_name;
  }
  let dest_host_id = input.dest_host_id;
  const destHost =
    dest_host_id != null
      ? await resolveHostConnection({
          account_id,
          host_id: dest_host_id,
        })
      : await selectActiveHost({
          exclude_host_id: source_host_id ?? undefined,
          bay_id: projectRow.project_owning_bay_id,
        });
  if (!destHost) {
    throw new Error(
      dest_host_id
        ? `host ${dest_host_id} not found`
        : "no running project-host available",
    );
  }
  if (
    input.dest_host_id &&
    (destHost as { can_place?: boolean }).can_place !== true
  ) {
    throw new Error("not allowed to place a project on that host");
  }
  if (!dest_host_id) {
    dest_host_id = (destHost as { id?: string }).id;
  }
  if (!dest_host_id) {
    throw new Error("destination host id not available");
  }
  const destHostRegistryRow =
    !destHost?.name && dest_host_id
      ? await loadHostFromRegistry(dest_host_id)
      : undefined;
  const dest_host_name =
    destHost?.name ?? destHostRegistryRow?.name ?? dest_host_id;
  const project_region = parseR2Region(projectRow.region) ?? DEFAULT_R2_REGION;
  const dest_region = mapCloudRegionToR2Region(destHost.region);
  if (!input.backup_region_cutover && project_region !== dest_region) {
    throw new Error(
      `project region ${project_region} does not match host region ${dest_region}`,
    );
  }
  return {
    project_id,
    dest_host_id,
    dest_host_name,
    account_id,
    project_owning_bay_id: projectRow.project_owning_bay_id,
    project_region,
    dest_region,
    project_host_id: source_host_id,
    project_host_name: contextSourceHostName,
    project_state: projectRow.project_state,
    provisioned: projectRow.provisioned,
    source_host_status,
    source_host_deleted,
    source_host_last_seen,
    last_backup: projectRow.last_backup,
    last_edited: projectRow.last_edited,
    backup_region_cutover: !!input.backup_region_cutover,
  };
}

const HOST_SEEN_TTL_MS = 2 * 60 * 1000;
function isSourceHostAvailable(context: MoveProjectContext): boolean {
  if (!context.project_host_id) return false;
  if (context.source_host_deleted) return false;
  const status = String(context.source_host_status ?? "");
  if (!["running", "starting", "restarting", "error"].includes(status)) {
    return false;
  }
  const lastSeenMs = context.source_host_last_seen?.getTime?.() ?? 0;
  if (!lastSeenMs) {
    return false;
  }
  return Date.now() - lastSeenMs <= HOST_SEEN_TTL_MS;
}

function hasStaleBackup(context: MoveProjectContext): boolean {
  const lastEdited = context.last_edited?.getTime?.() ?? 0;
  if (!lastEdited) return false;
  const lastBackup = context.last_backup?.getTime?.() ?? 0;
  return !lastBackup || lastEdited > lastBackup;
}

function isMissingProjectVolumeError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return text.includes("project volume does not exist");
}

function isRetryableTransientMoveError(err: unknown): boolean {
  const text = `${(err as any)?.message ?? err ?? ""}`.toLowerCase();
  return (
    text.includes("unexpected end of json input") ||
    text.includes("unexpected end of data") ||
    text.includes("missing raw payload") ||
    text.includes("disconnected") ||
    (err as any)?.code === 408
  );
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function retryOnceOnTransientMoveError<T>({
  operation,
  progress_step,
  detail,
  progress,
  run,
}: {
  operation: "stop-source" | "backup" | "start-dest";
  progress_step?: MoveProjectProgressUpdate["step"];
  detail?: Record<string, any>;
  progress: (update: MoveProjectProgressUpdate) => void;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (!isRetryableTransientMoveError(err)) {
      throw err;
    }
    log.warn("moveProjectToHost transient operation failure; retrying once", {
      operation,
      err,
      detail,
    });
    progress({
      step: progress_step ?? operation,
      message: "transient error; retrying once",
      detail: {
        ...(detail ?? {}),
        error: `${err}`,
      },
    });
    await delay(TRANSIENT_MOVE_RPC_RETRY_DELAY_MS);
    return await run();
  }
}

async function invalidateProjectBackupConfigOnHost(
  host_id: string | null | undefined,
): Promise<void> {
  const target = `${host_id ?? ""}`.trim();
  if (!target) return;
  await conat().publish(`project-host.${target}.backup.invalidate`, null, {
    waitForInterest: true,
    timeout: 10_000,
  });
}

function mergeMoveProgressDetail({
  baseDetail,
  child,
}: {
  baseDetail?: Record<string, any>;
  child?: MoveChildProgressDetail;
}): Record<string, any> | undefined {
  const detail: Record<string, any> = baseDetail ? { ...baseDetail } : {};
  if (child) {
    detail.child = {
      kind: child.kind,
      op_id: child.op_id,
      ...(child.phase != null ? { phase: child.phase } : {}),
      ...(child.message != null ? { message: child.message } : {}),
      ...(child.progress != null ? { progress: child.progress } : {}),
      ...(child.detail !== undefined ? { detail: child.detail } : {}),
    };
  }
  return Object.keys(detail).length ? detail : undefined;
}

async function waitForChildLroCompletion({
  op_id,
  scope_type,
  scope_id,
  timeout_ms,
  onProgress,
  onSummary,
}: {
  op_id: string;
  scope_type: "project" | "account" | "host" | "hub";
  scope_id?: string;
  timeout_ms?: number;
  onProgress?: (event: Extract<LroEvent, { type: "progress" }>) => void;
  onSummary?: (summary: LroSummary) => void;
}): Promise<LroSummary> {
  let stream: Awaited<ReturnType<typeof getLroStream>> | undefined;
  try {
    stream = await getLroStream({
      op_id,
      scope_type,
      scope_id,
      client: conat(),
    });
  } catch (err) {
    log.warn("move child lro stream init failed; using db polling", {
      op_id,
      scope_type,
      scope_id,
      err,
    });
  }

  let done = false;
  let lastIndex = 0;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let pollId: ReturnType<typeof setInterval> | undefined;

  return await new Promise<LroSummary>((resolve, reject) => {
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (pollId) {
        clearInterval(pollId);
      }
      if (stream) {
        stream.removeListener("change", handleChange);
        stream.removeListener("closed", handleClosed);
        stream.close();
      }
    };

    const finish = (summary: LroSummary) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(summary);
    };

    const fail = (err: Error) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    };

    const handleEvents = (events: LroEvent[]) => {
      if (events.length < lastIndex) {
        lastIndex = 0;
      }
      for (let i = lastIndex; i < events.length; i += 1) {
        const event = events[i];
        if (event.type === "progress") {
          onProgress?.(event);
        }
        if (event.type === "summary") {
          onSummary?.(event.summary);
          if (TERMINAL_LRO_STATUSES.has(event.summary.status)) {
            finish(event.summary);
            return;
          }
        }
      }
      lastIndex = events.length;
    };

    const handleChange = () => {
      if (done || !stream) return;
      try {
        handleEvents(stream.getAll());
      } catch (err) {
        log.warn(
          "move child lro stream read failed; continuing with db polling",
          {
            op_id,
            err,
          },
        );
      }
    };

    const pollSummary = async () => {
      if (done) return;
      try {
        const summary = await getLro(op_id);
        if (!summary) return;
        onSummary?.(summary);
        if (TERMINAL_LRO_STATUSES.has(summary.status)) {
          finish(summary);
        }
      } catch (err) {
        log.warn("move child lro poll failed", {
          op_id,
          err,
        });
      }
    };

    const handleClosed = () => {
      void pollSummary();
    };

    if (stream) {
      stream.on("change", handleChange);
      stream.on("closed", handleClosed);
      handleChange();
    }

    pollId = setInterval(() => {
      void pollSummary();
    }, CHILD_LRO_POLL_INTERVAL_MS);
    pollId.unref?.();
    void pollSummary();

    if (timeout_ms && timeout_ms > 0) {
      timeoutId = setTimeout(() => {
        fail(new Error("timeout waiting for lro completion"));
      }, timeout_ms);
      timeoutId.unref?.();
    }
  });
}

async function performBackupRegionCutover({
  context,
  progress,
  managed_egress_override,
}: {
  context: MoveProjectContext;
  progress: (update: MoveProjectProgressUpdate) => void;
  managed_egress_override?: ManagedBackupEgressOverride;
}): Promise<MoveBackupRegionCutoverResult> {
  if (
    !context.backup_region_cutover ||
    context.project_region === context.dest_region
  ) {
    return {
      performed: false,
      previous_backup_repo_id: null,
      next_backup_repo_id: null,
      purge: {
        skipped: true,
        deleted_snapshots: 0,
        deleted_index_snapshots: 0,
        reason: "backup-region cutover not requested",
      },
    };
  }

  const state = await getProjectBackupAssignmentState(context.project_id);
  const previous_backup_repo_id = state.backup_repo_id ?? null;
  const target = await resolveProjectBackupRepoAssignment({
    project_id: context.project_id,
    project_region: context.dest_region,
  });
  const next_backup_repo_id = target.backup_repo_id ?? null;
  if (!next_backup_repo_id) {
    throw new Error(
      `unable to provision destination backup repo for region ${context.dest_region}`,
    );
  }

  if (previous_backup_repo_id) {
    try {
      await invalidateProjectBackupConfigOnHost(context.dest_host_id);
    } catch (err) {
      log.warn("backup-region cutover invalidation publish failed", {
        project_id: context.project_id,
        dest_host_id: context.dest_host_id,
        err,
      });
      await resolveProjectBackupRepoAssignment({
        project_id: context.project_id,
        project_region: context.project_region,
        backup_repo_id: previous_backup_repo_id,
      });
      throw err;
    }
  }

  try {
    progress({
      step: "cutover-backup",
      message: "creating first backup in destination region",
      detail: {
        source_region: context.project_region,
        dest_region: context.dest_region,
        previous_backup_repo_id,
        next_backup_repo_id,
      },
    });
    const result = await retryOnceOnTransientMoveError({
      operation: "backup",
      progress_step: "cutover-backup",
      detail: {
        project_id: context.project_id,
        source_region: context.project_region,
        dest_region: context.dest_region,
        previous_backup_repo_id,
        next_backup_repo_id,
      },
      progress,
      run: async () =>
        await createFinalBackup({
          account_id: context.account_id,
          project_id: context.project_id,
          progress: (update) =>
            progress({
              ...update,
              step: "cutover-backup",
            }),
          managed_egress_override,
        }),
    });
    progress({
      step: "cutover-backup",
      message: "destination-region backup created",
      detail: {
        source_region: context.project_region,
        dest_region: context.dest_region,
        previous_backup_repo_id,
        next_backup_repo_id,
        backup_id: result.id,
        backup_time: result.time,
      },
    });
    await setProjectBackupRegion({
      project_id: context.project_id,
      region: context.dest_region,
    });
  } catch (err) {
    await resolveProjectBackupRepoAssignment({
      project_id: context.project_id,
      project_region: context.project_region,
      backup_repo_id: previous_backup_repo_id,
    });
    if (previous_backup_repo_id) {
      try {
        await invalidateProjectBackupConfigOnHost(context.dest_host_id);
      } catch (invalidateErr) {
        log.warn("backup-region cutover rollback invalidation publish failed", {
          project_id: context.project_id,
          dest_host_id: context.dest_host_id,
          err: invalidateErr,
        });
      }
    }
    throw err;
  }

  let purge: ProjectBackupPurgeResult = {
    skipped: true,
    deleted_snapshots: 0,
    deleted_index_snapshots: 0,
    reason: "no old backup repo purge needed",
  };
  let purge_error: string | undefined;
  if (
    previous_backup_repo_id &&
    previous_backup_repo_id !== next_backup_repo_id
  ) {
    progress({
      step: "purge-old-backups",
      message: "scheduling old-region backup purge",
      detail: {
        source_region: context.project_region,
        dest_region: context.dest_region,
        previous_backup_repo_id,
        next_backup_repo_id,
      },
    });
    purge = {
      skipped: true,
      deleted_snapshots: 0,
      deleted_index_snapshots: 0,
      reason: "scheduled asynchronously",
    };
    void (async () => {
      try {
        const purged = await purgeProjectBackupsForRepo({
          project_id: context.project_id,
          backup_repo_id: previous_backup_repo_id,
          region: context.project_region,
        });
        log.info("backup-region cutover old-repo purge completed", {
          project_id: context.project_id,
          previous_backup_repo_id,
          next_backup_repo_id,
          deleted_snapshots: purged.deleted_snapshots,
          deleted_index_snapshots: purged.deleted_index_snapshots,
          skipped: purged.skipped,
          reason: purged.reason,
        });
      } catch (err) {
        log.warn("backup-region cutover old-repo purge failed", {
          project_id: context.project_id,
          previous_backup_repo_id,
          next_backup_repo_id,
          err,
        });
      }
    })();
  }

  return {
    performed: true,
    previous_backup_repo_id,
    next_backup_repo_id,
    purge,
    ...(purge_error ? { purge_error } : {}),
  };
}

async function createFinalBackup({
  project_id,
  account_id,
  progress,
  managed_egress_override,
}: {
  project_id: string;
  account_id: string;
  progress: (update: MoveProjectProgressUpdate) => void;
  managed_egress_override?: ManagedBackupEgressOverride;
}): Promise<{ id: string; time: string; op_id: string }> {
  const backupOp = await createBackupLro(
    {
      account_id,
      project_id,
    },
    {
      skip_collab_check: true,
      skip_rootfs_portability_check: true,
      managed_egress_override,
    },
  );
  progress({
    step: "backup",
    message: "creating final backup",
    detail: mergeMoveProgressDetail({
      child: {
        kind: "project-backup",
        op_id: backupOp.op_id,
      },
    }),
  });
  const summary = await waitForChildLroCompletion({
    op_id: backupOp.op_id,
    scope_type: backupOp.scope_type,
    scope_id: backupOp.scope_id,
    timeout_ms: BACKUP_TIMEOUT_MS,
    onProgress: (event) => {
      progress({
        step: "backup",
        message: event.message ?? event.phase ?? "creating final backup",
        detail: mergeMoveProgressDetail({
          child: {
            kind: "project-backup",
            op_id: backupOp.op_id,
            phase: event.phase,
            message: event.message,
            progress: event.progress,
            detail: event.detail,
          },
        }),
        progress: event.progress,
      });
    },
  });
  if (summary.status !== "succeeded") {
    throw new Error(summary.error ?? `backup failed: ${summary.status}`);
  }
  const backup = summary.result ?? {};
  const backupTime =
    backup.time instanceof Date
      ? backup.time.toISOString()
      : new Date(backup.time as any).toISOString();
  return { id: backup.id, time: backupTime, op_id: backupOp.op_id };
}

async function loadProjectPlacementState(project_id: string): Promise<{
  host_id?: string | null;
  project_state?: string | null;
}> {
  const { rows } = await getPool().query<{
    host_id: string | null;
    project_state: string | null;
  }>(
    "SELECT host_id, state->>'state' AS project_state FROM projects WHERE project_id=$1",
    [project_id],
  );
  return rows[0] ?? {};
}

export async function moveProjectToHost(
  input: MoveProjectToHostInput,
  opts?: {
    progress?: (update: MoveProjectProgressUpdate) => void;
    shouldCancel?: () => Promise<boolean>;
    op_id?: string;
  },
): Promise<void> {
  const progress = opts?.progress ?? (() => {});
  const shouldCancel = opts?.shouldCancel;
  const move_log_id = opts?.op_id ?? randomUUID();
  const startDest = input.start_dest !== false;
  const stopDestAfterStart = !!input.stop_dest_after_start;
  const started_at_ms = Date.now();
  const context = await buildMoveProjectContext(input);
  if (context.backup_region_cutover && !startDest) {
    throw new Error(
      "backup-region cutover requires starting the destination project",
    );
  }
  await assertPortableProjectRootfs({
    project_id: context.project_id,
    operation: "move",
  });
  log.debug("moveProjectToHost context", {
    project_id: context.project_id,
    dest_host_id: context.dest_host_id,
    project_region: context.project_region,
    dest_region: context.dest_region,
    project_host_id: context.project_host_id,
    project_state: context.project_state,
    provisioned: context.provisioned,
    source_host_status: context.source_host_status,
    source_host_last_seen: context.source_host_last_seen,
    last_backup: context.last_backup,
    last_edited: context.last_edited,
    backup_region_cutover: context.backup_region_cutover,
  });

  let placementUpdated = false;
  let backupRegionCutoverResult: MoveBackupRegionCutoverResult | undefined;
  let moveSentinel: MoveSentinel | undefined;
  let finalBackupId: string | undefined;
  const moveLogExtraEvent = () => ({
    source_region: context.project_region,
    dest_region: context.dest_region,
    backup_region_cutover:
      !!context.backup_region_cutover &&
      context.project_region !== context.dest_region,
    ...(backupRegionCutoverResult?.performed
      ? {
          previous_backup_repo_id:
            backupRegionCutoverResult.previous_backup_repo_id,
          next_backup_repo_id: backupRegionCutoverResult.next_backup_repo_id,
          old_backup_purge: {
            skipped: backupRegionCutoverResult.purge.skipped,
            deleted_snapshots:
              backupRegionCutoverResult.purge.deleted_snapshots,
            deleted_index_snapshots:
              backupRegionCutoverResult.purge.deleted_index_snapshots,
            ...(backupRegionCutoverResult.purge.reason
              ? { reason: backupRegionCutoverResult.purge.reason }
              : {}),
            ...(backupRegionCutoverResult.purge_error
              ? { error: backupRegionCutoverResult.purge_error }
              : {}),
          },
        }
      : {}),
  });
  const checkCanceled = async (stage: string) => {
    if (!shouldCancel) {
      return;
    }
    if (await shouldCancel()) {
      throw new MoveCanceledError(stage);
    }
  };

  const handleCancel = async (stage: string) => {
    log.info("moveProjectToHost canceled", {
      project_id: context.project_id,
      dest_host_id: context.dest_host_id,
      stage,
    });
    if (placementUpdated) {
      try {
        await revertPlacementIfPossible(context, progress);
      } catch (err) {
        log.warn("moveProjectToHost cancel placement revert failed", {
          project_id: context.project_id,
          source_host_id: context.project_host_id,
          err,
        });
        progress({
          step: "revert-placement",
          message: "source placement revert failed",
          detail: { source_host_id: context.project_host_id, error: `${err}` },
        });
      }
      try {
        await cleanupDestinationOnFailure(context, progress);
      } catch (cleanupErr) {
        log.warn("moveProjectToHost cancel destination cleanup failed", {
          project_id: context.project_id,
          dest_host_id: context.dest_host_id,
          err: cleanupErr,
        });
        progress({
          step: "cleanup-dest",
          message: "destination cleanup failed",
          detail: {
            dest_host_id: context.dest_host_id,
            error: `${cleanupErr}`,
          },
        });
      }
    }
    progress({
      step: "done",
      message: "canceled",
      detail: { stage },
    });
    await appendProjectMoveLogEntry({
      project_id: context.project_id,
      account_id: context.account_id,
      move_log_id,
      event: "project_move_requested",
      source_host_id: context.project_host_id,
      source_host_name: context.project_host_name,
      dest_host_id: context.dest_host_id,
      dest_host_name: context.dest_host_name,
      op_id: opts?.op_id,
      extra_event: moveLogExtraEvent(),
      fresh: true,
    });
    await appendProjectMoveLogEntry({
      project_id: context.project_id,
      account_id: context.account_id,
      move_log_id,
      event: "project_move_canceled",
      source_host_id: context.project_host_id,
      source_host_name: context.project_host_name,
      dest_host_id: context.dest_host_id,
      dest_host_name: context.dest_host_name,
      duration_ms: Date.now() - started_at_ms,
      op_id: opts?.op_id,
      stage,
      extra_event: moveLogExtraEvent(),
      fresh: true,
    });
  };

  try {
    progress({
      step: "validate",
      message: "validated move request",
      detail: {
        source_host_id: context.project_host_id ?? undefined,
        dest_host_id: context.dest_host_id,
      },
    });
    await checkCanceled("validate");
    const sourceAvailable = isSourceHostAvailable(context);
    if (sourceAvailable) {
      await appendProjectMoveLogEntry({
        project_id: context.project_id,
        account_id: context.account_id,
        move_log_id,
        event: "project_move_requested",
        source_host_id: context.project_host_id,
        source_host_name: context.project_host_name,
        dest_host_id: context.dest_host_id,
        dest_host_name: context.dest_host_name,
        op_id: opts?.op_id,
        extra_event: moveLogExtraEvent(),
      });
    }
    if (!sourceAvailable) {
      const status = context.source_host_status ?? "unknown";
      progress({
        step: "stop-source",
        message: "source host offline; skipping stop",
        detail: { source_host_status: status },
      });
      if (context.provisioned === false) {
        progress({
          step: "backup",
          message: "source project not provisioned; backup not required",
          detail: {
            source_host_status: status,
            provisioned: context.provisioned,
            last_backup: context.last_backup,
            last_edited: context.last_edited,
          },
        });
      } else if (hasStaleBackup(context) && !input.allow_offline) {
        throw offlineMoveConfirmationError(
          makeOfflineMoveConfirmationPayload({
            source_status: status,
            last_backup: context.last_backup,
            last_edited: context.last_edited,
          }),
        );
      }
      progress({
        step: "backup",
        message: "source host offline; using existing backup",
        detail: {
          source_host_status: status,
          last_backup: context.last_backup,
          last_edited: context.last_edited,
        },
      });
    } else {
      progress({
        step: "stop-source",
        message: "stopping source project",
        detail: { project_state: context.project_state },
      });
      log.info("moveProjectToHost stopping project before move", {
        project_id: context.project_id,
        project_state: context.project_state,
      });
      try {
        await retryOnceOnTransientMoveError({
          operation: "stop-source",
          detail: { project_id: context.project_id },
          progress,
          run: async () =>
            await stopProjectOnHost(context.project_id, {
              timeout_ms: MOVE_STOP_PROJECT_TIMEOUT_MS,
            }),
        });
      } catch (err) {
        log.error("moveProjectToHost failed to stop project", {
          project_id: context.project_id,
          project_state: context.project_state,
          err,
        });
        throw err;
      }
      await checkCanceled("stop-source");

      if (context.provisioned === false) {
        progress({
          step: "backup",
          message: "project not provisioned; skipping final backup",
          detail: { provisioned: context.provisioned },
        });
        log.info(
          "moveProjectToHost skipping backup for unprovisioned project",
          {
            project_id: context.project_id,
          },
        );
      } else {
        try {
          await invalidateProjectBackupConfigOnHost(context.project_host_id);
        } catch (err) {
          log.warn(
            "moveProjectToHost source backup config invalidation failed",
            {
              project_id: context.project_id,
              source_host_id: context.project_host_id,
              err,
            },
          );
        }
        progress({
          step: "backup",
          message: "writing move verification sentinel",
        });
        moveSentinel = await createMoveSentinel({
          context,
          move_log_id,
          op_id: opts?.op_id,
        });
        progress({
          step: "backup",
          message: "creating final backup (always)",
        });
        log.info("moveProjectToHost creating final backup", {
          project_id: context.project_id,
        });
        try {
          const backupStart = Date.now();
          const result = await retryOnceOnTransientMoveError({
            operation: "backup",
            detail: { project_id: context.project_id },
            progress,
            run: async () =>
              await createFinalBackup({
                account_id: context.account_id,
                project_id: context.project_id,
                progress,
                managed_egress_override: input.managed_egress_override,
              }),
          });
          const backup_id = result.id;
          finalBackupId = backup_id;
          const backup_time = result.time;
          const duration_ms = Date.now() - backupStart;
          progress({
            step: "backup",
            message: "final backup created",
            detail: mergeMoveProgressDetail({
              baseDetail: {
                backup_id,
                backup_time,
                duration_ms,
              },
              child: {
                kind: "project-backup",
                op_id: result.op_id,
                progress: 100,
              },
            }),
          });
          log.info("moveProjectToHost backup created", {
            project_id: context.project_id,
            backup_id,
            duration_ms,
          });
        } catch (err) {
          if (isMissingProjectVolumeError(err)) {
            progress({
              step: "backup",
              message: "source volume missing; skipping final backup",
              detail: { error: `${err}` },
            });
            log.warn(
              "moveProjectToHost skipping backup because volume is missing",
              {
                project_id: context.project_id,
                err,
              },
            );
          } else {
            log.error("moveProjectToHost backup failed", {
              project_id: context.project_id,
              err,
            });
            throw err;
          }
        }
      }
      await checkCanceled("backup");
    }
    progress({
      step: "placement",
      message: "updating project placement",
      detail: { dest_host_id: context.dest_host_id },
    });
    try {
      await savePlacement(context.project_id, {
        host_id: context.dest_host_id,
      });
      placementUpdated = true;
      log.info("moveProjectToHost placement updated", {
        project_id: context.project_id,
        dest_host_id: context.dest_host_id,
      });
    } catch (err) {
      log.error("moveProjectToHost placement update failed", {
        project_id: context.project_id,
        dest_host_id: context.dest_host_id,
        err,
      });
      throw err;
    }
    await checkCanceled("placement");
    if (startDest) {
      try {
        await invalidateProjectBackupConfigOnHost(context.dest_host_id);
      } catch (err) {
        log.warn(
          "moveProjectToHost destination backup config invalidation failed",
          {
            project_id: context.project_id,
            dest_host_id: context.dest_host_id,
            err,
          },
        );
      }
      progress({
        step: "start-dest",
        message: "starting workspace on destination host",
        detail: { dest_host_id: context.dest_host_id },
      });
      try {
        const { startOp } = await retryOnceOnTransientMoveError({
          operation: "start-dest",
          progress_step: "start-dest",
          detail: { dest_host_id: context.dest_host_id },
          progress,
          run: async () => {
            const startOp = await startProjectLro({
              account_id: context.account_id,
              project_id: context.project_id,
              ...(finalBackupId ? { restore_backup_id: finalBackupId } : {}),
              managed_egress_override: input.managed_egress_override,
              wait: false,
            });
            progress({
              step: "start-dest",
              message: "starting workspace on destination host",
              detail: mergeMoveProgressDetail({
                baseDetail: {
                  dest_host_id: context.dest_host_id,
                  start_op_id: startOp.op_id,
                },
                child: {
                  kind: "project-start",
                  op_id: startOp.op_id,
                },
              }),
            });
            let summary: LroSummary | undefined;
            try {
              summary = await waitForLroCompletion({
                op_id: startOp.op_id,
                scope_type: startOp.scope_type,
                scope_id: startOp.scope_id,
                client: conat(),
                timeout_ms: MOVE_START_DEST_TIMEOUT_MS,
                onProgress: (event) => {
                  progress({
                    step: "start-dest",
                    message:
                      event.message ?? event.phase ?? "starting destination",
                    detail: mergeMoveProgressDetail({
                      baseDetail: {
                        dest_host_id: context.dest_host_id,
                        start_op_id: startOp.op_id,
                      },
                      child: {
                        kind: "project-start",
                        op_id: startOp.op_id,
                        phase: event.phase,
                        message: event.message,
                        progress: event.progress,
                        detail: event.detail,
                      },
                    }),
                    progress: event.progress,
                  });
                },
              });
            } catch (err) {
              const snapshot = await loadProjectPlacementState(
                context.project_id,
              );
              const runningOnDestination =
                snapshot.host_id === context.dest_host_id &&
                snapshot.project_state === "running";
              if (!runningOnDestination) {
                throw new Error(
                  `destination start wait failed: ${err} (host_id=${snapshot.host_id ?? "unknown"}, state=${snapshot.project_state ?? "unknown"})`,
                );
              }
              progress({
                step: "start-dest",
                message:
                  "destination workspace reported running after start wait failure",
                detail: {
                  dest_host_id: context.dest_host_id,
                  timeout_ms: MOVE_START_DEST_TIMEOUT_MS,
                  host_id: snapshot.host_id,
                  state: snapshot.project_state,
                  error: `${err}`,
                },
              });
              log.warn(
                "moveProjectToHost destination start wait failed after project reached running",
                {
                  project_id: context.project_id,
                  dest_host_id: context.dest_host_id,
                  timeout_ms: MOVE_START_DEST_TIMEOUT_MS,
                  snapshot,
                  err,
                },
              );
              summary = {
                status: "succeeded",
                op_id: startOp.op_id,
                scope_type: startOp.scope_type,
                scope_id: startOp.scope_id,
                result: { recovered_from_wait_error: `${err}` },
              } as LroSummary;
            }
            if (summary && summary.status !== "succeeded") {
              const reason = summary.error ?? summary.status;
              throw new Error(`destination start failed: ${reason}`);
            }
            return { startOp, summary };
          },
        });
        progress({
          step: "start-dest",
          message: "destination workspace started",
          detail: mergeMoveProgressDetail({
            baseDetail: { dest_host_id: context.dest_host_id },
            child: {
              kind: "project-start",
              op_id: startOp.op_id,
              progress: 100,
            },
          }),
        });
        log.info("moveProjectToHost started project on destination host", {
          project_id: context.project_id,
          dest_host_id: context.dest_host_id,
        });
        if (moveSentinel) {
          progress({
            step: "verify-dest",
            message: "verifying restored project content on destination host",
            detail: { dest_host_id: context.dest_host_id },
          });
          await verifyMoveSentinel({
            project_id: context.project_id,
            sentinel: moveSentinel,
          });
          await deleteMoveSentinelBestEffort({
            project_id: context.project_id,
            stage: "post-verify-dest",
          });
          moveSentinel = undefined;
          progress({
            step: "verify-dest",
            message: "destination restore verified",
            detail: { dest_host_id: context.dest_host_id },
            progress: 100,
          });
        }

        backupRegionCutoverResult = await performBackupRegionCutover({
          context,
          progress,
          managed_egress_override: input.managed_egress_override,
        });

        if (stopDestAfterStart) {
          progress({
            step: "start-dest",
            message: "stopping destination workspace after restore",
            detail: { dest_host_id: context.dest_host_id },
          });
          await stopProjectOnHost(context.project_id, {
            timeout_ms: MOVE_STOP_PROJECT_TIMEOUT_MS,
          });
          progress({
            step: "start-dest",
            message: "destination workspace stopped after restore",
            detail: { dest_host_id: context.dest_host_id },
          });
          log.info(
            "moveProjectToHost stopped destination project after restore",
            {
              project_id: context.project_id,
              dest_host_id: context.dest_host_id,
            },
          );
        }
      } catch (err) {
        if ((err as any)?.code === MOVE_CANCELED_CODE) {
          throw err;
        }
        log.warn("moveProjectToHost start failed after placement update", {
          project_id: context.project_id,
          dest_host_id: context.dest_host_id,
          err,
        });
        progress({
          step: "start-dest",
          message: "destination start failed",
          detail: { dest_host_id: context.dest_host_id, error: `${err}` },
        });
        try {
          await revertPlacementIfPossible(context, progress);
        } catch (revertErr) {
          log.warn("moveProjectToHost placement revert failed", {
            project_id: context.project_id,
            source_host_id: context.project_host_id,
            err: revertErr,
          });
          progress({
            step: "revert-placement",
            message: "source placement revert failed",
            detail: {
              source_host_id: context.project_host_id,
              error: `${revertErr}`,
            },
          });
        }
        try {
          await cleanupDestinationOnFailure(context, progress);
        } catch (cleanupErr) {
          log.warn("moveProjectToHost destination cleanup failed", {
            project_id: context.project_id,
            dest_host_id: context.dest_host_id,
            err: cleanupErr,
          });
          progress({
            step: "cleanup-dest",
            message: "destination cleanup failed",
            detail: {
              dest_host_id: context.dest_host_id,
              error: `${cleanupErr}`,
            },
          });
        }
        if (moveSentinel) {
          await deleteMoveSentinelBestEffort({
            project_id: context.project_id,
            stage: "failed-move-source-cleanup",
          });
          moveSentinel = undefined;
        }
        throw err;
      }
    } else {
      progress({
        step: "start-dest",
        message: "destination start skipped by request",
        detail: { dest_host_id: context.dest_host_id },
        progress: 100,
      });
      log.info("moveProjectToHost skipped destination start", {
        project_id: context.project_id,
        dest_host_id: context.dest_host_id,
      });
    }
    await checkCanceled("start-dest");
    if (
      context.project_host_id &&
      context.project_host_id !== context.dest_host_id
    ) {
      await checkCanceled("cleanup");
      if (!sourceAvailable) {
        progress({
          step: "cleanup",
          message: "source host offline; cleanup deferred",
          detail: { source_host_id: context.project_host_id },
        });
      } else {
        progress({
          step: "cleanup",
          message: "removing source data",
          detail: { source_host_id: context.project_host_id },
        });
        try {
          await deleteProjectDataOnHost({
            project_id: context.project_id,
            host_id: context.project_host_id,
          });
          progress({
            step: "cleanup",
            message: "source data removed",
            detail: { source_host_id: context.project_host_id },
          });
        } catch (err) {
          log.warn("moveProjectToHost cleanup failed", {
            project_id: context.project_id,
            source_host_id: context.project_host_id,
            err,
          });
          progress({
            step: "cleanup",
            message: "source cleanup failed",
            detail: {
              source_host_id: context.project_host_id,
              error: `${err}`,
            },
          });
        }
      }
    } else {
      progress({
        step: "cleanup",
        message: "no source cleanup needed",
        detail: { source_host_id: context.project_host_id ?? undefined },
      });
    }
    progress({
      step: "done",
      message: "move complete",
      detail: { dest_host_id: context.dest_host_id },
    });
    // Re-append the requested row after the final placement so the request
    // record survives moves that do not transfer the source project's log.
    await appendProjectMoveLogEntry({
      project_id: context.project_id,
      account_id: context.account_id,
      move_log_id,
      event: "project_move_requested",
      source_host_id: context.project_host_id,
      source_host_name: context.project_host_name,
      dest_host_id: context.dest_host_id,
      dest_host_name: context.dest_host_name,
      op_id: opts?.op_id,
      extra_event: moveLogExtraEvent(),
      fresh: true,
    });
    await appendProjectMoveLogEntry({
      project_id: context.project_id,
      account_id: context.account_id,
      move_log_id,
      event: "project_moved",
      source_host_id: context.project_host_id,
      source_host_name: context.project_host_name,
      dest_host_id: context.dest_host_id,
      dest_host_name: context.dest_host_name,
      duration_ms: Date.now() - started_at_ms,
      op_id: opts?.op_id,
      extra_event: moveLogExtraEvent(),
      fresh: true,
    });
  } catch (err) {
    if (moveSentinel) {
      await deleteMoveSentinelBestEffort({
        project_id: context.project_id,
        stage: "move-error-cleanup",
      });
      moveSentinel = undefined;
    }
    if ((err as any)?.code === MOVE_CANCELED_CODE) {
      await handleCancel((err as any).stage ?? "unknown");
      throw err;
    }
    await appendProjectMoveLogEntry({
      project_id: context.project_id,
      account_id: context.account_id,
      move_log_id,
      event: "project_move_requested",
      source_host_id: context.project_host_id,
      source_host_name: context.project_host_name,
      dest_host_id: context.dest_host_id,
      dest_host_name: context.dest_host_name,
      op_id: opts?.op_id,
      extra_event: moveLogExtraEvent(),
      fresh: true,
    });
    await appendProjectMoveLogEntry({
      project_id: context.project_id,
      account_id: context.account_id,
      move_log_id,
      event: "project_move_failed",
      source_host_id: context.project_host_id,
      source_host_name: context.project_host_name,
      dest_host_id: context.dest_host_id,
      dest_host_name: context.dest_host_name,
      duration_ms: Date.now() - started_at_ms,
      error: err instanceof Error ? err.message : `${err}`,
      op_id: opts?.op_id,
      extra_event: moveLogExtraEvent(),
      fresh: true,
    });
    throw err;
  }
}
