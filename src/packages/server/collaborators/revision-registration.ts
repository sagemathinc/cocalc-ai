/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationProjectionRequest } from "@cocalc/conat/inter-bay/collaborators";

/** Only claimed active work supplies candidates; never enumerate memberships.
 * A failed candidate is retried on a later pass, not once per collaborator.
 */
export async function registerProjectionRevisionReceivers(
  jobs: readonly CollaborationProjectionRequest[],
  needsRenewal: (project_id: string) => Promise<boolean>,
  register: (
    job: CollaborationProjectionRequest,
  ) => Promise<{ armed: boolean }>,
): Promise<{ armed: number; deferred: number; failed: number }> {
  if (jobs.length > 8)
    throw Error("revision registration batch limit exceeded");
  const projects = new Set<string>();
  const result = { armed: 0, deferred: 0, failed: 0 };
  for (const job of jobs) {
    if (projects.has(job.project_id)) continue;
    projects.add(job.project_id);
    try {
      if (!(await needsRenewal(job.project_id))) continue;
      if ((await register(job)).armed) result.armed++;
      else result.deferred++;
    } catch {
      // Hints are an optimization. Existing bounded catch-up remains available.
      result.failed++;
    }
  }
  return result;
}
