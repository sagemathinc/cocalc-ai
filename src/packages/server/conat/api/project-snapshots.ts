import { createLro } from "@cocalc/server/lro/lro-db";
import { publishLroEvent, publishLroSummary } from "@cocalc/server/lro/stream";
import { lroStreamName } from "@cocalc/conat/lro/names";
import { SERVICE as PERSIST_SERVICE } from "@cocalc/conat/persist/util";
import type { LroSummary } from "@cocalc/conat/hub/api/lro";
import { type SnapshotRestoreMode } from "@cocalc/conat/files/file-server";
import { assertCollab } from "./util";
import { getProjectFileServerClient } from "@cocalc/server/conat/file-server-client";
import { assertProjectOwnerCanIncreaseAccountStorage } from "@cocalc/server/membership/project-limits";

// NOTES about snapshots:

// TODO: in some cases we *might* only allow the project owner to delete snapshots
// create a new snapshot of a project

// just *some* limit to avoid bugs/abuse

const MAX_SNAPSHOTS_PER_PROJECT = 250;

async function projectClient(project_id: string, account_id?: string) {
  return await getProjectFileServerClient({ project_id, account_id });
}

async function publishQueuedLroSafe({ op }: { op: LroSummary }) {
  try {
    await publishLroSummary({
      scope_type: op.scope_type,
      scope_id: op.scope_id,
      summary: op,
    });
  } catch {
    // best effort only; worker will publish later summaries
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
  }).catch(() => {});
}

export async function createSnapshot({
  account_id,
  project_id,
  name,
}: {
  account_id?: string;
  project_id: string;
  name?: string;
}) {
  await assertCollab({ account_id, project_id });
  await (
    await projectClient(project_id, account_id)
  ).createSnapshot({
    project_id,
    name,
    limit: MAX_SNAPSHOTS_PER_PROJECT,
  });
}

export async function deleteSnapshot({
  account_id,
  project_id,
  name,
}: {
  account_id?: string;
  project_id: string;
  name: string;
}) {
  await assertCollab({ account_id, project_id });
  await (
    await projectClient(project_id, account_id)
  ).deleteSnapshot({
    project_id,
    name,
  });
}

export async function getSnapshotQuota({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  await assertCollab({ account_id, project_id });
  return { limit: MAX_SNAPSHOTS_PER_PROJECT };
}

export async function allSnapshotUsage({
  account_id,
  project_id,
}: {
  account_id?: string;
  project_id: string;
}) {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).allSnapshotUsage({
    project_id,
  });
}

export async function getSnapshotFileText({
  account_id,
  project_id,
  snapshot,
  path,
  max_bytes,
}: {
  account_id?: string;
  project_id: string;
  snapshot: string;
  path: string;
  max_bytes?: number;
}) {
  await assertCollab({ account_id, project_id });
  return await (
    await projectClient(project_id, account_id)
  ).getSnapshotFileText({
    project_id,
    snapshot,
    path,
    max_bytes,
  });
}

export async function restoreSnapshot({
  account_id,
  project_id,
  snapshot,
  mode,
  safety_snapshot_name,
}: {
  account_id?: string;
  project_id: string;
  snapshot: string;
  mode?: SnapshotRestoreMode;
  safety_snapshot_name?: string;
}): Promise<{
  op_id: string;
  scope_type: "project";
  scope_id: string;
  service: string;
  stream_name: string;
}> {
  await assertCollab({ account_id, project_id });
  await assertProjectOwnerCanIncreaseAccountStorage({ project_id });
  const restoreMode = mode ?? "both";
  if (!["both", "home", "rootfs"].includes(restoreMode)) {
    throw new Error(`invalid snapshot restore mode: ${mode}`);
  }
  const op = await createLro({
    kind: "project-restore",
    scope_type: "project",
    scope_id: project_id,
    created_by: account_id,
    routing: "hub",
    input: {
      project_id,
      restore_type: "snapshot",
      snapshot,
      mode: restoreMode,
      safety_snapshot_name,
    },
    status: "queued",
  });
  await publishQueuedLroSafe({ op });
  return {
    op_id: op.op_id,
    scope_type: "project",
    scope_id: project_id,
    service: PERSIST_SERVICE,
    stream_name: lroStreamName(op.op_id),
  };
}
