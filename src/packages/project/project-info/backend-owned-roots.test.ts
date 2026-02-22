/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { trackProcessRoot } from "@cocalc/backend/process-tracker";
import { ensureBackendOwnedRootBridge } from "./backend-owned-roots";
import {
  closeOwnedProcessRegistry,
  getOwnedProcessRegistry,
} from "./owned-process-registry";

describe("backend owned roots bridge", () => {
  afterEach(() => {
    closeOwnedProcessRegistry();
  });

  it("registers tracked roots via backend process tracker", () => {
    ensureBackendOwnedRootBridge();
    const tracked = trackProcessRoot({
      kind: "exec",
      path: "code/main.py",
      session_id: "job-1",
    });
    tracked.attachPid(9001);

    const registry = getOwnedProcessRegistry();
    const root = registry.getRootForPid(9001);
    expect(root?.kind).toBe("exec");
    expect(root?.path).toBe("code/main.py");
    expect(root?.session_id).toBe("job-1");

    tracked.markExited({ pid: 9001 });
    expect(root?.exited_at).toBeDefined();
    tracked.close();
    expect(registry.listRoots()).toHaveLength(0);
  });
});

