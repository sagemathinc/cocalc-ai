/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentFenceHolder,
  fenceCapableServerRunning,
  fileFenceStore,
  isFenceHolderAlive,
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

  it("drops records it can't read", () => {
    writeFileSync(join(dir, `${P}.json`), "{not json");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(fileFenceStore(dir).load()).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual(["notes.txt"]);
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
