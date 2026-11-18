/*
Finding 028 B-3a: the start-up preconditions of disk-stream service (DESIGN
v1.21 §3.2.5 start-up rule, §3.2.1 SA T3, vanta R1 / N-3, Q9), with the
records root's gate of ALT-D2 (design note v8; the gate's own matrix is in
records-root-gate.test.ts).

If the records root's gate refuses, or the NOFILE limit is too low,
DISK-stream service is refused with code persist_unavailable (and a page);
ephemeral streams still run.  The gate runs ONCE per process: the records
and the start-up check share its result, the persist's module init never
throws, and no record operation runs unless the gate passed.
*/

import * as fs from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { pstream } from "@cocalc/backend/conat/persist";
import {
  MIN_NOFILE,
  checkNofile,
} from "@cocalc/backend/conat/persist-durability";
import * as context from "@cocalc/conat/persist/context";
import { DataEncoding } from "@cocalc/conat/core/client";

// a fresh module registry, with env changed while the modules load (the
// persist's module init evaluates the gate)
function isolated<T>(envPatch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(envPatch)) {
    saved[k] = process.env[k];
    if (envPatch[k] == null) delete process.env[k];
    else process.env[k] = envPatch[k];
  }
  try {
    let out: T;
    jest.isolateModules(() => {
      out = fn();
    });
    return out!;
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] == null) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// no records base for any role
const NO_BASE = {
  COCALC_PERSIST_RECORDS_BASE: undefined,
  COCALC_BAY_STATE_DIR: undefined,
  COCALC_DATA: undefined,
};

describe("028 B-3a: start-up preconditions", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "persist-028-start-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("[CTOR] a refused gate never throws out of the persist's module init: disk streams refuse, ephemeral streams run, the records refuse every operation", () => {
    isolated(NO_BASE, () => {
      let persist: any;
      expect(() => {
        persist = require("@cocalc/backend/conat/persist");
      }).not.toThrow();
      const pd = require("@cocalc/backend/conat/persist-durability");
      const start = pd.persistStartupCheck();
      expect(start.ok).toBe(false);
      expect(start.reason).toMatch(/records_base_unknown/);
      expect(start.records).toMatchObject({ records_ok: false, records_code: "records_base_unknown", records_root: null });
      const records = pd.persistDurabilityRecords();
      expect(records.generation).toBe("refused");
      expect(() => records.arm("/x", "p")).toThrow(/refused/);
      expect(records.check("/x", "p")).toBe("unverified");
      expect(records.leftoverIdsOf("p")).toBeUndefined();
      expect(() => records.clearProjectPoison("p")).toThrow(/refused/);
      expect(() => records.clearPostReboot("/x")).toThrow(/refused/);
      expect(() => persist.pstream({ path: join(dir, "disk") })).toThrow(
        "disk-backed streams are unavailable",
      );
      const eph = persist.pstream({ path: join(dir, "eph"), ephemeral: true });
      eph.set({ encoding: DataEncoding.JsonCodec, raw: Buffer.from("x") });
      eph.close();
      // a maintenance write is refused before it starts
      expect(() =>
        pd.runArmedMaintenanceWrite(join(dir, "m.db"), "p", "test", () => {
          throw Error("must not run");
        }),
      ).toThrow(/dirty record can't be created/);
    });
  });

  it("[CACHE] ONE gate evaluation per process, shared by the records and the start-up check", () => {
    isolated({}, () => {
      const gateModule = require("@cocalc/backend/conat/persist-records-root");
      const spy = jest.spyOn(gateModule, "evaluateRecordsGate");
      require("@cocalc/backend/conat/persist"); // module init: the records
      const pd = require("@cocalc/backend/conat/persist-durability");
      const a = pd.persistStartupCheck();
      pd.resetPersistStartupCheckForTests();
      const b = pd.persistStartupCheck();
      pd.persistDurabilityRecords();
      expect(spy).toHaveBeenCalledTimes(1);
      const g = pd.persistRecordsGate();
      expect(g.ok).toBe(true);
      expect(a.records).toEqual(pd.recordsDiagnostics(g));
      expect(b.records).toEqual(a.records);
      expect(pd.persistDurabilityRecords().root).toBe(g.root);
    });
  });

  it("[LAZY] importing the persist module evaluates nothing, touches no file and pages nothing; the first record operation runs the gate (SA 4306 S3)", () => {
    const cases = [
      { name: "with-base", base: join(dir, "lazy-base-1", "persist-durability") },
      { name: "no-base", base: undefined },
    ];
    fs.mkdirSync(join(dir, "lazy-base-1"), { mode: 0o700 });
    for (const c of cases) {
      const envPatch = c.base == null ? NO_BASE : { COCALC_PERSIST_RECORDS_BASE: c.base };
      isolated(envPatch, () => {
        // every error log line of every logger of this registry
        const loggerModule = require("@cocalc/backend/logger");
        const realGetLogger = loggerModule.default;
        const errors: string[] = [];
        const loggerSpy = jest.spyOn(loggerModule, "default").mockImplementation(((name: string) => {
          const l = realGetLogger(name);
          const realError = l.error.bind(l);
          l.error = (...a: any[]) => {
            errors.push(String(a[0]));
            return realError(...a);
          };
          return l;
        }) as any);
        const gateModule = require("@cocalc/backend/conat/persist-records-root");
        const spy = jest.spyOn(gateModule, "evaluateRecordsGate");
        const nodeFs = require("node:fs");
        const touched: string[] = [];
        const spies = ["lstatSync", "mkdirSync", "openSync", "readFileSync", "readdirSync", "renameSync"].map((op) => {
          const real = nodeFs[op];
          return jest.spyOn(nodeFs, op).mockImplementation(((p: any, ...rest: any[]) => {
            if (
              typeof p === "string" &&
              ((c.base != null && p.startsWith(c.base)) || p.includes("boot_id") || p.includes("cocalc-persist"))
            ) {
              touched.push(`${op} ${p}`);
            }
            return real.call(nodeFs, p, ...rest);
          }) as any);
        });
        try {
          const persist = require("@cocalc/backend/conat/persist"); // module init
          const pd = require("@cocalc/backend/conat/persist-durability");
          pd.persistDurabilityRecords(); // getting the records: still lazy
          expect(persist.persistContextOptions.durability).toBeDefined();
          expect(spy).toHaveBeenCalledTimes(0);
          expect(touched).toEqual([]);
          expect(errors.filter((e) => /PERSIST ALERT/.test(e))).toEqual([]);
          if (c.base != null) expect(fs.existsSync(c.base)).toBe(false);
          // the first operation runs the gate (and, without a base, pages:
          // the positive control of the page spy)
          pd.persistDurabilityRecords().check("/x", "p");
          expect(spy).toHaveBeenCalledTimes(1);
          if (c.base != null) {
            expect(fs.existsSync(join(c.base, "records"))).toBe(true);
          } else {
            expect(errors.filter((e) => /PERSIST ALERT/.test(e)).length).toBe(1);
          }
        } finally {
          for (const s of spies) s.mockRestore();
          loggerSpy.mockRestore();
        }
      });
    }
  });

  it("[SETUP-FAIL] records that can't be set up after a passed gate refuse in the start-up check (SA 4306 A2)", () => {
    isolated({}, () => {
      jest.doMock("@cocalc/conat/persist/durability-records", () => ({
        ...jest.requireActual("@cocalc/conat/persist/durability-records"),
        createDurabilityRecords: () => {
          throw Error("injected set-up failure");
        },
      }));
      const pd = require("@cocalc/backend/conat/persist-durability");
      expect(pd.persistRecordsGate().ok).toBe(true);
      const start = pd.persistStartupCheck();
      expect(start.ok).toBe(false);
      expect(start.reason).toBe("durability records can't be set up");
      expect(() => pd.persistDurabilityRecords().arm("/x", "p")).toThrow(/refused/);
      jest.dontMock("@cocalc/conat/persist/durability-records");
    });
  });

  it("[NOOP] no record operation before a successful gate: a refused gate leaves the base without records", () => {
    const base = join(dir, "persist-durability");
    fs.mkdirSync(base, { mode: 0o700 });
    fs.chmodSync(base, 0o770); // T1 refuses the base itself
    isolated({ COCALC_PERSIST_RECORDS_BASE: base }, () => {
      const pd = require("@cocalc/backend/conat/persist-durability");
      const records = pd.persistDurabilityRecords();
      expect(pd.persistRecordsGate()).toMatchObject({ ok: false, code: "t1_failed" });
      expect(() => records.arm("/x", "p")).toThrow(/refused/);
      records.poison("/x", { where: "t" });
      records.poisonProject("p", { where: "t" });
      records.disarm("/x");
      // refused BY the gate's result (its code), not only by the records
      const start = pd.persistStartupCheck();
      expect(start.ok).toBe(false);
      expect(start.reason).toMatch(/^durability records root refused \(t1_failed\)/);
    });
    expect(fs.readdirSync(base)).toEqual([]);
  });

  it("[NOFILE-prod] with nothing injected, the persist's start-up check enforces MIN_NOFILE: 8192 refuses, 65536 passes", () => {
    const limits = (soft: string) =>
      `Limit                     Soft Limit           Hard Limit           Units\nMax open files            ${soft}                 ${soft}              files\n`;
    for (const [soft, ok] of [
      ["8192", false],
      ["31023", false],
      ["31024", true],
      ["65536", true],
    ] as const) {
      isolated({}, () => {
        const nodeFs = require("node:fs");
        const real = nodeFs.readFileSync;
        const spy = jest.spyOn(nodeFs, "readFileSync").mockImplementation(((p: any, ...rest: any[]) =>
          p === "/proc/self/limits" ? limits(soft) : real.call(nodeFs, p, ...rest)) as any);
        try {
          // a fresh registry: the test setup's setter was not applied here
          const pd = require("@cocalc/backend/conat/persist-durability");
          expect(pd.MIN_NOFILE).toBe(31024);
          const start = pd.persistStartupCheck();
          expect(start.ok).toBe(ok);
          if (!ok) expect(start.reason).toMatch(`NOFILE soft limit ${soft} is below 31024`);
        } finally {
          spy.mockRestore();
        }
      });
    }
  });

  it("[NOFILE-prod] the production wiring (persist.ts) uses MIN_NOFILE with nothing injected: 8192 refuses, 65536 passes", () => {
    const limits = (soft: string) =>
      `Limit                     Soft Limit           Hard Limit           Units\nMax open files            ${soft}                 ${soft}              files\n`;
    for (const [soft, ok] of [
      ["8192", false],
      ["31023", false],
      ["31024", true],
      ["65536", true],
    ] as const) {
      isolated({}, () => {
        const nodeFs = require("node:fs");
        const real = nodeFs.readFileSync;
        const spy = jest
          .spyOn(nodeFs, "readFileSync")
          .mockImplementation(((p: any, ...rest: any[]) =>
            p === "/proc/self/limits" ? limits(soft) : real.call(nodeFs, p, ...rest)) as any);
        try {
          // a fresh registry: the module init of persist.ts, as in production
          const { persistContextOptions } = require("@cocalc/backend/conat/persist");
          const pd = require("@cocalc/backend/conat/persist-durability");
          expect(pd.MIN_NOFILE).toBe(31024);
          expect(persistContextOptions.startupCheck).toBe(pd.persistStartupCheck);
          const start = persistContextOptions.startupCheck();
          expect(start.ok).toBe(ok);
          if (!ok) expect(start.reason).toMatch(`NOFILE soft limit ${soft} is below 31024`);
        } finally {
          spy.mockRestore();
        }
      });
    }
  });

  it("[NOFILE-leak] an injected lower minimum is its own instance: the production check is unaffected", () => {
    const nodeFs = require("node:fs");
    const real = nodeFs.readFileSync;
    const spy = jest
      .spyOn(nodeFs, "readFileSync")
      .mockImplementation(((p: any, ...rest: any[]) =>
        p === "/proc/self/limits"
          ? "Max open files            8192                 8192              files\n"
          : real.call(nodeFs, p, ...rest)) as any);
    try {
      const pd = require("@cocalc/backend/conat/persist-durability");
      pd.resetPersistStartupCheckForTests();
      const injected = pd.makePersistStartupCheck(1024);
      expect(injected().ok).toBe(true);
      // evaluated after the injected one, with nothing reset in between
      expect(pd.persistStartupCheck().ok).toBe(false);
      expect(pd.persistStartupCheck().reason).toMatch("below 31024");
      // the context of this suite got the injected instance, not the
      // production one
      expect((context as any).startupCheck).not.toBe(pd.persistStartupCheck);
    } finally {
      spy.mockRestore();
      require("@cocalc/backend/conat/persist-durability").resetPersistStartupCheckForTests();
    }
  });

  it("NOFILE: below the minimum is refused; enough or unlimited passes; no /proc is not checked", () => {
    const limits = (soft: string) =>
      `Limit                     Soft Limit           Hard Limit           Units\nMax open files            ${soft}                 1048576              files\n`;
    expect(checkNofile(() => limits("1024"))).toMatch(/below/);
    expect(checkNofile(() => limits(`${MIN_NOFILE}`))).toBeUndefined();
    expect(checkNofile(() => limits("unlimited"))).toBeUndefined();
    expect(
      checkNofile(() => {
        throw Error("ENOENT");
      }),
    ).toBeUndefined();
    expect(checkNofile(() => "garbage")).toMatch(/can't parse/);
  });

  it("a failed precondition refuses DISK streams with persist_unavailable; ephemeral streams still run", () => {
    const ctx = context as any;
    const real = ctx.startupCheck;
    ctx.startupCheck = () => ({ ok: false, reason: "records root not on tmpfs" });
    try {
      expect(() => pstream({ path: join(dir, "disk") })).toThrow(
        "disk-backed streams are unavailable",
      );
      const eph = pstream({ path: join(dir, "eph"), ephemeral: true });
      eph.set({ encoding: DataEncoding.JsonCodec, raw: Buffer.from("x") });
      eph.close();
    } finally {
      ctx.startupCheck = real;
    }
  });
});
