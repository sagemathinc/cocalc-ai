import createProject from "@cocalc/server/projects/create";
export { createProject };
import execProject from "@cocalc/server/projects/exec";
import getLogger from "@cocalc/backend/logger";
import isAdmin from "@cocalc/server/accounts/is-admin";
export * from "@cocalc/server/projects/collaborators";
import { type CopyOptions } from "@cocalc/conat/files/fs";
import { client as filesystemClient } from "@cocalc/conat/files/file-server";
export * from "@cocalc/server/conat/api/project-snapshots";
export * from "@cocalc/server/conat/api/project-backups";
import getPool from "@cocalc/database/pool";
import { createHostControlClient } from "@cocalc/conat/project-host/api";
import {
  updateAuthorizedKeysOnHost as updateAuthorizedKeysOnHostControl,
} from "@cocalc/server/project-host/control";
import { getProject } from "@cocalc/server/projects/control";
import { conatWithProjectRouting } from "@cocalc/server/conat/route-client";
import { resolveOnPremHost } from "@cocalc/server/onprem";
import type {
  ExecuteCodeOptions,
  ExecuteCodeOutput,
} from "@cocalc/util/types/execute-code";
import {
  cancelCopy as cancelCopyDb,
  listCopiesForProject,
} from "@cocalc/server/projects/copy-db";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/conat/lro/stream";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { assertCollab } from "./util";
import type {
  ProjectCopyRow,
  ProjectRuntimeLog,
  WorkspaceSshConnectionInfo,
} from "@cocalc/conat/hub/api/projects";

export async function copyPathBetweenProjects({
  src,
  dest,
  options,
  account_id,
}: {
  src: { project_id: string; path: string | string[] };
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
    input: { src, dests: [dest], options },
    status: "queued",
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
    },
  }).catch(() => {});
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: src.project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
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
}): Promise<{ used: number; size: number }> {
  await assertCollab({ account_id, project_id });
  // Route directly to the project-host that owns this project so quota reflects
  // the correct btrfs volume.
  const client = filesystemClient({ project_id });
  return await client.getQuota({ project_id });
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
  const { rows } = await getPool().query<{ host_id: string | null }>(
    "SELECT host_id FROM projects WHERE project_id=$1",
    [project_id],
  );
  const host_id = rows[0]?.host_id ?? null;
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
      reason: "workspace has no assigned host",
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
  const { rows } = await getPool().query<{
    host_id: string | null;
    ssh_server: string | null;
    metadata: any;
  }>(
    `SELECT p.host_id, h.ssh_server, h.metadata
       FROM projects p
       LEFT JOIN project_hosts h ON h.id=p.host_id AND h.deleted IS NULL
      WHERE p.project_id=$1
      LIMIT 1`,
    [project_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error("workspace not found");
  }
  if (!row.host_id) {
    throw new Error("workspace has no assigned host");
  }
  const metadata = row.metadata ?? {};
  const machine = metadata?.machine ?? {};
  const rawSelfHostMode = machine?.metadata?.self_host_mode;
  const effectiveSelfHostMode =
    machine?.cloud === "self-host" && !rawSelfHostMode ? "local" : rawSelfHostMode;
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
      transport: "cloudflare-access-tcp",
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
    },
  }).catch(() => {});

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
      error: null,
    });
    if (running) {
      await publishLroSummary({
        scope_type: running.scope_type,
        scope_id: running.scope_id,
        summary: running,
      });
    }
    try {
      await project.start({ lro_op_id: op.op_id, account_id });
      const progress_summary = {
        done: 1,
        total: 1,
        failed: 0,
        queued: 0,
        expired: 0,
        applying: 0,
        canceled: 0,
      };
      const updated = await updateLro({
        op_id: op.op_id,
        status: "succeeded",
        progress_summary,
        result: progress_summary,
        error: null,
      });
      if (updated) {
        await publishLroSummary({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
        });
      }
    } catch (err) {
      const updated = await updateLro({
        op_id: op.op_id,
        status: "failed",
        error: `${err}`,
      });
      if (updated) {
        await publishLroSummary({
          scope_type: updated.scope_type,
          scope_id: updated.scope_id,
          summary: updated,
        });
      }
      throw err;
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
  if (!allow_offline) {
    await ensureMoveOfflineAllowed({ project_id });
  }
  const op = await createLro({
    kind: "project-move",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: dest_host_id
      ? { project_id, dest_host_id, allow_offline }
      : { project_id, allow_offline },
    status: "queued",
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
    },
  }).catch(() => {});

  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

const HOST_SEEN_TTL_MS = 2 * 60 * 1000;
const OFFLINE_MOVE_CONFIRM_CODE = "MOVE_OFFLINE_CONFIRMATION_REQUIRED";

async function ensureMoveOfflineAllowed({
  project_id,
}: {
  project_id: string;
}): Promise<void> {
  const pool = getPool();
  const { rows } = await pool.query<{
    host_id: string | null;
    last_edited: Date | null;
    last_backup: Date | null;
  }>(
    "SELECT host_id, last_edited, last_backup FROM projects WHERE project_id=$1",
    [project_id],
  );
  const row = rows[0];
  if (!row?.host_id) {
    return;
  }
  const hostRow = await pool.query<{
    status: string | null;
    deleted: Date | null;
    last_seen: Date | null;
  }>("SELECT status, deleted, last_seen FROM project_hosts WHERE id=$1", [
    row.host_id,
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
  const lastEdited = row.last_edited ? new Date(row.last_edited).getTime() : 0;
  const lastBackup = row.last_backup ? new Date(row.last_backup).getTime() : 0;
  if (!lastEdited) {
    return;
  }
  if (!lastBackup || lastEdited > lastBackup) {
    const detail = `source host is offline (status=${status || "unknown"}) and last backup is older than last edit (last_backup=${
      row.last_backup ? row.last_backup.toISOString?.() ?? row.last_backup : "none"
    }, last_edited=${row.last_edited?.toISOString?.() ?? row.last_edited})`;
    throw new Error(`${OFFLINE_MOVE_CONFIRM_CODE}: ${detail}`);
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
