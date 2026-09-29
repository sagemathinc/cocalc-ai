/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import {
  readRevisionBootstrap,
  acknowledgeRevisionBootstrap,
  readOrCreateRevisionRepair,
  acknowledgeRevisionRepair,
} from "@cocalc/database/postgres/collaborators/collaborators-revision-receiver";
import type { CollaborationDiscoveryState } from "@cocalc/util/collaboration-census";
import type { ScanAdmissionResult } from "@cocalc/util/collaboration-scan";

/** Called only after home demand and owner membership were checked and the
 * receiver was armed. Failure leaves the same identity for the next renewal.
 * Admission covers initial discovery and bounded active-demand repair, never
 * proof of discovery or projection. Cold receivers cannot create repair work.
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
  if (!request_id) {
    const repair_id = await readOrCreateRevisionRepair(receiver);
    if (!repair_id) return "done";
    const result = await operations.admit(repair_id);
    if (result.admission === "throttled") return "deferred";
    return (await acknowledgeRevisionRepair({
      ...receiver,
      request_id: repair_id,
    }))
      ? "done"
      : "deferred";
  }
  const discovery = await operations.discovery();
  // Returning demand must not postpone repair forever by recreating receivers.
  // Report age is a scheduling hint, never proof that source bytes are current.
  const staleReport =
    discovery.report != null &&
    discovery.updated_at != null &&
    Number.isFinite(discovery.updated_at) &&
    discovery.updated_at <= Date.now() - 60 * 60_000;
  // Unavailable without a report may mean a changed host: do not reinterpret it
  // as permission to replace an unknown run here.
  if (discovery.status !== "pending" && !discovery.report) return "deferred";
  if ((await readRevisionBootstrap(receiver)) !== request_id) return "deferred";
  if ((discovery.status === "pending" && !discovery.report) || staleReport) {
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
