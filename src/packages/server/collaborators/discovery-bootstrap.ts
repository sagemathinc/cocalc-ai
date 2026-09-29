/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  readRevisionBootstrap,
  acknowledgeRevisionBootstrap,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import type { CollaborationDiscoveryState } from "@cocalc/util/collaboration-census";
import type { ScanAdmissionResult } from "@cocalc/util/collaboration-scan";

/** Called only after home demand and owner membership were checked and the
 * receiver was armed. Failure leaves the same identity for the next renewal.
 * Admission is finite bootstrap work, not proof of discovery or projection.
 */
export async function bootstrapDemandDiscovery(
  receiver: {
    project_id: string;
    home_bay_id: string;
    owner_bay_id: string;
    lease_id: string;
  },
  operations: {
    discovery: () => Promise<CollaborationDiscoveryState>;
    admit: (request_id: string) => Promise<ScanAdmissionResult>;
  },
): Promise<"disabled" | "done" | "deferred"> {
  if (
    process.env.COCALC_PEOPLE_DISCOVERY_BOOTSTRAP_PROTOTYPE !== "1" ||
    process.env.COCALC_PEOPLE_SCAN_DISPATCH_PROTOTYPE !== "1"
  )
    return "disabled";
  const request_id = await readRevisionBootstrap(receiver);
  if (!request_id) return "done";
  const discovery = await operations.discovery();
  // Existing reports belong to reconciliation/repair, not first discovery.
  // Unavailable without a report may mean a changed host: do not reinterpret it
  // as permission to replace an unknown run here.
  if (discovery.status !== "pending" && !discovery.report) return "deferred";
  if ((await readRevisionBootstrap(receiver)) !== request_id) return "deferred";
  if (discovery.status === "pending" && !discovery.report) {
    const result = await operations.admit(request_id);
    if (result.admission === "throttled") return "deferred";
  }
  return (await acknowledgeRevisionBootstrap({
    ...receiver,
    receiver_id: request_id,
  }))
    ? "done"
    : "deferred";
}
