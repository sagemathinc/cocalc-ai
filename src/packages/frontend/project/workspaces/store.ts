/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  openWorkspaceStore,
  type WorkspaceStore,
} from "@cocalc/conat/workspaces";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export const WORKSPACE_STORE_ROUTING_RETRY_DELAY_MS = 250;

export async function openProjectWorkspaceStore(opts: {
  project_id: string;
  account_id: string;
  caller: string;
}): Promise<WorkspaceStore> {
  const client = await webapp_client.conat_client.projectConat({
    project_id: opts.project_id,
    caller: opts.caller,
    requireRouting: true,
  });
  return await openWorkspaceStore({
    client,
    account_id: opts.account_id,
    project_id: opts.project_id,
  });
}

export function isWorkspaceStoreRoutingPendingError(err: unknown): boolean {
  const message =
    err instanceof Error
      ? err.message.toLowerCase()
      : `${err ?? ""}`.toLowerCase();
  return (
    message.includes("unable to route") &&
    message.includes("project-host") &&
    (message.includes("host routing info unavailable") ||
      message.includes("project host id unavailable"))
  );
}
