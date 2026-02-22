/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setProcessTracker,
  type ProcessRootMeta,
} from "@cocalc/backend/process-tracker";
import { getOwnedProcessRegistry } from "./owned-process-registry";

let installed = false;

function createTrackedRoot(meta: ProcessRootMeta) {
  const registry = getOwnedProcessRegistry();
  const root = registry.registerRoot({
    kind: meta.kind,
    path: meta.path,
    thread_id: meta.thread_id,
    session_id: meta.session_id,
  });
  let closed = false;
  return {
    attachPid(pid: number, start_time?: number) {
      if (closed) return;
      registry.attachPid(root.root_id, pid, start_time);
    },
    markExited(opts?: { pid?: number; exited_at?: number }) {
      if (closed) return;
      registry.markExited(root.root_id, opts);
    },
    close() {
      if (closed) return;
      closed = true;
      registry.removeRoot(root.root_id);
    },
  };
}

export function ensureBackendOwnedRootBridge() {
  if (installed) return;
  installed = true;
  setProcessTracker(createTrackedRoot);
}

