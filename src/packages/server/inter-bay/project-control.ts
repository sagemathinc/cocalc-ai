/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { getConfiguredBayId } from "@cocalc/server/bay-config";
import { resolveProjectBay } from "@cocalc/server/inter-bay/directory";
import { projectControlSubject } from "@cocalc/server/inter-bay/subjects";
import { getProject } from "@cocalc/server/projects/control";

export interface ProjectControlStartRequest {
  project_id: string;
  account_id: string;
  lro_op_id?: string;
  epoch?: number;
}

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

export async function handleProjectControlStart(
  req: ProjectControlStartRequest,
): Promise<void> {
  const ownership = await resolveProjectBay(req.project_id);
  if (ownership == null) {
    throw new Error(`project ${req.project_id} not found`);
  }
  const currentBayId = getConfiguredBayId();
  if (
    ownership.bay_id !== currentBayId ||
    (req.epoch != null && ownership.epoch !== req.epoch)
  ) {
    throw staleRoutingError({
      project_id: req.project_id,
      expected_bay: req.epoch != null ? currentBayId : ownership.bay_id,
      actual_bay: ownership.bay_id,
      expected_epoch: req.epoch,
      actual_epoch: ownership.epoch,
    });
  }
  const project = await getProject(req.project_id);
  await project.start({
    account_id: req.account_id,
    lro_op_id: req.lro_op_id,
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
  throw new Error(`unknown project-control subject: ${subject}`);
}
