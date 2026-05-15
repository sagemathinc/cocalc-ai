/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import type {
  ForwardProjectLroProgressRequest,
  GetProjectDetailsRequest,
  GetProjectReferenceRequest,
  ProjectDetails,
  ProjectReference,
  ProjectControlActiveOperationRequest,
  ProjectControlAddressRequest,
  ProjectControlAcceptRehomeRequest,
  ProjectControlBackupRequest,
  ProjectControlMoveRequest,
  ProjectControlMoveResponse,
  ProjectControlRehomeRequest,
  ProjectControlRehomeResponse,
  ProjectControlRestartRequest,
  ProjectControlSetUsageAccountRequest,
  ProjectControlSetUsageAccountResponse,
  ProjectControlStartRequest,
  ProjectControlStateRequest,
  ProjectControlStopRequest,
} from "@cocalc/conat/inter-bay/api";
import type { LroStatus, LroSummary } from "@cocalc/conat/hub/api/lro";
import getLogger from "@cocalc/backend/logger";
import getPool from "@cocalc/database/pool";
import { publishLroEvent } from "@cocalc/server/lro/stream";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import { projectControlSubject } from "@cocalc/server/inter-bay/subjects";
import { getProject } from "@cocalc/server/projects/control";
import { loadProjectReadDetailsDirect } from "@cocalc/server/projects/details";
import { moveProject as moveProjectLocal } from "@cocalc/server/conat/api/projects";
import { PROJECT_DANGEROUS_INTERNAL_AUTH } from "@cocalc/server/conat/api/project-dangerous-auth";
import {
  clearProjectActiveOperation,
  getProjectActiveOperation,
  upsertProjectActiveOperation,
} from "@cocalc/server/projects/active-operation";
import { resolveVisibleProjectReferenceLocal } from "@cocalc/server/bay-directory";
import { forwardRemoteStartLroProgress } from "@cocalc/server/inter-bay/start-lro-forward";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import { setProjectUsageAccountId } from "@cocalc/server/membership/project-usage";
import type { ProjectState } from "@cocalc/util/db-schema/projects";
import {
  canActorStartUsingRuntimeSponsor,
  collaboratorSponsorStartDisabledError,
  resolveRuntimeSponsorAccountId,
} from "@cocalc/server/projects/runtime-sponsor";
import {
  heartbeatProjectRuntimeSlot,
  releaseProjectRuntimeSlot,
  reserveProjectRuntimeSlot,
} from "@cocalc/server/projects/runtime-slots";
import { createBackup as createBackupLocal } from "@cocalc/server/conat/api/project-backups";
import { getLro } from "@cocalc/server/lro/lro-db";
import { BACKUP_TIMEOUT_MS } from "@cocalc/server/projects/backup-lro";
import { sleep } from "@cocalc/util/async-utils";
import {
  acceptProjectRehome,
  rehomeProjectOnOwningBay,
} from "@cocalc/server/projects/rehome";

const LRO_TERMINAL_STATUSES = new Set<LroStatus>([
  "succeeded",
  "failed",
  "canceled",
  "expired",
]);
const BACKUP_POLL_INTERVAL_MS = 1_000;
const PROJECT_RUNTIME_SLOT_TTL_MS = 30 * 60 * 1000;
const logger = getLogger("inter-bay:project-control");

function staleRoutingError({
  project_id,
  expected_bay,
  actual_bay,
  expected_epoch,
  actual_epoch,
}: {
  project_id: string;
  expected_bay: string;
  actual_bay: string;
  expected_epoch?: number;
  actual_epoch?: number;
}): Error {
  return new Error(
    `stale project routing for ${project_id}: expected bay=${expected_bay}, epoch=${expected_epoch}, actual bay=${actual_bay}, epoch=${actual_epoch}`,
  );
}

async function assertCurrentProjectOwnership({
  project_id,
  epoch,
}: {
  project_id: string;
  epoch?: number;
}): Promise<void> {
  const ownership = await resolveProjectBayDirect(project_id);
  if (ownership == null) {
    throw new Error(`project ${project_id} not found`);
  }
  const currentBayId = getConfiguredBayId();
  if (
    ownership.bay_id !== currentBayId ||
    (epoch != null && ownership.epoch !== epoch)
  ) {
    throw staleRoutingError({
      project_id,
      expected_bay: epoch != null ? currentBayId : ownership.bay_id,
      actual_bay: ownership.bay_id,
      expected_epoch: epoch,
      actual_epoch: ownership.epoch,
    });
  }
}

async function loadProjectRuntimeSponsor(project_id: string): Promise<{
  sponsor_account_id: string;
  owning_bay_id: string;
  host_id?: string | null;
  users?: Record<string, { group?: string }> | null;
  allow_collaborator_starts_using_sponsor?: boolean | null;
}> {
  const { rows } = await getPool().query<{
    runtime_sponsor_account_id?: string | null;
    usage_account_id?: string | null;
    allow_collaborator_starts_using_sponsor?: boolean | null;
    users?: Record<string, { group?: string }> | null;
    owning_bay_id?: string | null;
    host_id?: string | null;
  }>(
    `
      SELECT runtime_sponsor_account_id, usage_account_id,
             allow_collaborator_starts_using_sponsor, users,
             owning_bay_id, host_id
        FROM projects
       WHERE project_id=$1
       LIMIT 1
    `,
    [project_id],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(`project ${project_id} not found`);
  }
  const sponsor_account_id = resolveRuntimeSponsorAccountId(row);
  if (!sponsor_account_id) {
    throw new Error(`project ${project_id} has no runtime sponsor`);
  }
  return {
    sponsor_account_id,
    owning_bay_id: row.owning_bay_id ?? getConfiguredBayId(),
    host_id: row.host_id ?? null,
    users: row.users,
    allow_collaborator_starts_using_sponsor:
      row.allow_collaborator_starts_using_sponsor,
  };
}

async function assertCanStartUsingRuntimeSponsor({
  sponsor,
  account_id,
}: {
  sponsor: Awaited<ReturnType<typeof loadProjectRuntimeSponsor>>;
  account_id?: string;
}): Promise<void> {
  const is_admin = account_id ? await isAdmin(account_id) : false;
  if (
    !canActorStartUsingRuntimeSponsor({
      project: sponsor,
      actor_account_id: account_id,
      sponsor_account_id: sponsor.sponsor_account_id,
      is_admin,
    })
  ) {
    throw collaboratorSponsorStartDisabledError();
  }
}

export async function handleProjectControlStart(
  req: ProjectControlStartRequest,
): Promise<void> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const project = await getProject(req.project_id);
  const sponsor = await loadProjectRuntimeSponsor(req.project_id);
  await upsertProjectActiveOperation({
    project_id: req.project_id,
    op_id: req.lro_op_id,
    kind: "project-start",
    action: "start",
    status: "running",
    started_by_account_id: req.account_id,
    source_bay_id: req.source_bay_id,
    phase: "queued",
    message: "queued",
    progress: 0,
  });
  const stopForward = await forwardRemoteStartLroProgress({
    project_id: req.project_id,
    op_id: req.lro_op_id,
    source_bay_id: req.source_bay_id,
  });
  let reservedSlot = false;
  try {
    await assertCanStartUsingRuntimeSponsor({
      sponsor,
      account_id: req.account_id,
    });
    await reserveProjectRuntimeSlot({
      ...sponsor,
      project_id: req.project_id,
      actor_account_id: req.account_id,
      reason: "project-start",
      op_id: req.lro_op_id,
      state: "starting",
      ttl_ms: PROJECT_RUNTIME_SLOT_TTL_MS,
    });
    reservedSlot = true;
    await project.start({
      account_id: req.account_id,
      lro_op_id: req.lro_op_id,
      managed_egress_override: req.managed_egress_override,
      restore_backup_id: req.restore_backup_id,
    });
    await heartbeatProjectRuntimeSlot({
      sponsor_account_id: sponsor.sponsor_account_id,
      project_id: req.project_id,
      host_id: sponsor.host_id,
      state: "running",
      ttl_ms: PROJECT_RUNTIME_SLOT_TTL_MS,
    });
  } catch (err) {
    if (reservedSlot) {
      await releaseProjectRuntimeSlot({
        sponsor_account_id: sponsor.sponsor_account_id,
        project_id: req.project_id,
        state: "failed",
      }).catch((releaseErr) => {
        logger.warn("failed to release runtime slot after start error", {
          project_id: req.project_id,
          sponsor_account_id: sponsor.sponsor_account_id,
          err: `${releaseErr}`,
        });
      });
    }
    throw err;
  } finally {
    await stopForward();
    await clearProjectActiveOperation({
      project_id: req.project_id,
      op_id: req.lro_op_id,
    });
  }
}

export async function handleProjectControlStop(
  req: ProjectControlStopRequest,
): Promise<void> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const project = await getProject(req.project_id);
  const sponsor = await loadProjectRuntimeSponsor(req.project_id);
  await upsertProjectActiveOperation({
    project_id: req.project_id,
    kind: "project-stop",
    action: "stop",
    status: "running",
    phase: "stop-project",
    message: "stopping project",
  });
  try {
    await project.stop();
    await releaseProjectRuntimeSlot({
      sponsor_account_id: sponsor.sponsor_account_id,
      project_id: req.project_id,
    });
  } finally {
    await clearProjectActiveOperation({
      project_id: req.project_id,
    });
  }
}

export async function handleProjectControlRestart(
  req: ProjectControlRestartRequest,
): Promise<void> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const project = await getProject(req.project_id);
  const sponsor = await loadProjectRuntimeSponsor(req.project_id);
  await upsertProjectActiveOperation({
    project_id: req.project_id,
    op_id: req.lro_op_id,
    kind: "project-start",
    action: "restart",
    status: "running",
    started_by_account_id: req.account_id,
    source_bay_id: req.source_bay_id,
    phase: "queued",
    message: "queued",
    progress: 0,
  });
  const stopForward = await forwardRemoteStartLroProgress({
    project_id: req.project_id,
    op_id: req.lro_op_id,
    source_bay_id: req.source_bay_id,
  });
  let reservedSlot = false;
  try {
    await assertCanStartUsingRuntimeSponsor({
      sponsor,
      account_id: req.account_id,
    });
    await reserveProjectRuntimeSlot({
      ...sponsor,
      project_id: req.project_id,
      actor_account_id: req.account_id,
      reason: "project-restart",
      op_id: req.lro_op_id,
      state: "starting",
      ttl_ms: PROJECT_RUNTIME_SLOT_TTL_MS,
    });
    reservedSlot = true;
    await project.restart({
      account_id: req.account_id,
      lro_op_id: req.lro_op_id,
    });
    await heartbeatProjectRuntimeSlot({
      sponsor_account_id: sponsor.sponsor_account_id,
      project_id: req.project_id,
      host_id: sponsor.host_id,
      state: "running",
      ttl_ms: PROJECT_RUNTIME_SLOT_TTL_MS,
    });
  } catch (err) {
    if (reservedSlot) {
      await releaseProjectRuntimeSlot({
        sponsor_account_id: sponsor.sponsor_account_id,
        project_id: req.project_id,
        state: "failed",
      }).catch((releaseErr) => {
        logger.warn("failed to release runtime slot after restart error", {
          project_id: req.project_id,
          sponsor_account_id: sponsor.sponsor_account_id,
          err: `${releaseErr}`,
        });
      });
    }
    throw err;
  } finally {
    await stopForward();
    await clearProjectActiveOperation({
      project_id: req.project_id,
      op_id: req.lro_op_id,
    });
  }
}

export async function handleProjectControlBackup(
  req: ProjectControlBackupRequest,
): Promise<LroSummary> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const op = await createBackupLocal(
    {
      account_id: req.account_id,
      project_id: req.project_id,
      tags: req.tags,
    },
    {
      skip_collab_check: true,
      skip_owner_route: true,
      managed_egress_override: req.managed_egress_override,
    },
  );
  const deadline = Date.now() + BACKUP_TIMEOUT_MS + 60_000;
  while (Date.now() < deadline) {
    const summary = await getLro(op.op_id);
    if (summary != null && LRO_TERMINAL_STATUSES.has(summary.status)) {
      return summary;
    }
    await sleep(BACKUP_POLL_INTERVAL_MS, { unref: true });
  }
  throw new Error(
    `timed out waiting for backup operation ${op.op_id} on project ${req.project_id}`,
  );
}

export async function handleProjectControlState(
  req: ProjectControlStateRequest,
) {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const { rows } = await getPool().query<{ state: ProjectState | null }>(
    "SELECT state FROM projects WHERE project_id=$1 LIMIT 1",
    [req.project_id],
  );
  return rows[0]?.state ?? {};
}

export async function handleProjectControlSetUsageAccount(
  req: ProjectControlSetUsageAccountRequest,
): Promise<ProjectControlSetUsageAccountResponse> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  return {
    updated: await setProjectUsageAccountId({
      project_id: req.project_id,
      account_id: req.usage_account_id ?? null,
      expected_current_usage_account_id: req.expected_current_usage_account_id,
    }),
  };
}

export async function handleProjectControlAddress(
  req: ProjectControlAddressRequest,
) {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const project = await getProject(req.project_id);
  return await project.address({
    account_id: req.account_id,
  });
}

export async function handleProjectControlMove(
  req: ProjectControlMoveRequest,
): Promise<ProjectControlMoveResponse> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  return await moveProjectLocal({
    account_id: req.account_id,
    session_hash: req.session_hash,
    internalAuth: PROJECT_DANGEROUS_INTERNAL_AUTH,
    project_id: req.project_id,
    dest_host_id: req.dest_host_id,
    allow_offline: req.allow_offline,
    backup_region_cutover: req.backup_region_cutover,
  });
}

export async function handleProjectControlRehome(
  req: ProjectControlRehomeRequest,
): Promise<ProjectControlRehomeResponse> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  return await rehomeProjectOnOwningBay({
    account_id: req.account_id,
    project_id: req.project_id,
    dest_bay_id: req.dest_bay_id,
    reason: req.reason,
    campaign_id: req.campaign_id,
  });
}

export async function handleProjectControlAcceptRehome(
  req: ProjectControlAcceptRehomeRequest,
): Promise<ProjectControlRehomeResponse> {
  return await acceptProjectRehome({
    account_id: req.account_id,
    project_id: req.project_id,
    source_bay_id: req.source_bay_id,
    dest_bay_id: req.dest_bay_id,
    project: req.project,
    portable_state: req.portable_state,
  });
}

export async function handleProjectControlActiveOperation(
  req: ProjectControlActiveOperationRequest,
) {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  return await getProjectActiveOperation({
    project_id: req.project_id,
  });
}

export async function handleProjectReferenceGet(
  req: GetProjectReferenceRequest,
): Promise<ProjectReference | null> {
  try {
    const project = await resolveVisibleProjectReferenceLocal({
      account_id: req.account_id,
      project_id: req.project_id,
    });
    const { rows } = await getPool().query<{
      users: Record<string, any> | null;
    }>(
      `
        SELECT COALESCE(users, '{}'::jsonb) AS users
        FROM projects
        WHERE project_id = $1
          AND deleted IS NOT TRUE
        LIMIT 1
      `,
      [req.project_id],
    );
    return {
      project_id: project.project_id,
      title: project.title,
      host_id: project.host_id,
      owning_bay_id: project.owning_bay_id,
      users: rows[0]?.users ?? {},
    };
  } catch {
    return null;
  }
}

async function assertLocalProjectReadAccessOrAdmin({
  account_id,
  project_id,
}: {
  account_id: string;
  project_id: string;
}): Promise<void> {
  try {
    await assertLocalProjectCollaborator({ account_id, project_id });
  } catch (err) {
    if (!(await isAdmin(account_id))) {
      throw err;
    }
  }
}

export async function handleProjectDetailsGet(
  req: GetProjectDetailsRequest,
): Promise<ProjectDetails> {
  await assertLocalProjectReadAccessOrAdmin({
    account_id: req.account_id,
    project_id: req.project_id,
  });
  const details = await loadProjectReadDetailsDirect(req.project_id);
  if (details == null) {
    throw new Error(`project ${req.project_id} not found`);
  }
  return details;
}

export async function handleProjectLroPublishProgress(
  req: ForwardProjectLroProgressRequest,
): Promise<void> {
  await publishLroEvent({
    scope_type: "project",
    scope_id: req.project_id,
    op_id: req.op_id,
    event: req.event,
  });
}

export async function dispatchProjectControlRpc(
  subject: string,
  payload: unknown,
): Promise<unknown> {
  const expected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "start",
  });
  if (subject === expected) {
    await handleProjectControlStart(payload as ProjectControlStartRequest);
    return null;
  }
  const stopExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "stop",
  });
  if (subject === stopExpected) {
    await handleProjectControlStop(payload as ProjectControlStopRequest);
    return null;
  }
  const restartExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "restart",
  });
  if (subject === restartExpected) {
    await handleProjectControlRestart(payload as ProjectControlRestartRequest);
    return null;
  }
  const backupExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "backup",
  });
  if (subject === backupExpected) {
    return await handleProjectControlBackup(
      payload as ProjectControlBackupRequest,
    );
  }
  const stateExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "state",
  });
  if (subject === stateExpected) {
    return await handleProjectControlState(
      payload as ProjectControlStateRequest,
    );
  }
  const setUsageAccountExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "set-usage-account",
  });
  if (subject === setUsageAccountExpected) {
    return await handleProjectControlSetUsageAccount(
      payload as ProjectControlSetUsageAccountRequest,
    );
  }
  const addressExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "address",
  });
  if (subject === addressExpected) {
    return await handleProjectControlAddress(
      payload as ProjectControlAddressRequest,
    );
  }
  const moveExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "move",
  });
  if (subject === moveExpected) {
    return await handleProjectControlMove(payload as ProjectControlMoveRequest);
  }
  const rehomeExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "rehome",
  });
  if (subject === rehomeExpected) {
    return await handleProjectControlRehome(
      payload as ProjectControlRehomeRequest,
    );
  }
  const acceptRehomeExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "accept-rehome",
  });
  if (subject === acceptRehomeExpected) {
    return await handleProjectControlAcceptRehome(
      payload as ProjectControlAcceptRehomeRequest,
    );
  }
  const activeOpExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "active-op",
  });
  if (subject === activeOpExpected) {
    return await handleProjectControlActiveOperation(
      payload as ProjectControlActiveOperationRequest,
    );
  }
  throw new Error(`unknown project-control subject: ${subject}`);
}
