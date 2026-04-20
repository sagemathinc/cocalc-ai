import {
  type RestoreMode,
  type RestoreStagingHandle,
} from "@cocalc/conat/files/file-server";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import getLogger from "@cocalc/backend/logger";
import { assertCollab } from "./util";
import { createLro, updateLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import {
  backupLroDedupeKey,
  BACKUP_TIMEOUT_MS,
} from "@cocalc/server/projects/backup-lro";
import { triggerBackupLroWorker } from "@cocalc/server/projects/backup-worker";
import { assertPortableProjectRootfs } from "@cocalc/server/projects/rootfs-state";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { getInterBayBridge } from "@cocalc/server/inter-bay/bridge";

// just *some* limit to avoid bugs/abuse

const MAX_BACKUPS_PER_PROJECT = 30;
const log = getLogger("server:conat:api:project-backups");
const BACKUP_CONTROL_TIMEOUT_MS = BACKUP_TIMEOUT_MS + 60_000;

async function projectClient(project_id: string, account_id?: string) {
  return await getProjectFileServerClient({ project_id, account_id });
}

async function publishQueuedLroSafe({
  op,
  project_id,
  kind,
}: {
  op: LroSummary;
  project_id: string;
  kind: string;
}) {
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("unable to publish initial LRO summary", {
      kind,
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
    log.warn("unable to publish queued LRO progress event", {
      kind,
      op_id: op.op_id,
      project_id,
      err,
    });
  });
}

async function publishLroSummarySafe({
  op,
  project_id,
  kind,
}: {
  op: LroSummary;
  project_id: string;
  kind: string;
}) {
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch (err) {
    log.warn("unable to publish LRO summary", {
      kind,
      op_id: op.op_id,
      project_id,
      err,
    });
  }
}

function lroResponse({
  op,
  project_id,
}: {
  op: LroSummary;
  project_id: string;
}): {
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
} {
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

async function createBackupLro({
  account_id,
  project_id,
  tags,
}: {
  account_id?: string;
  project_id: string;
  tags?: string[];
}): Promise<LroSummary> {
  return await createLro({
    kind: "project-backup",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: { project_id, tags },
    status: "queued",
    dedupe_key: backupLroDedupeKey(project_id),
  });
}

async function runRemoteBackup({
  account_id,
  project_id,
  tags,
  op,
  dest_bay,
  epoch,
}: {
  account_id?: string;
  project_id: string;
  tags?: string[];
  op: LroSummary;
  dest_bay: string;
  epoch?: number;
}) {
  const running = await updateLro({
    op_id: op.op_id,
    status: "running",
    error: null,
    progress_summary: {
      phase: "remote-backup",
      message: `delegating backup to ${dest_bay}`,
      progress: 0,
    },
  });
  if (running) {
    await publishLroSummarySafe({
      op: running,
      project_id,
      kind: "project-backup",
    });
  }
  try {
    const summary = await getInterBayBridge()
      .projectControl(dest_bay, {
        timeout_ms: BACKUP_CONTROL_TIMEOUT_MS,
      })
      .backup({
        project_id,
        account_id,
        tags,
        epoch,
      });
    const updated = await updateLro({
      op_id: op.op_id,
      status: summary.status,
      result: summary.result,
      error: summary.error,
      progress_summary: summary.progress_summary,
    });
    if (updated) {
      await publishLroSummarySafe({
        op: updated,
        project_id,
        kind: "project-backup",
      });
    }
  } catch (err) {
    const updated = await updateLro({
      op_id: op.op_id,
      status: "failed",
      error: `${err}`,
    });
    if (updated) {
      await publishLroSummarySafe({
        op: updated,
        project_id,
        kind: "project-backup",
      });
    }
    throw err;
  }
}

export async function createBackup(
  {
    account_id,
    project_id,
    tags,
  }: {
    account_id?: string;
    project_id: string;
    name?: string;
    tags?: string[];
  },
  opts?: {
    skip_collab_check?: boolean;
    skip_rootfs_portability_check?: boolean;
    skip_owner_route?: boolean;
  },
): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  if (!opts?.skip_collab_check) {
    await assertCollab({ account_id, project_id });
  }
  if (!opts?.skip_owner_route) {
    const ownership = await resolveProjectBay(project_id);
    if (ownership == null) {
      throw new Error(`project ${project_id} not found`);
    }
    if (ownership.bay_id !== getConfiguredBayId()) {
      const op = await createBackupLro({ account_id, project_id, tags });
      await publishQueuedLroSafe({
        op,
        project_id,
        kind: "project-backup",
      });
      if (op.status === "queued") {
        runRemoteBackup({
          account_id,
          project_id,
          tags,
          op,
          dest_bay: ownership.bay_id,
          epoch: ownership.epoch,
        }).catch((err) =>
          log.warn("remote backup failed", {
            op_id: op.op_id,
            project_id,
            dest_bay: ownership.bay_id,
            err: `${err}`,
          }),
        );
      }
      return lroResponse({ op, project_id });
    }
  }
  if (!opts?.skip_rootfs_portability_check) {
    await assertPortableProjectRootfs({
      project_id,
      operation: "backup",
    });
  }
  const op = await createBackupLro({ account_id, project_id, tags });
  await publishQueuedLroSafe({
    op,
    project_id,
    kind: "project-backup",
  });
  triggerBackupLroWorker();
  return lroResponse({ op, project_id });
}

export async function deleteBackup({
  account_id,
  project_id,
  id,
}: {
  account_id?: string;
  project_id: string;
  id: string;
}) {
  await assertCollab({ account_id, project_id });
  await (
    await projectClient(project_id, account_id)
  ).deleteBackup({
    project_id,
    id,
  });
}

export async function restoreBackup({
  account_id,
  project_id,
  id,
  path,
  dest,
}: {
  account_id?: string;
  project_id: string;
  id: string;
  path?: string;
  dest?: string;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  await assertCollab({ account_id, project_id });
  const op = await createLro({
    kind: "project-restore",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: { project_id, id, path, dest },
    status: "queued",
  });
  await publishQueuedLroSafe({
    op,
    project_id,
    kind: "project-restore",
  });
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}

export async function beginRestoreStaging({
  account_id,
  project_id,
  home,
  restore,
}: {
  account_id?: string;
  project_id: string;
  home?: string;
  restore?: RestoreMode;
}): Promise<RestoreStagingHandle | null> {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).beginRestoreStaging({
    project_id,
    home,
    restore,
  });
}

export async function ensureRestoreStaging({
  account_id,
  handle,
}: {
  account_id?: string;
  handle: RestoreStagingHandle;
}) {
  await assertCollab({ account_id, project_id: handle.project_id });
  await (
    await projectClient(handle.project_id, account_id)
  ).ensureRestoreStaging({
    handle,
  });
}

export async function finalizeRestoreStaging({
  account_id,
  handle,
}: {
  account_id?: string;
  handle: RestoreStagingHandle;
}) {
  await assertCollab({ account_id, project_id: handle.project_id });
  await (
    await projectClient(handle.project_id, account_id)
  ).finalizeRestoreStaging({
    handle,
  });
}

export async function releaseRestoreStaging({
  account_id,
  handle,
  cleanupStaging,
}: {
  account_id?: string;
  handle: RestoreStagingHandle;
  cleanupStaging?: boolean;
}) {
  await assertCollab({ account_id, project_id: handle.project_id });
  await (
    await projectClient(handle.project_id, account_id)
  ).releaseRestoreStaging({
    handle,
    cleanupStaging,
  });
}

export async function cleanupRestoreStaging({
  account_id,
  project_id,
  root,
}: {
  account_id?: string;
  project_id: string;
  root?: string;
}) {
  await assertCollab({ account_id, project_id });
  await (
    await projectClient(project_id, account_id)
  ).cleanupRestoreStaging({
    root,
  });
}

export async function getBackups({
  account_id,
  project_id,
  indexed_only,
}: {
  account_id?: string;
  project_id: string;
  indexed_only?: boolean;
}) {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).getBackups({
    project_id,
    indexed_only,
  });
}

export async function getBackupFiles({
  account_id,
  project_id,
  id,
  path,
}: {
  account_id?: string;
  project_id: string;
  id: string;
  path?: string;
}) {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).getBackupFiles({
    project_id,
    id,
    path,
  });
}

export async function findBackupFiles({
  account_id,
  project_id,
  glob,
  iglob,
  path,
  ids,
}: {
  account_id?: string;
  project_id: string;
  glob?: string[];
  iglob?: string[];
  path?: string;
  ids?: string[];
}) {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).findBackupFiles({
    project_id,
    glob,
    iglob,
    path,
    ids,
  });
}

export async function getBackupFileText({
  account_id,
  project_id,
  id,
  path,
  max_bytes,
}: {
  account_id?: string;
  project_id: string;
  id: string;
  path: string;
  max_bytes?: number;
}) {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).getBackupFileText({
    project_id,
    id,
    path,
    max_bytes,
  });
}

export async function getBackupQuota({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  await assertCollab({ account_id, project_id });
  return { limit: MAX_BACKUPS_PER_PROJECT };
}
