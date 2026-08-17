/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { dkv } from "@cocalc/conat/sync/dkv";
import type { AccountProjectListWindowRow } from "@cocalc/conat/hub/api/projects";

import { openProjectHost, type SiteSession } from "./site-session";

export interface TransportProofResult {
  ping_ms: number;
  project: AccountProjectListWindowRow;
  host_id: string;
  host_address: string;
  agent_session_rows: number;
}

export async function runTransportProof(
  session: SiteSession,
): Promise<TransportProofResult> {
  const started = Date.now();
  await session.hubApi.system.ping();
  const ping_ms = Date.now() - started;
  const projects = await session.hubApi.projects.listAccountProjectWindow({
    limit: 20,
    offset: 0,
    hidden: false,
    sort: "last_edited",
  });
  const project = projects.find((candidate) => candidate.host_id != null);
  if (!project?.host_id) {
    throw new Error(
      "No visible project with an assigned host is available for the transport proof.",
    );
  }
  const lease = await openProjectHost(session, {
    project_id: project.project_id,
    host_id: project.host_id,
  });
  const store = await dkv({
    client: lease.client,
    project_id: project.project_id,
    name: "cocalc-agent-sessions-v1",
    noInventory: true,
  });
  try {
    return {
      ping_ms,
      project,
      host_id: lease.host_id,
      host_address: lease.address,
      agent_session_rows: Object.keys(store.getAll()).length,
    };
  } finally {
    store.close();
  }
}
