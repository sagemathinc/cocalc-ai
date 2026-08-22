/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setProjectNetworkPolicy,
  type ProjectNetworkPolicy,
  verifyProjectNetworkPolicy,
} from "../network-policy";

export type ExamProjectNetworkPolicy = ProjectNetworkPolicy;

export async function setExamProjectNetworkPolicy({
  project_id,
  policy,
}: {
  project_id: string;
  policy: ExamProjectNetworkPolicy;
}): Promise<void> {
  await setProjectNetworkPolicy({ project_id, policy });
}

export async function verifyExamProjectNetworkPolicy({
  project_id,
  policy,
}: {
  project_id: string;
  policy: ExamProjectNetworkPolicy;
}): Promise<void> {
  await verifyProjectNetworkPolicy({ project_id, policy });
}
