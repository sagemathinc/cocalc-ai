/*
ALT-D2 (design note v8): the durability records' root on the persist's own
disk, scoped by the kernel boot id, behind a start-up gate.  Each test is
named by its row in the design's matrix ([B1] ... [RC9]); the PR description
maps each row to its test and to the mutant the test kills.
*/

import * as fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BASE_OVERRIDE,
  MARKER_A_NAME,
  MARKER_B_NAME,
  MIGRATION_FLAG_NAME,
  SENTINEL_NAME,
  TEST_PATHS_OVERRIDE,
  evaluateRecordsGate,
  resolveRecordsBase,
  type GateFs,
  type GateOptions,
} from "@cocalc/backend/conat/persist-records-root";
import { createDurabilityRecords } from "@cocalc/conat/persist/durability-records";
import { sha256Hex } from "@cocalc/backend/conat/persist-durability";

const BOOT1 = "11111111-2222-4333-8444-555555555555";
const BOOT2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const UID = process.getuid!();

let root: string;
let base: string;
let state: string;
let legacy: string;
let bootFile: string;
let dataDir: string;

function setBoot(id: string) {
  fs.writeFileSync(bootFile, `${id}\n`);
}

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    [BASE_OVERRIDE]: base,
    COCALC_PERSIST_RUN_DIR: legacy,
    TMPDIR: join(root, "tmp"),
    COCALC_PROJECT_RUNNER_MOUNTPOINT: join(root, "mnt"),
    COCALC_SHARED_SCRATCH_HOST_MOUNT: join(root, "scratch"),
    ...extra,
  };
}

function gate(extra: Partial<GateOptions> = {}, envExtra: Record<string, string> = {}) {
  return evaluateRecordsGate({
    env: env(envExtra),
    stateDir: state,
    dataDir,
    bootIdPath: bootFile,
    walkFrom: root,
    retries: 0,
    ...extra,
  });
}

const bootDir = (id = BOOT1) => join(base, "records", id);
const markerA = () => join(base, MARKER_A_NAME);
const markerB = () => join(state, MARKER_B_NAME);
const sentinel = (id = BOOT1) => join(bootDir(id), SENTINEL_NAME);
// marker copy A or its temp file (copy B's name also ends in marker.json)
const isA = (p: string) =>
  p === join(base, MARKER_A_NAME) || p.startsWith(join(base, `.${MARKER_A_NAME}.`));

// fs with injected faults: rules match an operation and a path (fd
// operations match the path the fd was opened with)
type Rule = { op: string; path: (p: string) => boolean; code: string };
function faultFs(rules: Rule[], patch: Partial<Record<string, any>> = {}): GateFs {
  const fds = new Map<number, string>();
  const real: any = fs;
  return new Proxy({} as GateFs, {
    get(_t, op: string) {
      return (...args: any[]) => {
        const p: string =
          typeof args[0] === "string" ? args[0] : (fds.get(args[0]) ?? "");
        for (const r of rules) {
          if (r.op === op && r.path(p)) {
            throw Object.assign(new Error(`${r.code}: injected ${op} ${p}`), {
              code: r.code,
            });
          }
        }
        const result = patch[op] ? patch[op](real, ...args) : real[op](...args);
        if (op === "openSync") fds.set(result, args[0]);
        return result;
      };
    },
  });
}

// a lstat that reports another owner for one path
function otherOwnerFs(target: string): GateFs {
  return faultFs([], {
    lstatSync: (real: any, p: string, o: any) => {
      const st = real.lstatSync(p, o);
      if (p !== target) return st;
      return new Proxy(st, {
        get: (s: any, k) => (k === "uid" ? BigInt(UID + 1) : typeof s[k] == "function" ? s[k].bind(s) : s[k]),
      });
    },
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "persist-altd2-"));
  fs.chmodSync(root, 0o700);
  dataDir = join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  base = join(dataDir, "persist-durability");
  state = join(root, "sync", ".cocalc-persist-state");
  legacy = join(root, "legacy-run");
  bootFile = join(root, "boot_id");
  setBoot(BOOT1);
});
afterEach(() => {
  try {
    fs.chmodSync(root, 0o700);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});

describe("rule 1: the boot id", () => {
  it("[B1] an unreadable or malformed boot id refuses", () => {
    fs.rmSync(bootFile);
    expect(gate()).toMatchObject({ ok: false, code: "boot_id_unreadable" });
    for (const bad of [
      "",
      "not-a-uuid\n",
      `${BOOT1.toUpperCase()}\n`,
      ` ${BOOT1}\n`,
      `${BOOT1}\n\n`,
      `${BOOT1}x\n`,
      "../../etc\n",
    ]) {
      fs.writeFileSync(bootFile, bad);
      expect(gate()).toMatchObject({ ok: false, code: "boot_id_invalid" });
    }
    expect(fs.existsSync(join(base, "records"))).toBe(false);
  });

  it("[B2] a new boot: the old boot dir is ignored and pruned; records start empty", () => {
    const g1 = gate();
    expect(g1).toMatchObject({ ok: true, migrated: true, root: bootDir(BOOT1) });
    const r1 = recordsAt(g1.root!, "gen-1");
    r1.arm("/s", "p");
    r1.poison("/t", { where: "x" });
    setBoot(BOOT2);
    const g2 = gate();
    expect(g2).toMatchObject({ ok: true, new_boot: true, root: bootDir(BOOT2), pruned: 1 });
    expect(g2.migrated).toBeUndefined();
    const r2 = recordsAt(g2.root!, "gen-2");
    expect(r2.check("/s", "p")).toBe("ok");
    expect(r2.check("/t")).toBe("ok");
    expect(fs.existsSync(bootDir(BOOT1))).toBe(false);
    const m = JSON.parse(fs.readFileSync(markerA(), "utf8"));
    expect(m.boot_id).toBe(BOOT2);
    expect(fs.readFileSync(markerB(), "utf8")).toBe(fs.readFileSync(markerA(), "utf8"));
  });

  it("[B3] the same boot, a restart: the records are kept and honoured", () => {
    const g1 = gate();
    const r1 = recordsAt(g1.root!, "gen-1", () => true);
    r1.arm("/s", "p");
    r1.poison("/t", { where: "x" });
    const g2 = gate();
    expect(g2).toMatchObject({ ok: true, root: g1.root, root_dev: g1.root_dev, root_ino: g1.root_ino });
    expect(g2.new_boot).toBeUndefined();
    const r2 = recordsAt(g2.root!, "gen-2", () => true);
    expect(r2.check("/s", "p")).toBe("unverified");
    expect(r2.check("/t")).toBe("poisoned");
  });
});

function recordsAt(root: string, generation: string, alive = () => false) {
  return createDurabilityRecords({
    root,
    generation,
    fs: fs as any,
    sha256: sha256Hex,
    pid: 999999,
    isWriterAlive: alive,
  });
}

describe("rule 2: T1, the ancestor walk", () => {
  it("[T1a] a symlink anywhere in the path refuses", () => {
    const real = join(root, "real-data");
    fs.mkdirSync(real, { mode: 0o700 });
    const link = join(root, "link-data");
    fs.symlinkSync(real, link);
    base = join(link, "persist-durability");
    const g = gate();
    expect(g).toMatchObject({ ok: false, code: "t1_failed" });
    expect(g.t1).toBe(`fail: ${link}: symlink`);
    // the records dir as a symlink too
    base = join(dataDir, "persist-durability");
    fs.mkdirSync(base, { mode: 0o700 });
    fs.mkdirSync(join(root, "elsewhere"), { mode: 0o700 });
    fs.symlinkSync(join(root, "elsewhere"), join(base, "records"));
    expect(gate()).toMatchObject({ ok: false, code: "t1_failed", t1: `fail: ${join(base, "records")}: symlink` });
  });

  it("[T1b] an ancestor that is group- or other-writable (sticky too) refuses", () => {
    for (const mode of [0o770, 0o707, 0o1777, 0o720]) {
      fs.chmodSync(dataDir, mode);
      const g = gate();
      expect(g).toMatchObject({ ok: false, code: "t1_failed" });
      expect(g.t1).toMatch(new RegExp(`^fail: ${dataDir}: group/other-writable`));
    }
  });

  it("[T1c] an ancestor owned by another uid refuses", () => {
    const g = gate({ fs: otherOwnerFs(dataDir) });
    expect(g).toMatchObject({ ok: false, code: "t1_failed" });
    expect(g.t1).toBe(`fail: ${dataDir}: owned by uid ${UID + 1}`);
  });

  it("[T1d] the base, records/ or the boot dir not ours with mode 0700 refuses", () => {
    expect(gate().ok).toBe(true);
    for (const dir of [base, join(base, "records"), bootDir()]) {
      fs.chmodSync(dir, 0o755);
      const g = gate();
      expect(g).toMatchObject({ ok: false, code: "t1_failed" });
      expect(g.t1).toBe(`fail: ${dir}: mode 755, not 700`);
      fs.chmodSync(dir, 0o700);
      expect(gate().ok).toBe(true);
    }
    const g = gate({ fs: otherOwnerFs(bootDir()) });
    expect(g).toMatchObject({ ok: false, code: "t1_failed" });
  });

  it("[T1e] D3: copy B's state dir path gets the same walk", () => {
    expect(gate().ok).toBe(true);
    fs.chmodSync(join(root, "sync"), 0o775);
    const g = gate();
    expect(g).toMatchObject({ ok: false, code: "t1_failed" });
    expect(g.t1).toMatch(new RegExp(`^fail: ${join(root, "sync")}: group/other-writable`));
    fs.chmodSync(join(root, "sync"), 0o700);
    expect(gate({ fs: otherOwnerFs(state) })).toMatchObject({ ok: false, code: "t1_failed" });
  });

  it("[T1f] a pass is reported as t1 pass with the path and dev/ino", () => {
    const g = gate();
    const st = fs.lstatSync(bootDir(), { bigint: true });
    expect(g).toMatchObject({ ok: true, t1: "pass", root: bootDir(), root_dev: `${st.dev}`, root_ino: `${st.ino}` });
    expect(JSON.stringify(g)).not.toContain(JSON.parse(fs.readFileSync(sentinel(), "utf8")).token);
  });
});

describe("rule 3: anything unreadable in the current boot dir is present", () => {
  it("[P1] an unreadable record refuses (present), never absent", () => {
    const g = gate();
    const r1 = recordsAt(g.root!, "gen-1");
    r1.poison("/u", { where: "x" });
    const path = r1.poisonedPath("/u");
    const eacces = faultFs([{ op: "readFileSync", path: (p) => p === path, code: "EACCES" }]);
    const r2 = createDurabilityRecords({ root: g.root!, generation: "gen-2", fs: eacces as any, sha256: sha256Hex });
    expect(r2.check("/u")).toBe("poisoned");
    // and a dirty key dir that can't be listed
    r1.arm("/v", "p");
    const dirtyDir = join(g.root!, "dirty", sha256Hex("/v"));
    const eio = faultFs([{ op: "readdirSync", path: (p) => p === dirtyDir, code: "EIO" }]);
    const r3 = createDurabilityRecords({ root: g.root!, generation: "gen-3", fs: eio as any, sha256: sha256Hex });
    expect(r3.check("/v", "p")).toBe("unverified");
  });
});

describe("rule 4: pruning other boots", () => {
  it("[P2] only well-formed other boot ids go; malformed, symlinks, files and the current id stay", () => {
    expect(gate().ok).toBe(true);
    const records = join(base, "records");
    fs.mkdirSync(join(records, BOOT2), { mode: 0o700 });
    fs.mkdirSync(join(records, BOOT2, "dirty"), { mode: 0o700 });
    fs.writeFileSync(join(records, BOOT2, "dirty", "x"), "{}");
    fs.mkdirSync(join(records, "not-a-boot-id"), { mode: 0o700 });
    fs.mkdirSync(join(records, BOOT2.toUpperCase()), { mode: 0o700 });
    const target = join(root, "victim");
    fs.mkdirSync(target, { mode: 0o700 });
    fs.writeFileSync(join(target, "keep"), "x");
    const linkId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    fs.symlinkSync(target, join(records, linkId));
    const fileId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    fs.writeFileSync(join(records, fileId), "x");
    const g = gate();
    expect(g).toMatchObject({ ok: true, pruned: 1, prune_errors: 0 });
    expect(g.prune_skipped!.sort()).toEqual(
      ["not-a-boot-id", BOOT2.toUpperCase(), linkId, fileId].sort(),
    );
    expect(fs.existsSync(join(records, BOOT2))).toBe(false);
    expect(fs.existsSync(bootDir())).toBe(true);
    expect(fs.existsSync(join(records, "not-a-boot-id"))).toBe(true);
    expect(fs.existsSync(join(target, "keep"))).toBe(true);
    expect(fs.lstatSync(join(records, linkId)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(join(records, fileId))).toBe(true);
  });

  it("[P3] a failed delete is counted, never treated as pruned; the start is still ok", () => {
    expect(gate().ok).toBe(true);
    const old = join(base, "records", BOOT2);
    fs.mkdirSync(old, { mode: 0o700 });
    fs.writeFileSync(join(old, "x"), "{}");
    for (const code of ["EIO", "EROFS", "EACCES"]) {
      const g = gate({ fs: faultFs([{ op: "unlinkSync", path: (p) => p === join(old, "x"), code }]) });
      expect(g).toMatchObject({ ok: true, pruned: 0, prune_errors: 1 });
      expect(fs.existsSync(join(old, "x"))).toBe(true);
    }
    const g = gate({ fs: faultFs([{ op: "rmdirSync", path: (p) => p === old, code: "EIO" }]) });
    expect(g).toMatchObject({ ok: true, pruned: 0, prune_errors: 1 });
    expect(fs.existsSync(old)).toBe(true);
    // an unlistable records dir: nothing pruned, counted
    const g2 = gate({ fs: faultFs([{ op: "readdirSync", path: (p) => p === join(base, "records"), code: "EIO" }]) });
    expect(g2).toMatchObject({ ok: true, pruned: 0, prune_errors: 1 });
    expect(gate()).toMatchObject({ ok: true, pruned: 1, prune_errors: 0 });
  });
});

describe("rule 5: the R-b marker, the TOTAL table", () => {
  it("[R1] marker of another boot, no current boot dir: a new boot", () => {
    expect(gate().ok).toBe(true);
    setBoot(BOOT2);
    const g = gate();
    expect(g).toMatchObject({ ok: true, new_boot: true, root: bootDir(BOOT2) });
    const st = fs.lstatSync(bootDir(BOOT2), { bigint: true });
    const m = JSON.parse(fs.readFileSync(markerA(), "utf8"));
    expect(m).toMatchObject({ boot_id: BOOT2, dev: `${st.dev}`, ino: `${st.ino}` });
    expect(JSON.parse(fs.readFileSync(sentinel(BOOT2), "utf8")).token).toBe(m.token);
  });

  it("[R2] marker of another boot, but the current boot dir exists: refused", () => {
    expect(gate().ok).toBe(true);
    fs.mkdirSync(bootDir(BOOT2), { mode: 0o700 });
    setBoot(BOOT2);
    expect(gate()).toMatchObject({ ok: false, code: "boot_dir_unexpected" });
  });

  it("[R3] marker of this boot, boot dir and sentinel match: ok (a restart)", () => {
    expect(gate().ok).toBe(true);
    expect(gate()).toMatchObject({ ok: true, root: bootDir() });
  });

  it("[R4a] the sentinel missing: records_root_replaced", () => {
    expect(gate().ok).toBe(true);
    fs.rmSync(sentinel());
    expect(gate()).toMatchObject({ ok: false, code: "records_root_replaced" });
  });

  it("[R4b] the sentinel's token changed: records_root_replaced", () => {
    expect(gate().ok).toBe(true);
    const s = JSON.parse(fs.readFileSync(sentinel(), "utf8"));
    fs.writeFileSync(sentinel(), JSON.stringify({ ...s, token: "0".repeat(64) }), { mode: 0o600 });
    expect(gate()).toMatchObject({ ok: false, code: "records_root_replaced" });
  });

  it("[R4c] the boot dir deleted and re-created by any means (dev/ino changed, sentinel copied): refused", () => {
    expect(gate().ok).toBe(true);
    const saved = fs.readFileSync(sentinel(), "utf8");
    const oldIno = fs.lstatSync(bootDir()).ino;
    fs.rmSync(bootDir(), { recursive: true });
    // re-created with another inode (park any dir that got the old one)
    for (let i = 0; ; i++) {
      fs.mkdirSync(bootDir(), { mode: 0o700 });
      if (fs.lstatSync(bootDir()).ino !== oldIno) break;
      fs.renameSync(bootDir(), join(root, `parked-${i}`));
    }
    fs.writeFileSync(sentinel(), saved, { mode: 0o600 });
    expect(gate()).toMatchObject({ ok: false, code: "records_root_replaced" });
  });

  it("[R5] marker of this boot, the boot dir missing: records_root_replaced", () => {
    expect(gate().ok).toBe(true);
    fs.rmSync(bootDir(), { recursive: true });
    expect(gate()).toMatchObject({ ok: false, code: "records_root_replaced" });
    // and recreating it by the records' own recursive mkdir does not help
    recordsAt(bootDir(), "gen-x").arm("/a", "p");
    expect(gate()).toMatchObject({ ok: false, code: "records_root_replaced" });
  });

  it("[R6a] copy A deleted: refused", () => {
    expect(gate().ok).toBe(true);
    fs.rmSync(markerA());
    expect(gate()).toMatchObject({ ok: false, code: "marker_copy_missing" });
  });

  it("[R6b] copy B deleted: refused", () => {
    expect(gate().ok).toBe(true);
    fs.rmSync(markerB());
    expect(gate()).toMatchObject({ ok: false, code: "marker_copy_missing" });
  });

  it("[R6c] the copies differ: refused", () => {
    expect(gate().ok).toBe(true);
    const m = JSON.parse(fs.readFileSync(markerB(), "utf8"));
    fs.writeFileSync(markerB(), JSON.stringify({ ...m, token: "1".repeat(64) }), { mode: 0o600 });
    expect(gate()).toMatchObject({ ok: false, code: "marker_copies_differ" });
  });

  it("[R7] an unreadable or malformed copy (either) refuses, never a new boot", () => {
    expect(gate().ok).toBe(true);
    setBoot(BOOT2); // a malformed marker must not read as "another boot"
    const saved = fs.readFileSync(markerA(), "utf8");
    for (const bad of ["{", "{}", JSON.stringify({ ...JSON.parse(saved), extra: 1 }), JSON.stringify({ ...JSON.parse(saved), boot_id: "X" })]) {
      for (const path of [markerA(), markerB()]) {
        fs.writeFileSync(path, bad, { mode: 0o600 });
        expect(gate()).toMatchObject({ ok: false, code: "marker_invalid" });
        fs.writeFileSync(path, saved, { mode: 0o600 });
      }
    }
    for (const path of [markerA(), markerB()]) {
      for (const op of ["lstatSync", "openSync", "readSync"]) {
        const g = gate({ fs: faultFs([{ op, path: (p) => p === path, code: "EIO" }]) });
        expect(g).toMatchObject({ ok: false, code: "marker_invalid" });
      }
    }
    expect(fs.existsSync(bootDir(BOOT2))).toBe(false);
    expect(gate()).toMatchObject({ ok: true, new_boot: true });
  });

  it("[R8] both copies absent, the current boot dir present: refused", () => {
    expect(gate().ok).toBe(true);
    fs.rmSync(markerA());
    fs.rmSync(markerB());
    expect(gate()).toMatchObject({ ok: false, code: "marker_missing" });
  });

  it("[R9] both absent, no boot dir: ok only at the first start (migration flag), else refused", () => {
    const g = gate();
    expect(g).toMatchObject({ ok: true, migrated: true, new_boot: true });
    const flag = join(state, MIGRATION_FLAG_NAME);
    expect(fs.lstatSync(flag).mode & 0o7777).toBe(0o600);
    // the residual case: both copies and the boot dir deleted mid-boot
    fs.rmSync(markerA());
    fs.rmSync(markerB());
    fs.rmSync(bootDir(), { recursive: true });
    expect(gate()).toMatchObject({ ok: false, code: "marker_missing" });
    // a flag that can't be read is present (refuse), never absent
    fs.rmSync(flag);
    const g2 = gate({ fs: faultFs([{ op: "lstatSync", path: (p) => p === flag, code: "EACCES" }]) });
    expect(g2).toMatchObject({ ok: false, code: "migration_flag_unreadable" });
  });

  it("[R9b] the migration flag is written durably (fsync of the file, rename, fsync of the dir) before the boot dir", () => {
    const ops: string[] = [];
    const fds = new Map<number, string>();
    const spy = faultFs([], Object.fromEntries(
      ["openSync", "fsyncSync", "renameSync", "mkdirSync", "writeSync"].map((op) => [
        op,
        (real: any, ...args: any[]) => {
          const r = real[op](...args);
          const p = typeof args[0] === "string" ? args[0] : fds.get(args[0]);
          if (op === "openSync") fds.set(r, args[0]);
          ops.push(`${op} ${op === "renameSync" ? args[1] : p}`);
          return r;
        },
      ]),
    ));
    expect(gate({ fs: spy }).ok).toBe(true);
    const flag = join(state, MIGRATION_FLAG_NAME);
    const iRename = ops.indexOf(`renameSync ${flag}`);
    expect(iRename).toBeGreaterThan(0);
    const before = ops.slice(0, iRename);
    expect(before.some((o) => /^fsyncSync .*records-migrated\.json\..*\.tmp$/.test(o))).toBe(true);
    expect(ops[iRename + 2]).toBe(`fsyncSync ${state}`);
    expect(ops.indexOf(`mkdirSync ${bootDir()}`)).toBeGreaterThan(iRename);
    // B is written before A
    expect(ops.indexOf(`renameSync ${markerB()}`)).toBeLessThan(ops.indexOf(`renameSync ${markerA()}`));
  });

  describe("[D3] marker A, marker B and the sentinel are strict files", () => {
    const cases: [string, () => string][] = [
      ["A", markerA],
      ["B", markerB],
      ["sentinel", () => sentinel()],
    ];
    for (const [name, path] of cases) {
      const code = name === "sentinel" ? "records_root_replaced" : "marker_invalid";
      it(`[D3-${name}] a symlink, another owner, a mode not 0600, nlink 2, not a regular file: refused`, () => {
        expect(gate().ok).toBe(true);
        const p = path();
        const saved = fs.readFileSync(p, "utf8");
        // symlink to an identical copy
        const copy = join(root, `copy-${name}`);
        fs.writeFileSync(copy, saved, { mode: 0o600 });
        fs.rmSync(p);
        fs.symlinkSync(copy, p);
        expect(gate()).toMatchObject({ ok: false, code });
        fs.rmSync(p);
        fs.writeFileSync(p, saved, { mode: 0o600 });
        expect(gate().ok).toBe(true);
        // another owner
        expect(gate({ fs: otherOwnerFs(p) })).toMatchObject({ ok: false, code });
        // mode
        for (const mode of [0o640, 0o644, 0o400, 0o700, 0o4600]) {
          fs.chmodSync(p, mode);
          expect(gate()).toMatchObject({ ok: false, code });
        }
        fs.chmodSync(p, 0o600);
        expect(gate().ok).toBe(true);
        // nlink 2
        const hard = join(root, `hard-${name}`);
        fs.linkSync(p, hard);
        expect(gate()).toMatchObject({ ok: false, code });
        fs.rmSync(hard);
        expect(gate().ok).toBe(true);
        // not a regular file
        fs.rmSync(p);
        fs.mkdirSync(p, { mode: 0o700 });
        expect(gate()).toMatchObject({ ok: false, code });
        fs.rmdirSync(p);
        fs.writeFileSync(p, saved, { mode: 0o600 });
        expect(gate().ok).toBe(true);
      });
    }
  });
});

describe("M1: the legacy records gate, at migration only", () => {
  for (const cls of ["dirty", "poisoned-file", "poisoned-project"]) {
    it(`[M1-${cls}] a legacy ${cls} entry refuses the migration`, () => {
      fs.mkdirSync(join(legacy, cls), { recursive: true, mode: 0o700 });
      fs.writeFileSync(join(legacy, cls, "k"), "{}");
      expect(gate()).toMatchObject({ ok: false, code: "legacy_records_present" });
      expect(fs.existsSync(markerA())).toBe(false);
      expect(fs.existsSync(join(state, MIGRATION_FLAG_NAME))).toBe(false);
    });
  }

  it("[M1-link] the legacy root or a class dir as a symlink, or a non-directory root: refused", () => {
    const real = join(root, "legacy-real");
    fs.mkdirSync(real, { mode: 0o700 });
    fs.symlinkSync(real, legacy);
    expect(gate()).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
    fs.rmSync(legacy);
    fs.mkdirSync(legacy, { mode: 0o700 });
    fs.symlinkSync(real, join(legacy, "poisoned-file"));
    expect(gate()).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
    fs.rmSync(legacy, { recursive: true });
    fs.writeFileSync(legacy, "");
    expect(gate()).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
    fs.rmSync(legacy);
    fs.mkdirSync(legacy, { mode: 0o700 });
    fs.writeFileSync(join(legacy, "dirty"), "");
    expect(gate()).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
  });

  it("[M1-enum] an enumeration error or an unreadable legacy root refuses", () => {
    fs.mkdirSync(join(legacy, "dirty"), { recursive: true, mode: 0o700 });
    for (const code of ["EACCES", "EIO"]) {
      expect(
        gate({ fs: faultFs([{ op: "readdirSync", path: (p) => p === join(legacy, "dirty"), code }]) }),
      ).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
      expect(
        gate({ fs: faultFs([{ op: "lstatSync", path: (p) => p === legacy, code }]) }),
      ).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
      expect(
        gate({ fs: faultFs([{ op: "lstatSync", path: (p) => p === join(legacy, "poisoned-project"), code }]) }),
      ).toMatchObject({ ok: false, code: "legacy_records_unreadable" });
    }
  });

  it("[M1-ok] an absent, or positively empty, legacy root migrates", () => {
    expect(gate()).toMatchObject({ ok: true, migrated: true });
    fs.rmSync(base, { recursive: true });
    fs.rmSync(state, { recursive: true });
    for (const cls of ["dirty", "poisoned-file", "poisoned-project"]) {
      fs.mkdirSync(join(legacy, cls), { recursive: true, mode: 0o700 });
    }
    fs.writeFileSync(join(legacy, ".probe-1"), ""); // not a record class
    expect(gate()).toMatchObject({ ok: true, migrated: true });
  });

  it("[M1-only] the legacy root is read at migration only", () => {
    expect(gate().ok).toBe(true);
    fs.mkdirSync(join(legacy, "dirty"), { recursive: true, mode: 0o700 });
    fs.writeFileSync(join(legacy, "dirty", "k"), "{}");
    expect(gate().ok).toBe(true);
  });
});

describe("R-c: not reachable from a project", () => {
  const visible: [string, (r: string) => { base: string; env?: Record<string, string> }][] = [
    ["tmpdir", (r) => ({ base: join(r, "tmp", "persist-durability") })],
    ["cache", (r) => ({ base: join(r, "data", "cache", "persist-durability") })],
    ["project-roots", (r) => ({ base: join(r, "roots", "persist-durability"), env: { COCALC_PROJECT_ROOTS: join(r, "roots") } })],
    ["image-cache", (r) => ({ base: join(r, "images", "persist-durability"), env: { COCALC_IMAGE_CACHE: join(r, "images") } })],
    ["rootfs-pull-tmp", (r) => ({ base: join(r, "data", "tmp", "persist-durability") })],
    ["project volume", (r) => ({ base: join(r, "mnt", "project-0000", "persist-durability") })],
    ["project scratch volume", (r) => ({ base: join(r, "mnt", "project-0000-scratch", "x", "persist-durability") })],
    ["shared-scratch", (r) => ({ base: join(r, "scratch", "persist-durability") })],
    ["tmpdir equal", (r) => ({ base: join(r, "tmp") })],
  ];
  for (const [kind, make] of visible) {
    it(`[RC-${kind}] a base equal to or below the ${kind} root is refused`, () => {
      const { base: b, env: e } = make(root);
      fs.mkdirSync(join(b, ".."), { recursive: true, mode: 0o700 });
      base = b;
      expect(gate({}, e)).toMatchObject({ ok: false, code: "records_root_project_visible" });
    });
  }

  it("[RC-opt] a base whose realpath is below /opt/cocalc is refused", () => {
    const fake = faultFs([], {
      realpathSync: (real: any, p: string) => (p === base ? "/opt/cocalc/x/persist-durability" : real.realpathSync(p)),
    });
    expect(gate({ fs: fake })).toMatchObject({ ok: false, code: "records_root_project_visible" });
  });

  it("[RC-ok] the managed layout is allowed: <mountpoint>/data/persist-durability, a sibling of the project volumes (no bare-prefix compare)", () => {
    const g = gate({}, { COCALC_PROJECT_RUNNER_MOUNTPOINT: root });
    expect(g).toMatchObject({ ok: true });
    fs.mkdirSync(join(root, "project-0000"), { mode: 0o700 });
    expect(gate({}, { COCALC_PROJECT_RUNNER_MOUNTPOINT: root }).ok).toBe(true);
  });

  it("[RC-mp] the mountpoint resolves as the mount builder does (runner, else file server, else /mnt/cocalc)", () => {
    base = join(root, "fs", "project-1", "persist-durability");
    fs.mkdirSync(join(root, "fs", "project-1"), { recursive: true, mode: 0o700 });
    const e = env({ COCALC_FILE_SERVER_MOUNTPOINT: join(root, "fs") });
    delete e.COCALC_PROJECT_RUNNER_MOUNTPOINT;
    const g = evaluateRecordsGate({ env: e, stateDir: state, dataDir, bootIdPath: bootFile, walkFrom: root, retries: 0 });
    expect(g).toMatchObject({ ok: false, code: "records_root_project_visible" });
  });
});

describe("roles, overrides", () => {
  it("[ROLE] the bay and the project host each resolve their own base", () => {
    expect(resolveRecordsBase({ COCALC_BAY_STATE_DIR: "/b/state", COCALC_DATA: "/d" })).toEqual({
      base: "/b/state/persist-durability",
      role: "bay",
    });
    expect(resolveRecordsBase({ COCALC_DATA: "/mnt/cocalc/data" })).toEqual({
      base: "/mnt/cocalc/data/persist-durability",
      role: "project-host",
    });
    expect(resolveRecordsBase({ DATA: "/x" })).toBeUndefined();
    const e = env();
    delete e[BASE_OVERRIDE];
    const g = evaluateRecordsGate({ env: e, stateDir: state, dataDir, bootIdPath: bootFile, walkFrom: root, retries: 0 });
    expect(g).toMatchObject({ ok: false, code: "records_base_unknown" });
    e.COCALC_DATA = dataDir;
    const g2 = evaluateRecordsGate({ env: e, stateDir: state, dataDir, bootIdPath: bootFile, walkFrom: root, retries: 0 });
    expect(g2).toMatchObject({ ok: true, role: "project-host", base: join(dataDir, "persist-durability") });
  });

  it("[OVR] the test-paths override is refused outside the test mode, and visible inside it", () => {
    expect(gate({}, { [TEST_PATHS_OVERRIDE]: "1" })).toMatchObject({ ok: false, code: "override_refused" });
    const g = gate({}, { [TEST_PATHS_OVERRIDE]: "1", COCALC_TEST_MODE: "true" });
    expect(g.ok).toBe(true);
    expect(g.overrides).toEqual([TEST_PATHS_OVERRIDE, BASE_OVERRIDE]);
  });

  it("[STATE] an unknown or relative state dir (copy B) refuses", () => {
    expect(gate({ stateDir: undefined })).toMatchObject({ ok: false, code: "state_dir_invalid" });
    expect(gate({ stateDir: "rel/dir" })).toMatchObject({ ok: false, code: "state_dir_invalid" });
  });
});

describe("concurrency: two processes on one base", () => {
  it("[RACE] a set-up in progress is re-read, not refused; a real fault stays refused", () => {
    expect(gate().ok).toBe(true);
    setBoot(BOOT2);
    // another process created the boot dir and is about to write the
    // sentinel and the markers: our first read refuses (transient), the
    // retry sees its completed set-up
    fs.mkdirSync(bootDir(BOOT2), { mode: 0o700 });
    let sleeps = 0;
    const g = gate({
      retries: 3,
      sleep: () => {
        sleeps += 1;
        if (sleeps === 1) {
          fs.rmdirSync(bootDir(BOOT2));
          expect(gate().ok).toBe(true); // "the other process"
        }
      },
    });
    expect(g).toMatchObject({ ok: true, root: bootDir(BOOT2) });
    expect(g.new_boot).toBeUndefined();
    expect(sleeps).toBe(1);
    // a deleted copy stays refused after every retry
    fs.rmSync(markerA());
    let n = 0;
    expect(gate({ retries: 3, sleep: () => n++ })).toMatchObject({ ok: false, code: "marker_copy_missing" });
    expect(n).toBe(3);
  });
});

describe("rule 6: faults at the gate's operations fail closed", () => {
  const ERRNOS = ["ENOSPC", "EDQUOT", "EROFS", "EIO"];
  // [where, op, path matcher] at the first start (migration)
  const sites: [string, string, (p: string) => boolean][] = [
    ["mkdir base", "mkdirSync", (p) => p === base],
    ["mkdir records", "mkdirSync", (p) => p === join(base, "records")],
    ["mkdir boot dir", "mkdirSync", (p) => p === bootDir()],
    ["mkdir state dir", "mkdirSync", (p) => p === state],
    ["flag write", "writeSync", (p) => p.includes(MIGRATION_FLAG_NAME)],
    ["flag fsync", "fsyncSync", (p) => p.includes(MIGRATION_FLAG_NAME)],
    ["flag rename", "renameSync", (p) => p.includes(MIGRATION_FLAG_NAME)],
    ["sentinel create", "openSync", (p) => p.includes(SENTINEL_NAME)],
    ["sentinel write", "writeSync", (p) => p.includes(SENTINEL_NAME)],
    ["sentinel fsync", "fsyncSync", (p) => p.includes(SENTINEL_NAME)],
    ["records dir fsync", "fsyncSync", (p) => p === join(base, "records")],
    ["marker B write", "writeSync", (p) => p.includes(MARKER_B_NAME)],
    ["marker B rename", "renameSync", (p) => p.includes(MARKER_B_NAME)],
    ["state dir fsync", "fsyncSync", (p) => p === state],
    ["marker A write", "writeSync", (p) => isA(p)],
    ["marker A fsync", "fsyncSync", (p) => isA(p)],
    ["marker A rename", "renameSync", (p) => isA(p)],
    ["base fsync", "fsyncSync", (p) => p === base],
    ["boot id read", "readFileSync", (p) => p === bootFile],
    ["legacy scan", "lstatSync", (p) => p === legacy],
  ];
  for (const [where, op, path] of sites) {
    it(`[F-gate] ${where}: every errno refuses`, () => {
      for (const code of ERRNOS) {
        const g = gate({ fs: faultFs([{ op, path, code }]) });
        expect(g.ok).toBe(false);
        expect(g.root).toBeUndefined();
        // nothing was left that a later start would take for a clean state
        rmSync(base, { recursive: true, force: true });
        rmSync(state, { recursive: true, force: true });
      }
    });
  }

  it("[F-gate-restart] faults at a restart's reads refuse", () => {
    expect(gate().ok).toBe(true);
    for (const code of ERRNOS) {
      for (const [op, p] of [
        ["lstatSync", bootDir()],
        ["lstatSync", join(base, "records")],
        ["lstatSync", base],
        ["openSync", sentinel()],
        ["readSync", sentinel()],
        ["realpathSync", base],
      ] as const) {
        const g = gate({ fs: faultFs([{ op, path: (x) => x === p, code }]) });
        expect(g.ok).toBe(false);
      }
    }
    expect(gate().ok).toBe(true);
  });

  it("[F-gate-newboot] faults while setting up a new boot refuse, and the next start still refuses or completes, never ok on half state", () => {
    expect(gate().ok).toBe(true);
    setBoot(BOOT2);
    const g = gate({ fs: faultFs([{ op: "renameSync", path: isA, code: "EIO" }]) });
    expect(g).toMatchObject({ ok: false, code: "records_write_failed" });
    // B was written, A was not: the copies differ
    expect(gate()).toMatchObject({ ok: false, code: "marker_copies_differ" });
  });
});
