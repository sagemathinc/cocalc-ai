/*
ALT-D2 (design note v8) rule 6: the records now share a disk with the data,
so every record operation must fail CLOSED on ENOSPC, EDQUOT, EROFS and EIO:
- arm: throws, so the data write never starts (the caller refuses);
- disarm: the record stays (a safe refusal later: leftover/unverified);
- poison: a failed rename keeps the dirty record, a failed write keeps the
  renamed record, and this process refuses the file from memory either way;
- project-poison: a failed write is refused from memory in this process;
- check (the scan): an unreadable record is present.
The gate's own operations (the start-up scan, prune, the marker write) are
in records-root-gate.test.ts ([F-gate*], [P3]).
*/

import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDurabilityRecords } from "@cocalc/conat/persist/durability-records";
import {
  nodePostRebootRecords,
  sha256Hex,
} from "@cocalc/backend/conat/persist-durability";

const ERRNOS = ["ENOSPC", "EDQUOT", "EROFS", "EIO"];

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "persist-altd2-faults-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

type Rule = { op: string; path: (p: string) => boolean; code: string };
function faultFs(rules: Rule[]) {
  const real: any = fs;
  return new Proxy({} as any, {
    get(_t, op: string) {
      return (...args: any[]) => {
        for (const r of rules) {
          if (r.op === op && r.path(`${args[0]}`)) {
            throw Object.assign(new Error(`${r.code}: injected ${op}`), { code: r.code });
          }
        }
        return real[op](...args);
      };
    },
  });
}

function records(generation: string, rules: Rule[] = [], alive = () => false) {
  return createDurabilityRecords({
    root,
    generation,
    fs: faultFs(rules),
    sha256: sha256Hex,
    pid: 999999,
    isWriterAlive: alive,
  });
}

const any = () => true;

describe("[F-arm] arm fails closed: it throws, nothing to write under", () => {
  for (const op of ["mkdirSync", "writeFileSync", "renameSync"]) {
    it(`[F-arm-${op}] every errno at ${op} throws`, () => {
      for (const code of ERRNOS) {
        const r = records("g1", [{ op, path: any, code }]);
        expect(() => r.arm("/s", "p")).toThrow(code);
      }
    });
  }
});

describe("[F-disarm] a failed disarm leaves the record (a safe refusal later)", () => {
  it("[F-disarm-unlinkSync] every errno: the record stays, another process sees it", () => {
    for (const code of ERRNOS) {
      const id = `/s-${code}`;
      const r = records("g1", [{ op: "unlinkSync", path: any, code }]);
      r.arm(id, "p");
      expect(() => r.disarm(id)).not.toThrow();
      expect(fs.existsSync(r.dirtyPath(id))).toBe(true);
      expect(records("g2").check(id, "p")).toBe("leftover");
      expect(records("g3", [], () => true).check(id, "p")).toBe("unverified");
    }
  });
});

describe("[F-poison] poison fails closed", () => {
  it("[F-poison-renameSync] a failed rename keeps the dirty record; this process refuses from memory", () => {
    for (const code of ERRNOS) {
      const id = `/p-${code}`;
      const r = records("g1", [{ op: "renameSync", path: any, code }]);
      // arm with a working fs, then poison with the failing one
      records("g1").arm(id, "p");
      r.poison(id, { where: "t" });
      expect(r.check(id, "p")).toBe("poisoned");
      expect(fs.existsSync(r.dirtyPath(id))).toBe(true);
      expect(records("g2").check(id, "p")).toBe("leftover");
    }
  });

  it("[F-poison-writeFileSync] a failed poison write after the rename: the renamed record refuses", () => {
    for (const code of ERRNOS) {
      const id = `/w-${code}`;
      records("g1").arm(id, "p");
      const r = records("g1", [{ op: "writeFileSync", path: any, code }]);
      r.poison(id, { where: "t" });
      expect(r.check(id, "p")).toBe("poisoned");
      expect(records("g2").check(id, "p")).toBe("poisoned");
    }
  });

  it("[F-poison-mkdirSync] no records dirs at all (mkdir fails): refused from memory", () => {
    for (const code of ERRNOS) {
      const id = `/m-${code}`;
      const r = records("g1", [{ op: "mkdirSync", path: any, code }]);
      r.poison(id, { where: "t" });
      expect(r.check(id, "p")).toBe("poisoned");
    }
  });
});

describe("[F-project] project-poison fails closed", () => {
  for (const op of ["mkdirSync", "writeFileSync", "renameSync"]) {
    it(`[F-project-${op}] every errno: the project's streams are refused in this process`, () => {
      for (const code of ERRNOS) {
        const owner = `proj-${op}-${code}`;
        const r = records("g1", [{ op, path: any, code }]);
        r.poisonProject(owner, { where: "t", errno: "EDQUOT" });
        expect(r.check("/any/stream", owner)).toBe("poisoned");
        expect(r.check("/any/stream", "other")).toBe("ok");
        // its writer is this process: S-q does not clear it here
        expect(r.projectPoisonGeneration(owner)).toBe("g1");
      }
    });
  }

  it("[F-project-clear] a verified project clears its in-memory records too", () => {
    const r = records("g1", [{ op: "writeFileSync", path: any, code: "EIO" }]);
    r.poisonProject("q", { where: "t" });
    r.poison("/f", { where: "t", scope: "project", owner: "q" });
    r.poison("/dev", { where: "t" });
    expect(r.check("/f", "q")).toBe("poisoned");
    expect(records("g1").clearProjectPoison("q")).toEqual([]); // another instance: nothing on disk
    expect(r.clearProjectPoison("q")).toEqual(["/f"]);
    expect(r.check("/f", "q")).toBe("ok");
    expect(r.check("/dev")).toBe("poisoned"); // a device poison stays
  });
});

describe("[B2-clear] a verified project clears the renamed dirty record of a poison whose write failed (review B2)", () => {
  it("[B2-clear] arm -> rename ok -> poison write fails -> clear: the target is gone and the stream is ok; a device poison stays", () => {
    for (const code of ERRNOS) {
      const id = `/project/file-${code}`;
      records("g1").arm(id, "q");
      const r = records("g1", [{ op: "writeFileSync", path: (p) => p.includes("/poisoned-file/"), code }]);
      r.poison(id, { where: "t", scope: "project", owner: "q" });
      const target = r.poisonedPath(id);
      expect(JSON.parse(fs.readFileSync(target, "utf8")).kind).toBe("dirty");
      expect(r.check(id, "q")).toBe("poisoned");
      expect(r.clearProjectPoison("q")).toEqual([id]);
      expect(fs.existsSync(target)).toBe(false);
      expect(r.check(id, "q")).toBe("ok");
      expect(records("g2").check(id, "q")).toBe("ok");
    }
    // a device poison (no project scope) of the same kind of failure stays
    const dev = "/project/device";
    records("g1").arm(dev, "q");
    const r = records("g1", [{ op: "writeFileSync", path: (p) => p.includes("/poisoned-file/"), code: "EIO" }]);
    r.poison(dev, { where: "t" });
    expect(r.clearProjectPoison("q")).toEqual([]);
    expect(r.check(dev, "q")).toBe("poisoned");
    // a target of another kind (a device poison) is never removed and not
    // reported cleared
    const other = "/project/other";
    records("g1").arm(other, "q");
    r.poison(other, { where: "t", scope: "project", owner: "q" });
    fs.writeFileSync(r.poisonedPath(other), JSON.stringify({ kind: "poisoned-file", id: other }));
    expect(r.clearProjectPoison("q")).toEqual([]);
    expect(r.check(other, "q")).toBe("poisoned");
    // a dirty record of ANOTHER generation (another process, e.g. the file
    // server's maintenance) at the target stays, not reported (SA 4317 R3)
    const foreign = "/project/foreign";
    records("g1").arm(foreign, "q");
    r.poison(foreign, { where: "t", scope: "project", owner: "q" });
    const foreignTarget = r.poisonedPath(foreign);
    fs.writeFileSync(
      foreignTarget,
      JSON.stringify({ kind: "dirty", generation: "maintenance-gen", id: foreign, pid: 1 }),
    );
    expect(r.clearProjectPoison("q")).toEqual([]);
    expect(fs.existsSync(foreignTarget)).toBe(true);
    expect(r.check(foreign, "q")).toBe("poisoned");
    // a target naming ANOTHER id stays, not reported (SA 4308)
    const named = "/project/named";
    records("g1").arm(named, "q");
    r.poison(named, { where: "t", scope: "project", owner: "q" });
    fs.writeFileSync(r.poisonedPath(named), JSON.stringify({ kind: "dirty", id: "/project/someone-else" }));
    expect(r.clearProjectPoison("q")).toEqual([]);
    expect(fs.existsSync(r.poisonedPath(named))).toBe(true);
    expect(r.check(named, "q")).toBe("poisoned");
  });
});

describe("[B3-retry] a cleared poison's pending post-reboot write is cancelled, only after the durable remove (review B3)", () => {
  // an in-memory post-reboot store whose writes and removes can fail
  function store() {
    const saved = new Map<string, string>();
    const s = {
      failWrite: false,
      failRemove: false,
      saved,
      write: (key: string, data: string) => {
        if (s.failWrite) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        saved.set(key, data);
      },
      exists: (key: string) => saved.has(key),
      remove: (key: string) => {
        if (s.failRemove) throw Object.assign(new Error("EIO: injected"), { code: "EIO" });
        saved.delete(key);
      },
    };
    return s;
  }
  function withStore(post: any, rules: Rule[] = []) {
    return createDurabilityRecords({
      root,
      generation: "g1",
      fs: faultFs(rules),
      sha256: sha256Hex,
      pid: 999999,
      isWriterAlive: () => false,
      postReboot: post,
    });
  }

  it("[B3-retry] clearProjectPoison (on-disk and in-memory poisons) and clearPostReboot: the retry recreates nothing; a failed remove keeps it pending and throws", () => {
    // 1. an on-disk project poison whose post-reboot write failed
    let post = store();
    let r = withStore(post);
    post.failWrite = true;
    r.poison("/p/a", { where: "t", scope: "project", owner: "q" });
    expect(r.postRebootPending()).toBe(1);
    expect(r.clearProjectPoison("q")).toEqual(["/p/a"]);
    expect(r.postRebootPending()).toBe(0);
    post.failWrite = false;
    expect(r.retryPostReboot()).toBe(0);
    expect(post.saved.size).toBe(0);
    expect(r.check("/p/a", "q")).toBe("ok");
    // 2. an in-memory project poison (its poisoned-file write failed too)
    post = store();
    r = withStore(post, [{ op: "writeFileSync", path: (p) => p.includes("/poisoned-file/"), code: "EIO" }]);
    post.failWrite = true;
    r.poison("/p/b", { where: "t", scope: "project", owner: "q" });
    expect(r.postRebootPending()).toBe(1);
    expect(r.clearProjectPoison("q")).toEqual(["/p/b"]);
    expect(r.postRebootPending()).toBe(0);
    post.failWrite = false;
    r.retryPostReboot();
    expect(post.saved.size).toBe(0);
    expect(r.check("/p/b", "q")).toBe("ok");
    // 1b/2b. a failed durable remove in clearProjectPoison (on-disk and
    // in-memory poisons): it throws, and the pending write stays
    for (const inMemory of [false, true]) {
      post = store();
      r = withStore(
        post,
        inMemory ? [{ op: "writeFileSync", path: (p) => p.includes("/poisoned-file/"), code: "EIO" }] : [],
      );
      post.failWrite = true;
      const id = inMemory ? "/p/rm-mem" : "/p/rm-disk";
      r.poison(id, { where: "t", scope: "project", owner: "q2" });
      expect(r.postRebootPending()).toBe(1);
      post.failRemove = true;
      expect(() => r.clearProjectPoison("q2")).toThrow("EIO");
      expect(r.postRebootPending()).toBe(1);
      expect(r.check(id, "q2")).toBe("poisoned");
      post.failRemove = false;
      expect(r.clearProjectPoison("q2")).toEqual([id]);
      expect(r.postRebootPending()).toBe(0);
    }
    // 3. clearPostReboot (after a passed integrity_check)
    post = store();
    r = withStore(post);
    post.failWrite = true;
    r.poison("/p/c", { where: "t" });
    expect(r.postRebootPending()).toBe(1);
    // a failed durable remove throws and keeps the pending write
    post.failRemove = true;
    expect(() => r.clearPostReboot("/p/c")).toThrow("EIO");
    expect(r.postRebootPending()).toBe(1);
    post.failRemove = false;
    r.clearPostReboot("/p/c");
    expect(r.postRebootPending()).toBe(0);
    post.failWrite = false;
    r.retryPostReboot();
    expect(post.saved.size).toBe(0);
  });
});

describe("[F-check] the scan: unreadable is present", () => {
  it("[F-check-readFileSync] an unreadable poisoned-file or poisoned-project record refuses", () => {
    for (const code of ERRNOS) {
      const r = records("g1", [{ op: "readFileSync", path: (p) => p.includes("poisoned"), code }]);
      expect(r.check("/c", "p")).toBe("poisoned");
    }
  });

  it("[F-check-readdirSync] an unlistable dirty key dir is unverified", () => {
    for (const code of ERRNOS) {
      const r = records("g1", [{ op: "readdirSync", path: (p) => p.includes("/dirty/"), code }]);
      expect(r.check("/d", "p")).toBe("unverified");
    }
  });

  it("[F-check-leftovers] an unreadable leftover can't be bounded: undefined", () => {
    records("g1").arm("/l", "p");
    for (const code of ERRNOS) {
      const r = records("g2", [{ op: "readFileSync", path: (p) => p.includes("/dirty/"), code }]);
      expect(r.leftoverIdsOf("p")).toBeUndefined();
      const r2 = records("g2", [{ op: "readdirSync", path: (p) => p.endsWith("/dirty"), code }]);
      expect(r2.leftoverIdsOf("p")).toBeUndefined();
    }
  });
});

describe("[SHORT-postreboot] the post-reboot records: one writer, short writes continued (review B1, ops0's ruling)", () => {
  it("[SHORT-postreboot] a record written in 3-byte pieces is complete; a write without progress throws, keeps it pending, leaves no temp", () => {
    const nodeFs = require("node:fs");
    const real = nodeFs.writeSync;
    const realOpen = nodeFs.openSync;
    const state = join(root, "state");
    let mode: "short" | "zero" = "short";
    // only the post-reboot store's temp files (fds opened under state/poisoned)
    const target = new Set<number>();
    const openSpy = jest.spyOn(nodeFs, "openSync").mockImplementation(((p: any, ...rest: any[]) => {
      const fd = realOpen.call(nodeFs, p, ...rest);
      if (typeof p === "string" && p.startsWith(join(state, "poisoned") + "/")) target.add(fd);
      else target.delete(fd);
      return fd;
    }) as any);
    const spy = jest
      .spyOn(nodeFs, "writeSync")
      .mockImplementation(((fd: number, buf: any, off?: any, len?: any, ...rest: any[]) => {
        if (!target.has(fd) || typeof buf === "string") {
          return real.call(nodeFs, fd, buf, off, len, ...rest);
        }
        const total = len ?? buf.length - (off ?? 0);
        if (mode === "zero") return 0;
        return real.call(nodeFs, fd, buf, off ?? 0, Math.min(total, 3));
      }) as any);
    try {
      const post = nodePostRebootRecords(state);
      const data = JSON.stringify({ kind: "poisoned", id: "/x", pad: "y".repeat(200) });
      post.write("k1", data);
      expect(fs.readFileSync(join(state, "poisoned", "k1"), "utf8")).toBe(data);
      mode = "zero";
      expect(() => post.write("k2", data)).toThrow(/short write/);
      expect(fs.existsSync(join(state, "poisoned", "k2"))).toBe(false);
      expect(fs.readdirSync(join(state, "poisoned")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      // through the records: the poison's post-reboot record stays pending (retried)
      const r = createDurabilityRecords({
        root: join(root, "records"),
        generation: "g1",
        fs: fs as any,
        sha256: sha256Hex,
        postReboot: post,
      });
      r.poison("/z", { where: "t" });
      expect(r.postRebootPending()).toBe(1);
      mode = "short";
      expect(r.retryPostReboot()).toBe(0);
      expect(post.exists(sha256Hex("/z"))).toBe(true);
    } finally {
      spy.mockRestore();
      openSpy.mockRestore();
    }
  });
});
