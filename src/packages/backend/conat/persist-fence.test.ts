/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentFenceHolder,
  describeFenceHolder,
  fenceCapableServerRunning,
  fileFenceStore,
  isFenceHolderAlive,
  persistServerHasFeature,
  removeFenceCapability,
  writeFenceCapability,
} from "./persist-fence";

const P = "11111111-1111-4111-8111-111111111111";
const Q = "22222222-2222-4222-8222-222222222222";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "persist-fence-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("fence holders", () => {
  it("this process is alive, with its start time", () => {
    const holder = currentFenceHolder();
    expect(holder.pid).toBe(process.pid);
    expect(holder.start).not.toBe("");
    expect(isFenceHolderAlive(holder)).toBe(true);
  });

  it("another process with the same pid is not the holder", () => {
    expect(isFenceHolderAlive({ pid: process.pid, start: "1" })).toBe(false);
  });

  it("a process that does not exist is not alive", () => {
    expect(isFenceHolderAlive({ pid: 2 ** 22 + 17, start: "" })).toBe(false);
    expect(isFenceHolderAlive({ pid: 0, start: "" })).toBe(false);
  });
});

describe("fileFenceStore", () => {
  it("saves, loads and removes fences, one file per project", () => {
    const store = fileFenceStore(dir);
    expect(store.load()).toEqual([]);
    const record = {
      project_id: P,
      token: "t1",
      holder: { pid: 10, start: "5" },
      since: 1000,
    };
    store.save(record);
    store.save({ ...record, project_id: Q, token: "t2" });
    expect(
      store.load().sort((a, b) => a.project_id.localeCompare(b.project_id)),
    ).toEqual([record, { ...record, project_id: Q, token: "t2" }]);
    // only the token that holds it removes it
    store.remove(P, "other");
    expect(store.load().length).toBe(2);
    store.remove(P, "t1");
    expect(store.load().map((r) => r.project_id)).toEqual([Q]);
  });

  it("fails, keeping it, on a record it can't read", () => {
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(fileFenceStore(dir).load()).toEqual([]);
    writeFileSync(join(dir, `${P}.json`), "{not json");
    expect(() => fileFenceStore(dir).load()).toThrow("not valid JSON");
    writeFileSync(join(dir, `${P}.json`), JSON.stringify({ project_id: P }));
    expect(() => fileFenceStore(dir).load()).toThrow("malformed");
    // holders a fence service would never have accepted
    const valid = {
      project_id: P,
      token: "t",
      holder: { pid: 10, start: "5" },
      since: 1000,
    };
    for (const holder of [
      { pid: 0, start: "5" },
      { pid: -3, start: "5" },
      { pid: 10, start: 5 },
      { pid: 10, start: "5", pgid: 0 },
      { pid: 10, start: "5", pgid: "7" },
    ]) {
      writeFileSync(
        join(dir, `${P}.json`),
        JSON.stringify({ ...valid, holder }),
      );
      expect(() => fileFenceStore(dir).load()).toThrow("malformed");
    }
    writeFileSync(join(dir, `${P}.json`), "null");
    expect(() => fileFenceStore(dir).load()).toThrow("malformed");
    writeFileSync(join(dir, `${P}.json`), JSON.stringify(valid));
    expect(fileFenceStore(dir).load()).toEqual([valid]);
    expect(readdirSync(dir).sort()).toEqual([`${P}.json`, "notes.txt"]);
  });

  it("fails on replacement instances it can't read, rather than forget them", () => {
    writeFileSync(join(dir, "instances.json"), "{oops");
    const store = fileFenceStore(dir);
    expect(() => store.loadInstances()).toThrow("not valid JSON");
    expect(() => store.saveInstance(P, "i")).toThrow("not valid JSON");
  });
});

describe("the fence capability file", () => {
  it("names a running fence service until it is removed", () => {
    expect(fenceCapableServerRunning(dir)).toBe(false);
    writeFenceCapability(dir);
    expect(fenceCapableServerRunning(dir)).toBe(true);
    removeFenceCapability(dir);
    expect(fenceCapableServerRunning(dir)).toBe(false);
  });

  it("a file that can't be read, or says nothing clear, counts as running", () => {
    for (const content of [
      "{oops",
      JSON.stringify({}),
      JSON.stringify({ holder: {} }),
      JSON.stringify({ holder: { pid: "1", start: "" } }),
      JSON.stringify(null),
      JSON.stringify([]),
    ]) {
      writeFileSync(join(dir, "capability.json"), content);
      expect(fenceCapableServerRunning(dir)).toBe(true);
    }
  });

  it("a file left by a process that is gone does not count", () => {
    writeFileSync(
      join(dir, "capability.json"),
      JSON.stringify({ holder: { pid: 2 ** 22 + 17, start: "" } }),
    );
    expect(fenceCapableServerRunning(dir)).toBe(false);
  });
});

describe("replacement instances", () => {
  it("are kept across stores, and forgotten after a year", () => {
    let t = 1_000_000;
    const store = fileFenceStore(dir, { now: () => t });
    expect(store.loadInstances()).toEqual({});
    store.saveInstance(P, "i1");
    t += 1000;
    store.saveInstance(Q, "i2");
    store.saveInstance(P, "i3");
    expect(fileFenceStore(dir, { now: () => t }).loadInstances()).toEqual({
      [P]: "i3",
      [Q]: "i2",
    });
    t += 366 * 24 * 60 * 60 * 1000;
    expect(store.loadInstances()).toEqual({});
  });

  it("refuses an invalid project id", () => {
    expect(() => fileFenceStore(dir).saveInstance("../x", "i")).toThrow(
      "invalid project id",
    );
  });
});

describe("what a holder started", () => {
  const { spawn } = require("node:child_process");

  it("keeps the fence while a process of the holder's group started since runs", async () => {
    const holder = currentFenceHolder();
    expect(holder.pgid).toEqual(expect.any(Number));
    // a holder that is gone, in this process's group
    const gone = { pid: 2 ** 22 + 17, start: "", pgid: holder.pgid };
    // (processes that started just before a fence count, to be safe)
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const since = Date.now();
    expect(isFenceHolderAlive(gone, since)).toBe(false);
    // what it started to change the files, which outlives it
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(isFenceHolderAlive(gone, since)).toBe(true);
      // which a person is told
      // (and whatever else of this group started since, e.g., in other tests)
      const state = describeFenceHolder(gone, since);
      expect(state.holder_running).toBe(false);
      expect(state.keeping).toContainEqual({
        pid: child.pid,
        command: "sleep 30",
      });
      expect(describeFenceHolder(holder, since)).toEqual({
        holder_running: true,
      });
      // processes from before the fence don't count
      expect(isFenceHolderAlive(gone, Date.now() + 10_000)).toBe(false);
    } finally {
      child.kill("SIGKILL");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    expect(isFenceHolderAlive(gone, since)).toBe(false);
  });
});

describe("without /proc", () => {
  it("this process holds fences, of a start time that can't be told", () => {
    const fs = require("node:fs");
    const readFileSync = fs.readFileSync;
    const spy = jest
      .spyOn(fs, "readFileSync")
      .mockImplementation((path: any, ...rest: any[]) => {
        if (`${path}`.startsWith("/proc/")) {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        }
        return readFileSync(path, ...rest);
      });
    try {
      expect(currentFenceHolder()).toEqual({ pid: process.pid, start: "" });
      expect(isFenceHolderAlive({ pid: process.pid, start: "" })).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("when /proc can't be read", () => {
  it("only what is known to be gone is gone", () => {
    const fs = require("node:fs");
    const readFileSync = fs.readFileSync;
    const spy = jest
      .spyOn(fs, "readFileSync")
      .mockImplementation((path: any, ...rest: any[]) => {
        if (`${path}`.startsWith("/proc/")) {
          throw Object.assign(new Error("EIO"), { code: "EIO" });
        }
        return readFileSync(path, ...rest);
      });
    try {
      // normally not the holder (another start time), but it can't be told
      expect(isFenceHolderAlive({ pid: process.pid, start: "1" })).toBe(true);
      // no process has that pid at all
      expect(isFenceHolderAlive({ pid: 2 ** 22 + 17, start: "1" })).toBe(false);
    } finally {
      spy.mockRestore();
    }
    expect(isFenceHolderAlive({ pid: process.pid, start: "1" })).toBe(false);
  });
});

describe("persist server features", () => {
  it("are what its capability file names, while its process runs", () => {
    expect(persistServerHasFeature(dir, "persist-volume")).toBe(false);
    writeFenceCapability(dir, ["persist-volume"]);
    expect(persistServerHasFeature(dir, "persist-volume")).toBe(true);
    expect(persistServerHasFeature(dir, "other")).toBe(false);
    writeFenceCapability(dir);
    expect(persistServerHasFeature(dir, "persist-volume")).toBe(false);
    // a process that is gone, or a file that can't be read: no
    writeFileSync(
      join(dir, "capability.json"),
      JSON.stringify({
        holder: { pid: 2 ** 22 + 17, start: "" },
        features: ["persist-volume"],
      }),
    );
    expect(persistServerHasFeature(dir, "persist-volume")).toBe(false);
    writeFileSync(join(dir, "capability.json"), "{oops");
    expect(persistServerHasFeature(dir, "persist-volume")).toBe(false);
  });
});
