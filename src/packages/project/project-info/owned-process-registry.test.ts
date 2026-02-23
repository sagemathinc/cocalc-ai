/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  closeOwnedProcessRegistry,
  getOwnedProcessRegistry,
  OwnedProcessRegistry,
} from "./owned-process-registry";

describe("OwnedProcessRegistry", () => {
  let registry: OwnedProcessRegistry;

  beforeEach(() => {
    registry = new OwnedProcessRegistry();
  });

  it("registers a root with deterministic id", () => {
    const root = registry.registerRoot({
      root_id: "r-1",
      kind: "terminal",
      path: "a.term",
      thread_id: "t1",
      session_id: "s1",
      spawned_at: 1234,
    });
    expect(root.root_id).toBe("r-1");
    expect(root.kind).toBe("terminal");
    expect(root.path).toBe("a.term");
    expect(root.thread_id).toBe("t1");
    expect(root.session_id).toBe("s1");
    expect(root.spawned_at).toBe(1234);
    expect(registry.listActiveRoots()).toHaveLength(1);
  });

  it("attaches and reattaches pid mapping", () => {
    const root = registry.registerRoot({ root_id: "r-1", kind: "codex" });
    registry.attachPid(root.root_id, 111, 50);
    expect(registry.getRootForPid(111)?.root_id).toBe(root.root_id);
    expect(registry.getRoot(root.root_id)?.start_time).toBe(50);

    registry.attachPid(root.root_id, 222, 70);
    expect(registry.getRootForPid(111)).toBeUndefined();
    expect(registry.getRootForPid(222)?.root_id).toBe(root.root_id);
    expect(registry.getRoot(root.root_id)?.start_time).toBe(70);
  });

  it("marks roots exited and removes pid mapping", () => {
    const root = registry.registerRoot({
      root_id: "r-1",
      kind: "jupyter",
      pid: 300,
      start_time: 12,
    });
    expect(registry.listActiveRoots()).toHaveLength(1);
    registry.markExited(root.root_id, { exited_at: 999 });
    expect(registry.listActiveRoots()).toHaveLength(0);
    expect(registry.getRootForPid(300)).toBeUndefined();
    expect(registry.getRoot(root.root_id)?.exited_at).toBe(999);
  });

  it("removes roots", () => {
    registry.registerRoot({ root_id: "r-1", kind: "exec", pid: 50 });
    registry.removeRoot("r-1");
    expect(registry.getRoot("r-1")).toBeUndefined();
    expect(registry.getRootForPid(50)).toBeUndefined();
  });

  it("throws for unknown attachPid", () => {
    expect(() => registry.attachPid("missing", 1)).toThrow("no such root_id");
  });
});

describe("owned process registry singleton", () => {
  afterEach(() => closeOwnedProcessRegistry());

  it("returns the same singleton", () => {
    const a = getOwnedProcessRegistry();
    const b = getOwnedProcessRegistry();
    expect(a).toBe(b);
    a.registerRoot({ root_id: "x", kind: "terminal" });
    expect(b.getRoot("x")?.kind).toBe("terminal");
  });
});
