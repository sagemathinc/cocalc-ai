/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  beginProjectFence,
  closeProjectSockets,
  endProjectFence,
  enterProjectOpen,
  isProjectFenced,
  projectOfStoragePath,
  projectReplacedInstance,
  registerProjectSocket,
  resetProjectFences,
  waitForProjectOpens,
} from "./project-fence";
import { PersistStreamReleaseQueue } from "./release-queue";
import { assertCurrentInstance } from "./server";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  resetProjectFences();
});

describe("projectOfStoragePath", () => {
  it("is the project of a project storage path", () => {
    expect(projectOfStoragePath(`projects/${P}/a/b`)).toBe(P);
    expect(projectOfStoragePath(`projects/${P}`)).toBe(P);
    expect(projectOfStoragePath(`accounts/${P}/a`)).toBeUndefined();
    expect(projectOfStoragePath(`hub/projects/${P}/a`)).toBeUndefined();
    expect(projectOfStoragePath(undefined)).toBeUndefined();
  });
});

describe("project fences", () => {
  it("opens of a fenced project wait until it is released", async () => {
    beginProjectFence(P, "t1");
    let entered = false;
    const opening = enterProjectOpen(P).then((leave) => {
      entered = true;
      return leave;
    });
    // another project is not affected
    (await enterProjectOpen(Q))();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(entered).toBe(false);
    expect(endProjectFence(P, "t1", { replaced: false })).toBe(true);
    (await opening)();
    expect(entered).toBe(true);
  });

  it("an open that waits too long fails with a retryable error", async () => {
    beginProjectFence(P, "t1");
    await expect(enterProjectOpen(P, { waitMs: 20 })).rejects.toMatchObject({
      code: 503,
    });
  });

  it("another token cannot take or release a held fence", () => {
    beginProjectFence(P, "t1");
    expect(() => beginProjectFence(P, "t2")).toThrow("already fenced");
    // the same token may acquire again
    beginProjectFence(P, "t1");
    expect(endProjectFence(P, "t2", { replaced: true })).toBe(false);
    expect(isProjectFenced(P)).toBe(true);
    expect(projectReplacedInstance(P)).toBeUndefined();
  });

  it("a release after a replacement gives the project a new instance", () => {
    beginProjectFence(P, "t1");
    endProjectFence(P, "t1", { replaced: true });
    const first = projectReplacedInstance(P);
    expect(first).toEqual(expect.any(String));
    beginProjectFence(P, "t2");
    endProjectFence(P, "t2", { replaced: true });
    const second = projectReplacedInstance(P);
    expect(second).not.toBe(first);
    beginProjectFence(P, "t3");
    endProjectFence(P, "t3", { replaced: false });
    expect(projectReplacedInstance(P)).toBe(second);
    expect(projectReplacedInstance(Q)).toBeUndefined();
  });

  it("waits for opens under way", async () => {
    const leave = await enterProjectOpen(P);
    beginProjectFence(P, "t1");
    expect(await waitForProjectOpens(P, 10)).toBe(false);
    const waiting = waitForProjectOpens(P, 5000);
    leave();
    expect(await waiting).toBe(true);
    expect(await waitForProjectOpens(Q, 0)).toBe(true);
  });

  it("closes the project's registered sockets, not others", () => {
    const closed: string[] = [];
    registerProjectSocket(P, () => closed.push("p1"));
    const unregister = registerProjectSocket(P, () => closed.push("p2"));
    registerProjectSocket(Q, () => closed.push("q"));
    unregister();
    expect(closeProjectSockets(P)).toBe(1);
    expect(closed).toEqual(["p1"]);
  });
});

describe("PersistStreamReleaseQueue.releaseMatching", () => {
  it("releases matching streams now, and leaves the others to their grace", async () => {
    const queue = new PersistStreamReleaseQueue({ graceMs: 60_000 });
    const closed: string[] = [];
    const stream = (name: string) => ({
      name,
      close: () => closed.push(name),
    });
    queue.schedule(stream("a"));
    queue.schedule(stream("b"));
    queue.schedule(stream("a"));
    await queue.releaseMatching((s) => (s as any).name == "a");
    expect(closed).toEqual(["a", "a"]);
    expect(queue.diagnostics().pending).toBe(1);
    await queue.drain();
    expect(closed).toEqual(["a", "a", "b"]);
  });
});

describe("assertCurrentInstance", () => {
  const check = (claimed?: unknown, replacedInstance?: string) => () =>
    assertCurrentInstance({ replacedInstance, claimed });

  it("allows any write to a stream whose files were never replaced", () => {
    expect(check("", undefined)).not.toThrow();
    expect(check("old", undefined)).not.toThrow();
  });

  it("refuses a write from a client that saw another instance, saying which is current", () => {
    expect(check("", "R")).toThrow("history was replaced");
    expect(check("old", "R")).toThrow("history was replaced");
    try {
      check("", "R")();
    } catch (err) {
      expect((err as any).code).toBe(409);
      expect((err as any).instance).toBe("R");
    }
  });

  it("allows the current instance, a client that has not read, and a client from before instances", () => {
    expect(check("R", "R")).not.toThrow();
    expect(check("*", "R")).not.toThrow();
    expect(check(undefined, "R")).not.toThrow();
  });
});
