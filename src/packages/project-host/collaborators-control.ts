/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { HostControlApi } from "@cocalc/conat/project-host/api";
import type { CollaborationReconciliationRequest } from "@cocalc/util/collaboration-census";
import { isValidUUID } from "@cocalc/util/misc";
import {
  requestHostedCollaborationReconciliation,
  hostedCollaborationReconciliationStatus,
} from "./collaborators";

function validate(opts: CollaborationReconciliationRequest) {
  if (process.env.COCALC_PEOPLE_CENSUS_EXPLICIT_PROTOTYPE !== "1")
    throw Error("explicit collaboration census prototype disabled");
  if (opts?.protocol_version !== 1)
    throw Error("unsupported reconciliation protocol");
  if (
    !isValidUUID(opts.project_id) ||
    !isValidUUID(opts.run_id) ||
    (opts.expected_run_id !== undefined && !isValidUUID(opts.expected_run_id))
  )
    throw Error("invalid reconciliation identity");
}

/** Installed only on the privileged host-control subject. Public Scan actor
 * admission and quotas must be performed by the owner before invoking it.
 */
export const collaborationReconciliationControl: Pick<
  HostControlApi,
  "requestCollaborationReconciliation" | "getCollaborationReconciliationStatus"
> = {
  async requestCollaborationReconciliation(opts) {
    validate(opts);
    return requestHostedCollaborationReconciliation({
      project_id: opts.project_id,
      run_id: opts.run_id,
      expected_run_id: opts.expected_run_id,
    });
  },
  async getCollaborationReconciliationStatus(opts) {
    validate(opts);
    return hostedCollaborationReconciliationStatus({
      project_id: opts.project_id,
      run_id: opts.run_id,
    });
  },
};
