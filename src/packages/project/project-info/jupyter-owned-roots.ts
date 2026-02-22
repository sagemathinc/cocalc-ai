/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  setKernelLifecycleObserver,
  type KernelLifecycleEvent,
} from "@cocalc/jupyter/kernel";
import { getOwnedProcessRegistry } from "./owned-process-registry";

let installed = false;
const kernelRootByIdentity = new Map<string, string>();

function onKernelLifecycle(event: KernelLifecycleEvent) {
  const registry = getOwnedProcessRegistry();
  switch (event.event) {
    case "spawn": {
      let root_id = kernelRootByIdentity.get(event.identity);
      if (root_id == null || registry.getRoot(root_id) == null) {
        root_id = registry.registerRoot({
          kind: "jupyter",
          path: event.path,
          session_id: event.identity,
        }).root_id;
        kernelRootByIdentity.set(event.identity, root_id);
      }
      registry.attachPid(root_id, event.pid);
      return;
    }
    case "exit": {
      const root_id = kernelRootByIdentity.get(event.identity);
      if (root_id == null) return;
      registry.markExited(root_id, { pid: event.pid });
      return;
    }
    case "close": {
      const root_id = kernelRootByIdentity.get(event.identity);
      if (root_id == null) return;
      registry.markExited(root_id, { pid: event.pid });
      registry.removeRoot(root_id);
      kernelRootByIdentity.delete(event.identity);
      return;
    }
  }
}

export function ensureJupyterOwnedRootBridge() {
  if (installed) return;
  installed = true;
  setKernelLifecycleObserver(onKernelLifecycle);
}

