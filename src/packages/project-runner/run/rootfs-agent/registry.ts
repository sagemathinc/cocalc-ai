/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
One rootfs agent client per project, for the sandboxes project-host builds.

rootfsSandboxOptions() is what a sandbox for a project gets: its rootfs
mountpoint, and a getter for the agent that is asked on every call. The
agent exists only while the project's rootfs is mounted for a separate
runtime uid; for any other project the getter answers undefined and the
sandbox works on the host as before. A cached sandbox therefore follows the
project from one mode to the other, and a client checks its container
generation before every request.
*/

import {
  rootfsNotAvailableError,
  type RootfsAgentOps,
} from "@cocalc/backend/sandbox/rootfs-agent-routes";
import { getRootfsMountpoint, rootfsIdmapUid } from "../rootfs";
import { RootfsAgentClient } from "./client";
import { hostAgentDeps } from "./host";

const clients = new Map<string, RootfsAgentClient>();

export function rootfsAgentFor(project_id: string): RootfsAgentOps | undefined {
  if (rootfsIdmapUid(project_id) == null) return undefined;
  let client = clients.get(project_id);
  if (client == null) {
    client = new RootfsAgentClient(project_id, hostAgentDeps(project_id));
    clients.set(project_id, client);
  }
  const bound = client;
  return {
    call: async (op, args, data) => await bound.request(op, args, data),
  };
}

export function rootfsSandboxOptions(project_id: string): {
  rootfs: string;
  rootfsAgent: () => RootfsAgentOps | undefined;
} {
  return {
    rootfs: getRootfsMountpoint(project_id),
    rootfsAgent: () => rootfsAgentFor(project_id),
  };
}

// For the viewer, API-key viewer and public share servers: their requests
// never start an agent. A separate-uid project's rootfs is refused there.
const REFUSING: RootfsAgentOps = {
  call: async (_op, args) => {
    throw rootfsNotAvailableError(`${args.path ?? ""}`);
  },
};

export function rootfsSandboxOptionsWithoutAgent(project_id: string): {
  rootfs: string;
  rootfsAgent: () => RootfsAgentOps | undefined;
} {
  return {
    rootfs: getRootfsMountpoint(project_id),
    rootfsAgent: () =>
      rootfsIdmapUid(project_id) == null ? undefined : REFUSING,
  };
}

/** For good (e.g. the project left this host). */
export function closeRootfsAgent(project_id: string): void {
  clients.get(project_id)?.close();
  clients.delete(project_id);
}
