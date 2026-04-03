import createProject from "@cocalc/server/projects/create";
export { createProject };
import execProject from "@cocalc/server/projects/exec";
import { takeStartProjectPhaseTimings } from "@cocalc/server/project-host/control";
import deleteProjectControl from "@cocalc/server/projects/delete";
import { setProjectDeleted as setProjectDeletedControl } from "@cocalc/server/projects/delete";
import { assertHardDeleteProjectPermission } from "@cocalc/server/projects/hard-delete";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
export * from "@cocalc/server/projects/collaborators";
import { type CopyOptions } from "@cocalc/conat/files/fs";
export * from "@cocalc/server/conat/api/project-snapshots";
export * from "@cocalc/server/conat/api/project-backups";
import getPool from "@cocalc/database/pool";
import { getServerSettings } from "@cocalc/database/settings/server-settings";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import { updateAuthorizedKeysOnHost as updateAuthorizedKeysOnHostControl } from "@cocalc/server/project-host/control";
import { getProject } from "@cocalc/server/projects/control";
import { mirrorStartLroProgress } from "@cocalc/server/projects/start-lro-progress";
import { supersedeOlderProjectStartLros } from "@cocalc/server/projects/start-lro-cleanup";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import { posix } from "path";
import TTLCache from "@isaacs/ttlcache";
import { PROJECT_IMAGE_PATH } from "@cocalc/util/db-schema/defaults";
import { human_readable_size } from "@cocalc/util/misc";
import type {
  ExecuteCodeOptions,
  ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";
import {
  extractProjectIdFromPublicViewerRawUrl,
  parsePublicViewerImportUrl,
} from "@cocalc/util/public-viewer-import";
import {
  isAllowedPublicViewerSourceHost,
  resolvePublicViewerDns,
} from "@cocalc/util/public-viewer-origin";
import {
  cancelCopy as cancelCopyDb,
  listCopiesForProject,
} from "@cocalc/server/projects/copy-db";
import { triggerCopyLroWorker } from "@cocalc/server/projects/copy-worker";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import {
  makeOfflineMoveConfirmationPayload,
  offlineMoveConfirmationError,
} from "@cocalc/server/projects/offline-move-confirmation";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { assertCollab } from "./util";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import type {
  ChatStoreDeleteResult,
  ChatStoreScope,
  ChatStoreStats,
  ChatStoreRotateResult,
  ChatStoreSegment,
  ChatStoreArchivedRow,
  ChatStoreSearchHit,
  ImportPublicUrlResult,
  ImportPublicPathResult,
  PublicPathInspectionResult,
  ProjectCopyRow,
  ProjectRuntimeLog,
  ProjectStorageCountedSummary,
  ProjectStorageBreakdown,
  ProjectStorageHistory,
  ProjectStorageOverview,
  ProjectStorageVisibleSummary,
  WorkspaceSshConnectionInfo,
} from "@cocalc/conat/hub/api/projects";
import {
  deleteChatStoreData,
  getChatStoreStats,
  listChatStoreSegments,
  readChatStoreArchived,
  readChatStoreArchivedHit,
  rotateChatStore,
  searchChatStoreArchived,
  vacuumChatStore,
} from "@cocalc/backend/chat-store/sqlite-offload";
import {
  deleteProjectSshKeyInDb,
  upsertProjectSshKeyInDb,
} from "@cocalc/server/projects/project-ssh-keys";
import {
  loadProjectStorageHistory,
  recordProjectStorageHistorySample,
} from "@cocalc/database/postgres/project-storage-history";
import { parseDustOutput } from "./storage-breakdown";
import {
  getAssignedProjectHostInfo,
  PROJECT_BAY_MISMATCH_ERROR,
  PROJECT_HAS_NO_ASSIGNED_HOST_ERROR,
} from "@cocalc/server/conat/project-host-assignment";
import { getConfiguredBayId } from "@cocalc/server/bay-config";

const PROJECT_STORAGE_CACHE_TTL_MS = 30_000;
const PROJECT_STORAGE_BREAKDOWN_TIMEOUT_MS = 10_000;
const projectStorageOverviewCache = new TTLCache<
  string,
  ProjectStorageOverview
>({
  ttl: PROJECT_STORAGE_CACHE_TTL_MS,
});
const projectStorageBreakdownCache = new TTLCache<
  string,
  ProjectStorageBreakdown
>({
  ttl: PROJECT_STORAGE_CACHE_TTL_MS,
});

function normalizeStoragePath(path?: string): string {
  const normalized = posix.normalize(`${path ?? ""}`.trim() || "/");
  if (!normalized.startsWith("/")) {
    throw new Error(`storage path must be absolute: ${path}`);
  }
  return normalized;
}

function storageOverviewCacheKey({
  project_id,
  home,
}: {
  project_id: string;
  home: string;
}): string {
  return `${project_id}:${home}`;
}

function storageBreakdownCacheKey({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): string {
  return `${project_id}:${path}`;
}

async function projectFs(project_id: string) {
  return conatWithProjectRouting().fs({ project_id });
}

async function getStorageBreakdownImpl({
  project_id,
  path,
}: {
  project_id: string;
  path: string;
}): Promise<ProjectStorageBreakdown> {
  const normalizedPath = normalizeStoragePath(path);
  const cacheKey = storageBreakdownCacheKey({
    project_id,
    path: normalizedPath,
  });
  const cached = projectStorageBreakdownCache.get(cacheKey);
  if (cached) return cached;
  const fs = await projectFs(project_id);
  const breakdown = parseDustOutput(
    await fs.dust(normalizedPath, {
      options: ["-j", "-x", "-d", "1", "-s", "-o", "b", "-P"],
      timeout: PROJECT_STORAGE_BREAKDOWN_TIMEOUT_MS,
    }),
    normalizedPath,
  );
  projectStorageBreakdownCache.set(cacheKey, breakdown);
  return breakdown;
}

export async function copyPathBetweenProjects({
  src,
  src_home,
  dest,
  options,
  account_id,
}: {
  src: { project_id: string; path: string | string[] };
  src_home?: string;
  dest: { project_id: string; path: string };
  options?: CopyOptions;
  account_id?: string;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id) {
    throw Error("user must be signed in");
  }
  await assertCollab({ account_id, project_id: src.project_id });
  if (dest.project_id !== src.project_id) {
    await assertCollab({ account_id, project_id: dest.project_id });
  }
  const op = await createLro({
    kind: "copy-path-between-projects",
    scope_type: "project",
    scope_id: src.project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      src,
      ...(src_home ? { src_home } : {}),
      dests: [dest],
      options,
    },
    status: "queued",
  });
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("copyPathBetweenProjects: unable to publish initial LRO summary", {
      op_id: op.op_id,
      project_id: src.project_id,
      err,
    });
  }
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn(
      "copyPathBetweenProjects: unable to publish queued progress event",
      {
        op_id: op.op_id,
        project_id: src.project_id,
        err,
      },
    );
  });
  triggerCopyLroWorker();
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: src.project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

function basename(path: string): string {
  const parts = `${path ?? ""}`.split("/").filter(Boolean);
  return parts.at(-1) ?? path;
}

function normalizeImportTargetPath(path?: string): string {
  const trimmed = `${path ?? ""}`.trim().replace(/\\/g, "/");
  if (!trimmed) {
    throw new Error("path is required");
  }
  const normalized = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  if (
    !normalized ||
    normalized === "." ||
    normalized.includes("/../") ||
    normalized.startsWith("../") ||
    normalized.endsWith("/..")
  ) {
    throw new Error("path must stay within the target project");
  }
  return normalized;
}

async function getProjectHostId(project_id: string): Promise<string> {
  return (await getAssignedProjectHostInfo(project_id)).host_id;
}

async function resolvePublicImportSource({
  public_url,
}: {
  public_url: string;
}): Promise<{
  parsed: ReturnType<typeof parsePublicViewerImportUrl>;
  source_project_id: string;
  host_id: string;
}> {
  const parsed = parsePublicViewerImportUrl(public_url);
  const settings = await getServerSettings();
  const viewerDns = resolvePublicViewerDns({
    publicViewerDns: settings.public_viewer_dns as string | undefined,
    dns: settings.dns as string | undefined,
  });
  const viewerHostname = (() => {
    const raw = `${viewerDns ?? settings.dns ?? ""}`.trim();
    if (!raw) return undefined;
    try {
      return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
        .hostname;
    } catch {
      return undefined;
    }
  })();
  const sourceUrl = new URL(parsed.rawUrl);
  if (
    !viewerHostname ||
    !isAllowedPublicViewerSourceHost({
      sourceHostname: sourceUrl.hostname,
      viewerHostname,
    })
  ) {
    throw new Error("public import source host is not allowed");
  }
  const source_project_id = extractProjectIdFromPublicViewerRawUrl(
    parsed.rawUrl,
  );
  if (!source_project_id) {
    throw new Error("unable to determine source project for public import");
  }
  const host_id = await getProjectHostId(source_project_id);
  return { parsed, source_project_id, host_id };
}

export async function importPublicUrl({
  account_id,
  project_id,
  public_url,
  path,
}: {
  account_id?: string;
  project_id: string;
  public_url: string;
  path?: string;
}): Promise<ImportPublicUrlResult> {
  await assertCollab({ account_id, project_id });
  const { parsed } = await resolvePublicImportSource({ public_url });

  const response = await fetch(parsed.rawUrl, {
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `failed to fetch public source (${response.status} ${response.statusText})`,
    );
  }
  const maxBytes = 100 * 1024 * 1024;
  const contentLength = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("public import source is too large");
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error("public import source is too large");
  }
  const destPath = normalizeImportTargetPath(path || basename(parsed.path));
  const fs = conatWithProjectRouting().fs({ project_id });
  const parent = posix.dirname(destPath);
  if (parent && parent !== ".") {
    await fs.mkdir(parent, { recursive: true });
  }
  await fs.writeFile(destPath, buffer);
  return {
    project_id,
    path: destPath,
    bytes: buffer.byteLength,
    source_url: parsed.rawUrl,
  };
}

export async function inspectPublicPath({
  account_id,
  public_url,
}: {
  account_id?: string;
  public_url: string;
}): Promise<PublicPathInspectionResult> {
  const { parsed, source_project_id, host_id } =
    await resolvePublicImportSource({
      public_url,
    });
  const client = createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
  });
  const inspection = await client.inspectStaticAppPath({
    project_id: source_project_id,
    url: parsed.rawUrl,
  });
  if (
    !(inspection.exposure_mode === "public" && inspection.public_access_granted)
  ) {
    await assertCollab({ account_id, project_id: source_project_id });
  }
  return {
    source_project_id,
    host_id,
    app_id: inspection.app_id,
    static_root: inspection.static_root,
    exposure_mode: inspection.exposure_mode,
    auth_front: inspection.auth_front,
    public_access_granted: inspection.public_access_granted,
    requested: inspection.requested,
    containing_directory: inspection.containing_directory,
  };
}

export async function importPublicPath({
  account_id,
  project_id,
  public_url,
  mode,
  path,
}: {
  account_id?: string;
  project_id: string;
  public_url: string;
  mode: "file" | "directory";
  path?: string;
}): Promise<ImportPublicPathResult> {
  await assertCollab({ account_id, project_id });
  const inspection = await inspectPublicPath({ account_id, public_url });
  const source =
    mode === "directory"
      ? inspection.containing_directory
      : inspection.requested;
  const suggestedName =
    basename(source.relative_path) || basename(inspection.static_root);
  const destPath = normalizeImportTargetPath(path || suggestedName);
  const op = await copyPathBetweenProjects({
    account_id,
    src: {
      project_id: inspection.source_project_id,
      path: source.container_path,
    },
    dest: {
      project_id,
      path: destPath,
    },
  });
  return {
    ...op,
    project_id,
    path: destPath,
    source_project_id: inspection.source_project_id,
    source_path: source.container_path,
    mode,
  };
}

export async function listPendingCopies({
  account_id,
  project_id,
  include_completed,
}: {
  account_id?: string;
  project_id: string;
  include_completed?: boolean;
}): Promise<ProjectCopyRow[]> {
  await assertCollab({ account_id, project_id });
  return await listCopiesForProject({ project_id, include_completed });
}

export async function cancelPendingCopy({
  account_id,
  src_project_id,
  src_path,
  dest_project_id,
  dest_path,
}: {
  account_id?: string;
  src_project_id: string;
  src_path: string;
  dest_project_id: string;
  dest_path: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id: dest_project_id });
  await cancelCopyDb({
    src_project_id,
    src_path,
    dest_project_id,
    dest_path,
  });
}

import { db } from "@cocalc/database";
import { callback2 } from "@cocalc/util/async-utils";

const log = getLogger("server:conat:api:projects");

function publishStartLroSummaryBestEffort({
  scope_type,
  scope_id,
  summary,
  context,
}: {
  scope_type: LroSummary["scope_type"];
  scope_id: string;
  summary: LroSummary;
  context: string;
}): void {
  void publishLroSummary({
    scope_type,
    scope_id,
    summary,
  }).catch((err) => {
    log.warn(`${context}: unable to publish LRO summary`, {
      op_id: summary.op_id,
      scope_id,
      err,
    });
  });
}

function normalizeLogTail(lines?: number): number {
  const n = Number(lines ?? 200);
  if (!Number.isFinite(n)) return 200;
  return Math.max(1, Math.min(5000, Math.floor(n)));
}

export async function setQuotas(opts: {
  account_id: string;
  project_id: string;
  memory?: number;
  memory_request?: number;
  cpu_shares?: number;
  cores?: number;
  disk_quota?: number;
  mintime?: number;
  network?: number;
  member_host?: number;
  always_running?: number;
}): Promise<void> {
  if (!(await isAdmin(opts.account_id))) {
    throw Error("Must be an admin to do admin search.");
  }
  const database = db();
  await callback2(database.set_project_settings, {
    project_id: opts.project_id,
    settings: opts,
  });
  const project = await database.projectControl?.(opts.project_id);
  // @ts-ignore
  await project?.setAllQuotas();
}

export async function getDiskQuota({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<{
  used: number;
  size: number;
  qgroupid?: string;
  scope?: "tracking" | "subvolume";
  warning?: string;
}> {
  await assertCollab({ account_id, project_id });
  const client = await getProjectFileServerClient({ project_id });
  return await client.getQuota({ project_id });
}

export async function getStorageOverview({
  account_id,
  project_id,
  home,
  force_sample,
}: {
  account_id: string;
  project_id: string;
  home?: string;
  force_sample?: boolean;
}): Promise<ProjectStorageOverview> {
  await assertCollab({ account_id, project_id });
  const homePath = normalizeStoragePath(home || "/root");
  const cacheKey = storageOverviewCacheKey({ project_id, home: homePath });
  const cached = force_sample
    ? undefined
    : projectStorageOverviewCache.get(cacheKey);
  if (cached) return cached;

  const environmentPath = posix.join(homePath, PROJECT_IMAGE_PATH);
  const fileServer = await getProjectFileServerClient({ project_id });
  const [quota, homeUsage, scratchUsage, environmentUsage, snapshotUsage] =
    await Promise.all([
      fileServer.getQuota({ project_id }),
      getStorageBreakdownImpl({ project_id, path: homePath }),
      getStorageBreakdownImpl({ project_id, path: "/scratch" }).catch((err) => {
        const text = `${err ?? ""}`.toLowerCase();
        if (
          text.includes("scratch is not mounted") ||
          text.includes("no such file") ||
          text.includes("not found")
        ) {
          return null;
        }
        throw err;
      }),
      getStorageBreakdownImpl({
        project_id,
        path: environmentPath,
      }).catch((err) => {
        const text = `${err ?? ""}`.toLowerCase();
        if (text.includes("no such file") || text.includes("not found")) {
          return null;
        }
        throw err;
      }),
      fileServer.allSnapshotUsage({ project_id }),
    ]);

  const visible: ProjectStorageVisibleSummary[] = [
    {
      key: "home",
      label: homePath,
      summaryLabel: "Home",
      path: homePath,
      summaryBytes: Math.max(
        0,
        homeUsage.bytes - Math.max(0, environmentUsage?.bytes ?? 0),
      ),
      usage: homeUsage,
    },
  ];
  if (scratchUsage != null) {
    visible.push({
      key: "scratch",
      label: "/scratch",
      summaryLabel: "Scratch",
      path: "/scratch",
      summaryBytes: scratchUsage.bytes,
      usage: scratchUsage,
    });
  }
  if (environmentUsage != null) {
    visible.push({
      key: "environment",
      label: "Environment changes",
      summaryLabel: "Environment",
      path: environmentPath,
      summaryBytes: environmentUsage.bytes,
      usage: environmentUsage,
    });
  }

  const snapshotExclusiveBytes = snapshotUsage.reduce(
    (sum, snapshot) => sum + Math.max(0, snapshot.exclusive ?? 0),
    0,
  );
  const counted: ProjectStorageCountedSummary[] = [];
  if (snapshotExclusiveBytes >= 1 << 20) {
    const snapshotCount = snapshotUsage.length;
    const largestExclusiveBytes = snapshotUsage.reduce(
      (max, snapshot) => Math.max(max, Math.max(0, snapshot.exclusive ?? 0)),
      0,
    );
    counted.push({
      key: "snapshots",
      label: "Snapshots",
      bytes: snapshotExclusiveBytes,
      compactLabel: "Snapshots",
      detail:
        snapshotCount <= 1
          ? "This snapshot currently holds counted storage that would be freed if it is deleted."
          : `Across ${snapshotCount} snapshots, this is storage referenced only by snapshots. The largest single snapshot currently has about ${human_readable_size(largestExclusiveBytes)} of exclusive data, and exact savings from deleting one snapshot depend on overlap.`,
    });
  }

  const overview: ProjectStorageOverview = {
    collected_at: new Date().toISOString(),
    quotas: [
      {
        key: "project",
        label: "Project quota",
        used: quota.used,
        size: quota.size,
        qgroupid: quota.qgroupid,
        scope: quota.scope,
        warning: quota.warning,
      },
    ],
    visible,
    counted,
  };
  try {
    await recordProjectStorageHistorySample({
      project_id,
      overview,
      force: !!force_sample,
    });
  } catch (err) {
    log.warn("getStorageOverview: unable to record storage history sample", {
      project_id,
      err,
    });
  }
  projectStorageOverviewCache.set(cacheKey, overview);
  return overview;
}

export async function getStorageBreakdown({
  account_id,
  project_id,
  path,
}: {
  account_id: string;
  project_id: string;
  path: string;
}): Promise<ProjectStorageBreakdown> {
  await assertCollab({ account_id, project_id });
  return await getStorageBreakdownImpl({ project_id, path });
}

export async function getStorageHistory({
  account_id,
  project_id,
  window_minutes,
  max_points,
}: {
  account_id: string;
  project_id: string;
  window_minutes?: number;
  max_points?: number;
}): Promise<ProjectStorageHistory> {
  await assertCollab({ account_id, project_id });
  return await loadProjectStorageHistory({
    project_id,
    window_minutes,
    max_points,
  });
}

export async function exec({
  account_id,
  project_id,
  execOpts,
}: {
  account_id: string;
  project_id: string;
  execOpts: ExecuteCodeOptions;
}): Promise<ExecuteCodeOutput> {
  return await execProject({ account_id, project_id, execOpts });
}

export async function getRuntimeLog({
  account_id,
  project_id,
  lines,
}: {
  account_id: string;
  project_id: string;
  lines?: number;
}): Promise<ProjectRuntimeLog> {
  await assertCollab({ account_id, project_id });
  const tail = normalizeLogTail(lines);
  let host_id: string;
  try {
    host_id = (await getAssignedProjectHostInfo(project_id)).host_id;
  } catch (err) {
    const reason =
      err instanceof Error ? err.message : PROJECT_HAS_NO_ASSIGNED_HOST_ERROR;
    if (
      reason === PROJECT_HAS_NO_ASSIGNED_HOST_ERROR ||
      reason === PROJECT_BAY_MISMATCH_ERROR
    ) {
      return {
        project_id,
        host_id: null,
        container: `project-${project_id}`,
        lines: tail,
        text: "",
        found: false,
        running: false,
        available: false,
        reason,
      };
    }
    throw err;
  }
  if (!host_id) {
    return {
      project_id,
      host_id: null,
      container: `project-${project_id}`,
      lines: tail,
      text: "",
      found: false,
      running: false,
      available: false,
      reason: PROJECT_HAS_NO_ASSIGNED_HOST_ERROR,
    };
  }
  const client = createHostControlClient({
    host_id,
    client: conatWithProjectRouting(),
  });
  const response = await client.getProjectRuntimeLog({
    project_id,
    lines: tail,
  });
  return {
    project_id,
    host_id,
    container: response.container,
    lines: response.lines,
    text: response.text,
    found: response.found,
    running: response.running,
    available: response.found && response.running,
    reason: response.found
      ? response.running
        ? undefined
        : "workspace is not running"
      : "workspace container not found",
  };
}

export async function resolveWorkspaceSshConnection({
  account_id,
  project_id,
  direct,
}: {
  account_id?: string;
  project_id: string;
  direct?: boolean;
}): Promise<WorkspaceSshConnectionInfo> {
  await assertCollab({ account_id, project_id });
  const row = await getAssignedProjectHostInfo(project_id);
  const metadata = row.metadata ?? {};
  const machine = metadata?.machine ?? {};
  const rawSelfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !rawSelfHostMode
      ? "local"
      : rawSelfHostMode;
  const isLocalSelfHost =
    machine?.cloud === "self-host" && effectiveSelfHostMode === "local";
  const cloudflareHostname =
    `${metadata?.cloudflare_tunnel?.ssh_hostname ?? ""}`.trim() || null;
  let sshServer = row.ssh_server ?? null;
  if (isLocalSelfHost) {
    const sshPort = Number(metadata?.self_host?.ssh_tunnel_port);
    if (Number.isInteger(sshPort) && sshPort > 0 && sshPort <= 65535) {
      const sshHost = resolveOnPremHost();
      sshServer = `${sshHost}:${sshPort}`;
    }
  }
  if (!direct && cloudflareHostname) {
    return {
      workspace_id: project_id,
      host_id: row.host_id,
      transport: "cloudflare-tcp",
      ssh_username: project_id,
      ssh_server: null,
      cloudflare_hostname: cloudflareHostname,
    };
  }
  if (!sshServer) {
    throw new Error("host has no ssh server endpoint");
  }
  return {
    workspace_id: project_id,
    host_id: row.host_id,
    transport: "direct",
    ssh_username: project_id,
    ssh_server: sshServer,
    cloudflare_hostname: cloudflareHostname,
  };
}

export async function resolveProjectSshConnection({
  account_id,
  project_id,
  direct,
}: {
  account_id?: string;
  project_id: string;
  direct?: boolean;
}): Promise<WorkspaceSshConnectionInfo> {
  return await resolveWorkspaceSshConnection({
    account_id,
    project_id,
    direct,
  });
}

export async function start({
  account_id,
  project_id,
  restore: _restore,
  wait = true,
}: {
  account_id: string;
  project_id: string;
  // not used; passed through for typing compatibility with project-host
  run_quota?: any;
  // not used; passed through for typing compatibility with project-host
  restore?: "none" | "auto" | "required";
  wait?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  await assertCollab({ account_id, project_id });
  const op = await createLro({
    kind: "project-start",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: { project_id },
    status: "queued",
  });
  publishStartLroSummaryBestEffort({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
    context: "start: initial",
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn("start: unable to publish queued progress event", {
      op_id: op.op_id,
      project_id,
      err,
    });
  });

  log.debug("start", { project_id, op_id: op.op_id });
  const project = await getProject(project_id);
  const response = {
    op_id: op.op_id,
    scope_type: "project" as const,
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
  const runStart = async () => {
    const running = await updateLro({
      op_id: op.op_id,
      status: "running",
      progress_summary: {
        phase: "queued",
        message: "queued",
        progress: 0,
      },
      error: null,
    });
    if (running) {
      publishStartLroSummaryBestEffort({
        scope_type: running.scope_type,
        scope_id: running.scope_id,
        summary: running,
        context: "start: running",
      });
    }
    const stopProgressMirror = await mirrorStartLroProgress({
      project_id,
      op_id: op.op_id,
    });
    try {
      await project.start({
        lro_op_id: op.op_id,
        account_id,
      });
      const phase_timings_ms = takeStartProjectPhaseTimings(op.op_id);
      const progress_summary = {
        done: 1,
        total: 1,
        failed: 0,
        queued: 0,
        expired: 0,
        applying: 0,
        canceled: 0,
        phase_timings_ms,
      };
      const updated = await updateLro({
        op_id: op.op_id,
        status: "succeeded",
        progress_summary,
        result: progress_summary,
        error: null,
      });
      if (updated) {
        publishStartLroSummaryBestEffort({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
          context: "start: succeeded",
        });
      }
      await supersedeOlderProjectStartLros({
        project_id,
        keep_op_id: op.op_id,
      });
    } catch (err) {
      const updated = await updateLro({
        op_id: op.op_id,
        status: "failed",
        error: `${err}`,
      });
      if (updated) {
        publishStartLroSummaryBestEffort({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
          context: "start: failed",
        });
      }
      throw err;
    } finally {
      await stopProgressMirror();
    }
  };

  if (wait) {
    await runStart();
  } else {
    runStart().catch((err) =>
      log.warn("async start failed", { project_id, err: `${err}` }),
    );
  }
  return response;
}

export async function stop({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id });
  log.debug("stop", { project_id });
  const project = await getProject(project_id);
  await project.stop();
}

export async function deleteProject({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<void> {
  if (!account_id) {
    throw new Error("must be signed in");
  }
  await deleteProjectControl({
    project_id,
    account_id,
  });
}

export async function setProjectDeleted({
  account_id,
  project_id,
  deleted,
}: {
  account_id?: string;
  project_id: string;
  deleted: boolean;
}): Promise<void> {
  if (!account_id) {
    throw new Error("must be signed in");
  }
  await setProjectDeletedControl({
    project_id,
    account_id,
    deleted: !!deleted,
  });
}

export async function hardDeleteProject({
  account_id,
  project_id,
  backup_retention_days,
  purge_backups_now,
}: {
  account_id?: string;
  project_id: string;
  backup_retention_days?: number;
  purge_backups_now?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "account";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!account_id) {
    throw new Error("must be signed in");
  }
  await assertHardDeleteProjectPermission({
    project_id,
    account_id,
  });
  const op = await createLro({
    kind: "project-hard-delete",
    scope_type: "account",
    scope_id: account_id,
    created_by: account_id,
    routing: "hub",
    input: {
      project_id,
      backup_retention_days,
      purge_backups_now: !!purge_backups_now,
    },
    status: "queued",
    dedupe_key: `project-hard-delete:${project_id}`,
  });
  await publishLroSummary({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    summary: op,
  });
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
      detail: {
        project_id,
      },
    },
  }).catch(() => {});
  return {
    op_id: op.op_id,
    scope_type: "account",
    scope_id: account_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function updateAuthorizedKeysOnHost({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id });
  await updateAuthorizedKeysOnHostControl(project_id);
}

export async function setProjectHidden({
  account_id,
  project_id,
  hide,
}: {
  account_id?: string;
  project_id: string;
  hide: boolean;
}): Promise<void> {
  if (typeof hide !== "boolean") {
    throw Error("hide must be a boolean");
  }
  await assertCollab({ account_id, project_id });
  const pool = getPool();
  const result = await pool.query(
    `UPDATE projects
        SET users = jsonb_set(
          COALESCE(users, '{}'::jsonb),
          ARRAY[$2::text, 'hide'],
          to_jsonb($3::boolean),
          true
        )
      WHERE project_id = $1
        AND COALESCE(owning_bay_id, $4) = $4
        AND (users -> $2::text ->> 'group') IN ('owner', 'collaborator')`,
    [project_id, account_id, hide, getConfiguredBayId()],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw Error("user must be a collaborator");
  }
}

export async function setProjectSshKey({
  account_id,
  project_id,
  fingerprint,
  title,
  value,
  creation_date,
  last_use_date,
}: {
  account_id?: string;
  project_id: string;
  fingerprint: string;
  title: string;
  value: string;
  creation_date?: number;
  last_use_date?: number;
}): Promise<void> {
  await assertCollab({ account_id, project_id });
  const actor = account_id as string;
  const fp = `${fingerprint ?? ""}`.trim();
  if (!fp) {
    throw Error("fingerprint must be non-empty");
  }
  const payload = {
    title,
    value,
    creation_date: creation_date ?? Date.now(),
    ...(last_use_date != null ? { last_use_date } : {}),
  };
  if (
    !(await upsertProjectSshKeyInDb({
      project_id,
      account_id: actor,
      fingerprint: fp,
      payload,
    }))
  ) {
    throw Error("user must be a collaborator");
  }
}

export async function deleteProjectSshKey({
  account_id,
  project_id,
  fingerprint,
}: {
  account_id?: string;
  project_id: string;
  fingerprint: string;
}): Promise<void> {
  await assertCollab({ account_id, project_id });
  const actor = account_id as string;
  const fp = `${fingerprint ?? ""}`.trim();
  if (!fp) {
    throw Error("fingerprint must be non-empty");
  }
  if (
    !(await deleteProjectSshKeyInDb({
      project_id,
      account_id: actor,
      fingerprint: fp,
    }))
  ) {
    throw Error("user must be a collaborator");
  }
}

export async function moveProject({
  account_id,
  project_id,
  dest_host_id,
  allow_offline,
}: {
  account_id: string;
  project_id: string;
  dest_host_id?: string;
  allow_offline?: boolean;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  await assertCollab({ account_id, project_id });
  const movePrecheck = await getMoveOfflinePrecheck({ project_id });
  if (!allow_offline) {
    await ensureMoveOfflineAllowed({
      movePrecheck,
    });
  }
  const lroInput = {
    project_id,
    allow_offline,
    source_host_id: movePrecheck.source_host_id,
    ...(dest_host_id ? { dest_host_id } : {}),
  };
  const op = await createLro({
    kind: "project-move",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: lroInput,
    status: "queued",
  });
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("moveProject: unable to publish initial LRO summary", {
      op_id: op.op_id,
      project_id,
      err,
    });
  }
  publishLroEvent({
    scope_type: op.scope_type,
    scope_id: op.scope_id,
    op_id: op.op_id,
    event: {
      type: "progress",
      ts: Date.now(),
      phase: "queued",
      message: "queued",
      progress: 0,
    },
  }).catch((err) => {
    log.warn("moveProject: unable to publish queued progress event", {
      op_id: op.op_id,
      project_id,
      err,
    });
  });

  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

const HOST_SEEN_TTL_MS = 2 * 60 * 1000;

type MoveOfflinePrecheck = {
  source_host_id?: string;
  last_edited: Date | null;
  last_backup: Date | null;
};

async function getMoveOfflinePrecheck({
  project_id,
}: {
  project_id: string;
}): Promise<MoveOfflinePrecheck> {
  const pool = getPool();
  const { rows } = await pool.query<{
    source_host_id: string | null;
    last_edited: Date | null;
    last_backup: Date | null;
  }>(
    `
      SELECT
        CASE
          WHEN COALESCE(projects.owning_bay_id, $2) = COALESCE(project_hosts.bay_id, $2)
            THEN projects.host_id
          ELSE NULL
        END AS source_host_id,
        projects.last_edited,
        projects.last_backup
      FROM projects
      LEFT JOIN project_hosts
        ON project_hosts.id = projects.host_id
       AND project_hosts.deleted IS NULL
      WHERE projects.project_id=$1
      LIMIT 1
    `,
    [project_id, getConfiguredBayId()],
  );
  const row = rows[0];
  return {
    source_host_id: row?.source_host_id ?? undefined,
    last_edited: row?.last_edited ?? null,
    last_backup: row?.last_backup ?? null,
  };
}

async function ensureMoveOfflineAllowed({
  movePrecheck,
}: {
  movePrecheck: MoveOfflinePrecheck;
}): Promise<void> {
  const source_host_id = movePrecheck.source_host_id;
  if (!source_host_id) {
    return;
  }
  const pool = getPool();
  const hostRow = await pool.query<{
    status: string | null;
    deleted: Date | null;
    last_seen: Date | null;
  }>("SELECT status, deleted, last_seen FROM project_hosts WHERE id=$1", [
    source_host_id,
  ]);
  const host = hostRow.rows[0];
  const status = String(host?.status ?? "");
  const lastSeenMs = host?.last_seen
    ? new Date(host.last_seen as any).getTime()
    : 0;
  const seenRecently = lastSeenMs
    ? Date.now() - lastSeenMs <= HOST_SEEN_TTL_MS
    : false;
  const hostAvailable =
    !!host &&
    !host.deleted &&
    ["running", "starting", "restarting", "error"].includes(status) &&
    seenRecently;
  if (hostAvailable) {
    return;
  }
  const lastEdited = movePrecheck.last_edited
    ? new Date(movePrecheck.last_edited).getTime()
    : 0;
  const lastBackup = movePrecheck.last_backup
    ? new Date(movePrecheck.last_backup).getTime()
    : 0;
  if (!lastEdited) {
    return;
  }
  if (!lastBackup || lastEdited > lastBackup) {
    throw offlineMoveConfirmationError(
      makeOfflineMoveConfirmationPayload({
        source_status: status || "unknown",
        last_backup: movePrecheck.last_backup,
        last_edited: movePrecheck.last_edited,
      }),
    );
  }
}

export async function getSshKeys({
  project_id,
}: {
  project_id?: string;
} = {}): Promise<string[]> {
  if (!project_id) {
    throw Error("project_id must be specified");
  }
  const pool = getPool();
  const keys: string[] = [];
  const f = async (query) => {
    const { rows } = await pool.query(query, [project_id]);
    for (const x of rows) {
      keys.push((x as any).key);
    }
  };

  // The two crazy looking queries below get the ssh public keys
  // for a specific project, both the project-specific keys *AND*
  // the global keys for collabs that happen to apply to the project.
  // We use complicated jsonb so these are weird/complicated queries,
  // which AI wrote (with some uuid casting by me), but they work
  // fine as far as I can tell.
  await Promise.all([
    f(`
SELECT
  ssh_key ->> 'value' AS key
FROM projects
CROSS JOIN LATERAL jsonb_each(users) AS u(user_id, user_data)
CROSS JOIN LATERAL jsonb_each(u.user_data -> 'ssh_keys') AS k(fingerprint, ssh_key)
WHERE project_id = $1;
`),
    f(`
SELECT  kdata ->> 'value' AS key
FROM projects p
CROSS JOIN LATERAL jsonb_object_keys(p.users) AS u(account_id)
JOIN accounts a ON a.account_id = u.account_id::uuid
CROSS JOIN LATERAL jsonb_each(a.ssh_keys) AS k(fingerprint, kdata)
WHERE p.project_id = $1;
`),
  ]);

  return Array.from(new Set<string>(keys));
}

// This is intentionally not implemented in the central hub API yet.
// Device auth must run on a specific project-host, selected by project_id.
export async function codexDeviceAuthStart({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "codex device auth is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function codexDeviceAuthStatus({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  id: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "codex device auth is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function codexDeviceAuthCancel({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  id: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "codex device auth is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function codexUploadAuthFile({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
  filename?: string;
  content: string;
}): Promise<never> {
  await assertCollab({ account_id, project_id });
  throw Error(
    "codex auth-file upload is not implemented on central hub; call a project-host endpoint via project routing",
  );
}

export async function chatStoreStats({
  account_id,
  project_id,
  chat_path,
  db_path,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
}): Promise<ChatStoreStats> {
  await assertCollab({ account_id, project_id });
  return await getChatStoreStats({ chat_path, db_path });
}

export async function chatStoreRotate({
  account_id,
  project_id,
  chat_path,
  db_path,
  keep_recent_messages,
  max_head_bytes,
  max_head_messages,
  require_idle,
  force,
  dry_run,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  keep_recent_messages?: number;
  max_head_bytes?: number;
  max_head_messages?: number;
  require_idle?: boolean;
  force?: boolean;
  dry_run?: boolean;
}): Promise<ChatStoreRotateResult> {
  await assertCollab({ account_id, project_id });
  return await rotateChatStore({
    chat_path,
    db_path,
    keep_recent_messages,
    max_head_bytes,
    max_head_messages,
    require_idle,
    force,
    dry_run,
  });
}

export async function chatStoreListSegments({
  account_id,
  project_id,
  chat_path,
  db_path,
  limit,
  offset,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  limit?: number;
  offset?: number;
}): Promise<{ chat_id: string; segments: ChatStoreSegment[] }> {
  await assertCollab({ account_id, project_id });
  return listChatStoreSegments({
    chat_path,
    db_path,
    limit,
    offset,
  });
}

export async function chatStoreReadArchived({
  account_id,
  project_id,
  chat_path,
  db_path,
  before_date_ms,
  thread_id,
  limit,
  offset,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  before_date_ms?: number;
  thread_id?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  chat_id: string;
  rows: ChatStoreArchivedRow[];
  offset: number;
  next_offset?: number;
}> {
  await assertCollab({ account_id, project_id });
  return readChatStoreArchived({
    chat_path,
    db_path,
    before_date_ms,
    thread_id,
    limit,
    offset,
  });
}

export async function chatStoreReadArchivedHit({
  account_id,
  project_id,
  chat_path,
  db_path,
  row_id,
  message_id,
  thread_id,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  row_id?: number;
  message_id?: string;
  thread_id?: string;
}): Promise<{ chat_id: string; row?: ChatStoreArchivedRow }> {
  await assertCollab({ account_id, project_id });
  return readChatStoreArchivedHit({
    chat_path,
    db_path,
    row_id,
    message_id,
    thread_id,
  });
}

export async function chatStoreSearch({
  account_id,
  project_id,
  chat_path,
  query,
  db_path,
  thread_id,
  exclude_thread_ids,
  limit,
  offset,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  query: string;
  db_path?: string;
  thread_id?: string;
  exclude_thread_ids?: string[];
  limit?: number;
  offset?: number;
}): Promise<{
  chat_id: string;
  hits: ChatStoreSearchHit[];
  offset: number;
  total_hits: number;
  next_offset?: number;
}> {
  await assertCollab({ account_id, project_id });
  return searchChatStoreArchived({
    chat_path,
    query,
    db_path,
    thread_id,
    exclude_thread_ids,
    limit,
    offset,
  });
}

export async function chatStoreDelete({
  account_id,
  project_id,
  chat_path,
  db_path,
  scope,
  before_date_ms,
  thread_id,
  message_ids,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
  scope: ChatStoreScope;
  before_date_ms?: number;
  thread_id?: string;
  message_ids?: string[];
}): Promise<ChatStoreDeleteResult> {
  await assertCollab({ account_id, project_id });
  return deleteChatStoreData({
    chat_path,
    db_path,
    scope,
    before_date_ms,
    thread_id,
    message_ids,
  });
}

export async function chatStoreVacuum({
  account_id,
  project_id,
  chat_path,
  db_path,
}: {
  account_id?: string;
  project_id: string;
  chat_path: string;
  db_path?: string;
}): Promise<{
  chat_id: string;
  db_path: string;
  before_bytes: number;
  after_bytes: number;
}> {
  await assertCollab({ account_id, project_id });
  return vacuumChatStore({
    chat_path,
    db_path,
  });
}
