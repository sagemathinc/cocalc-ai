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
import { sha256Hex } from "@cocalc/backend/conat/persist-durability";

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
