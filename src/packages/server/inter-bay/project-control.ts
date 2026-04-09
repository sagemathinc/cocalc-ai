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
  ProjectControlRestartRequest,
  ProjectControlStartRequest,
  ProjectControlStateRequest,
  ProjectControlStopRequest,
} from "@cocalc/conat/inter-bay/api";
import getPool from "@cocalc/database/pool";
import { publishLroEvent } from "@cocalc/server/lro/stream";
import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBayDirect } from "@cocalc/server/inter-bay/directory";
import { projectControlSubject } from "@cocalc/server/inter-bay/subjects";
import { getProject } from "@cocalc/server/projects/control";
import { loadProjectReadDetailsDirect } from "@cocalc/server/projects/details";
import {
  clearProjectActiveOperation,
  getProjectActiveOperation,
  upsertProjectActiveOperation,
} from "@cocalc/server/projects/active-operation";
import { resolveVisibleProjectReferenceLocal } from "@cocalc/server/bay-directory";
import { forwardRemoteStartLroProgress } from "@cocalc/server/inter-bay/start-lro-forward";
import isAdmin from "@cocalc/server/accounts/is-admin";
import { assertLocalProjectCollaborator } from "@cocalc/server/conat/project-local-access";
import type { ProjectState } from "@cocalc/util/db-schema/projects";

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

export async function handleProjectControlStart(
  req: ProjectControlStartRequest,
): Promise<void> {
  await assertCurrentProjectOwnership({
    project_id: req.project_id,
    epoch: req.epoch,
  });
  const project = await getProject(req.project_id);
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
  try {
    await project.start({
      account_id: req.account_id,
      lro_op_id: req.lro_op_id,
    });
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
  try {
    await project.restart({
      account_id: req.account_id,
      lro_op_id: req.lro_op_id,
    });
  } finally {
    await stopForward();
    await clearProjectActiveOperation({
      project_id: req.project_id,
      op_id: req.lro_op_id,
    });
  }
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
    return {
      project_id: project.project_id,
      title: project.title,
      host_id: project.host_id,
      owning_bay_id: project.owning_bay_id,
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
  const stateExpected = projectControlSubject({
    dest_bay: getConfiguredBayId(),
    method: "state",
  });
  if (subject === stateExpected) {
    return await handleProjectControlState(
      payload as ProjectControlStateRequest,
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
