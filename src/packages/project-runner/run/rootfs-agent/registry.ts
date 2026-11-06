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
import { getRootfsMountpoint, isMounted, rootfsIdmapUid } from "../rootfs";
import { RootfsAgentClient } from "./client";
import { hostAgentDeps } from "./host";

const clients = new Map<string, RootfsAgentClient>();

export function rootfsAgentFor(project_id: string): RootfsAgentOps | undefined {
  // a known separate uid only: -1 marks an idmapped mount of unknown uid
  // that is being detached (never a live agent)
  const uid = rootfsIdmapUid(project_id);
  if (uid == null || uid <= 0) return undefined;
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

/**
 * Whether a copy may be installed into the project's rootfs now (B5), from
 * the project's running state and its live mount, never from the mount
 * cache alone:
 * - "agent": running, with a known separate uid: through its agent;
 * - "host": running keep-id, its plain rootfs mounted: as before;
 * - "defer": anything else (stopped, starting, stopping, the -1 marker, a
 *   separate-uid project this daemon hasn't reattached yet, whose plain
 *   path isn't mounted): the copy waits; nothing is written.
 */
export async function rootfsCopyReadiness(
  project_id: string,
  deps: {
    state?: (project_id: string) => Promise<string>;
    isMounted?: (opts: { project_id: string }) => Promise<boolean>;
  } = {},
): Promise<"agent" | "host" | "defer"> {
  const state =
    deps.state ??
    (async (id: string) => await (await import("../podman")).state(id));
  if ((await state(project_id)) !== "running") return "defer";
  const uid = rootfsIdmapUid(project_id);
  if (uid != null) return uid > 0 ? "agent" : "defer";
  return (await (deps.isMounted ?? isMounted)({ project_id }))
    ? "host"
    : "defer";
}

/** For good (e.g. the project left this host). */
export function closeRootfsAgent(project_id: string): void {
  clients.get(project_id)?.close();
  clients.delete(project_id);
}
