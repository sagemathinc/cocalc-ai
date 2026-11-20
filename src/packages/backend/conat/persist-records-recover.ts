/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Operator recovery after a FAILED set-up of the durability records root
// (028 ALT-D2; ops0's S4 ruling, 2026-11-18).  A write fault while the gate
// (persist-records-root) created this boot's records dir, its sentinel, the
// marker copies or the migration flag leaves a partial state that the gate
// refuses for the rest of the boot (fail closed).  Once the disk is healthy
// and EVERY process that could use the records is stopped, this removes
// exactly the partial set-up, and the next start creates it again (as a
// migration: the legacy gate is checked again).  The runbook is
// persist-records-recovery.md; it runs as
//   <project-host entry> persist-records-recover --base <records_base>
//     --state-dir <records_state_dir> [--apply]
// (project-host main.ts: on a project host its bin/project-host wrapper, on
// a bay $COCALC_BAY_PROJECT_HOST_MAIN).
//
// It STOPS, removing nothing, unless the state is exactly a partial set-up:
// - a set-up of this boot that COMPLETED (both marker copies equal and of
//   this boot: marker A is written last), whether still intact or changed
//   since, stops: "not a failed creation" (SA 4312 S5; a boot dir replaced
//   after its creation may have lost records: reboot first);
// - a record of this boot (dirty, poisoned-file, poisoned-project);
// - an unreadable or unlisted entry, a symlink or non-directory where a
//   directory belongs (records/<boot id>, <state>/poisoned too), a path not
//   owned by the user it runs as (it runs as the persist user, never as
//   root: a root-created path makes the gate's T1 refuse);
// - legacy records (M1).
// It never touches the legacy tmpfs root (checked only) or the post-reboot
// records (<state>/poisoned: checked to be a real directory of ours, never
// listed or changed).  Paths come from the role's configuration, exactly as
// the persist resolves them.
//
// Removal order (review B6), independent of directory order: this boot's
// sentinel and its temp files, its (empty) class dirs, the boot dir, every
// other temp file, marker A, marker B; then the directories are fsync'd;
// then the migration flag (if any) and its directory (review B7).  A
// failure anywhere reports the removals done, the state found now and "re-run
// this tool", never ok.  Which state the gate then sees depends on the shape
// and the point of failure (e.g. without a flag, or once it is removed, the
// next start may create the root again): the report says what is there.

import * as nodeFs from "node:fs";
import { posix } from "node:path";
import {
  BOOT_ID_PATH,
  LEGACY_RECORD_CLASSES,
  MARKER_A_NAME,
  MARKER_B_NAME,
  MIGRATION_FLAG_NAME,
  RECORDS_DIR_NAME,
  SENTINEL_NAME,
  describeSetup,
  isBootId,
  legacyGate,
  legacyRunDir,
  resolveRecordsBase,
  type GateFs,
} from "./persist-records-root";

export interface RecoveryOptions {
  env?: NodeJS.ProcessEnv;
  fs?: GateFs;
  uid?: number;
  bootIdPath?: string;
  // the post-reboot state dir (persistStateDirFor(env)), marker copy B's dir
  stateDir: string | undefined;
  // the base and state dir the persist itself reports (its diag's
  // records_base and records_state_dir): the resolved paths must be exactly
  // these, else it stops (SA 4317 R2)
  expect?: { base: string; stateDir: string };
  apply?: boolean;
}

export interface RecoveryResult {
  ok: boolean;
  // why it stopped (nothing was removed, unless `applied` lists removals)
  stop?: string;
  base?: string;
  stateDir?: string;
  bootId?: string;
  // the partial set-up found (no token)
  shape?: string;
  // what is (dry run) or was to be (apply) removed, in order
  plan: string[];
  // what was removed
  applied: string[];
}

class Stop extends Error {}

const TMP_OF = (name: string) =>
  new RegExp(`^\\.${name.replace(/\./g, "\\.")}\\.[0-9]+\\.[0-9a-f]+\\.tmp$`);

function errCode(err: unknown): string | undefined {
  return (err as any)?.code;
}

function lstatOrUndefined(fs: GateFs, path: string): nodeFs.BigIntStats | undefined {
  try {
    return fs.lstatSync(path, { bigint: true });
  } catch (err) {
    if (errCode(err) === "ENOENT") return undefined;
    throw new Stop(`${path}: ${errCode(err) ?? err}`);
  }
}

function list(fs: GateFs, dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    throw new Stop(`${dir} can't be listed: ${errCode(err) ?? err}`);
  }
}

// a directory of ours: real, our uid, not group/other-writable (and 0700
// where the gate creates it)
function ownDir(fs: GateFs, path: string, uid: number, exact0700: boolean): void {
  const st = lstatOrUndefined(fs, path);
  if (st == null) throw new Stop(`${path} is missing`);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Stop(`${path} is not a real directory`);
  if (Number(st.uid) !== uid) {
    throw new Stop(`${path} is owned by uid ${Number(st.uid)}, not ${uid}: run this as the persist user`);
  }
  const mode = Number(st.mode) & 0o7777;
  if (exact0700 ? mode !== 0o700 : (mode & 0o022) !== 0) {
    throw new Stop(`${path} has mode ${mode.toString(8)}`);
  }
}

// a regular file of ours (a marker, the flag, a sentinel, a temp file)
function ownFile(fs: GateFs, path: string, uid: number): void {
  const st = lstatOrUndefined(fs, path);
  if (st == null) throw new Stop(`${path} vanished`);
  if (st.isSymbolicLink() || !st.isFile()) throw new Stop(`${path} is not a regular file`);
  if (Number(st.uid) !== uid) throw new Stop(`${path} is owned by uid ${Number(st.uid)}`);
}

function fsyncDir(fs: GateFs, dir: string): void {
  const fd = fs.openSync(dir, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function recoverFailedRecordsCreation(opts: RecoveryOptions): RecoveryResult {
  const env = opts.env ?? process.env;
  const fs = opts.fs ?? (nodeFs as unknown as GateFs);
  const uid = opts.uid ?? process.getuid?.() ?? -1;
  const out: RecoveryResult = { ok: false, plan: [], applied: [] };
  try {
    const resolved = resolveRecordsBase(env);
    if (resolved == null) throw new Stop("no records base for this role (COCALC_BAY_STATE_DIR or COCALC_DATA)");
    const base = resolved.base;
    const stateDir = opts.stateDir;
    for (const p of [base, stateDir]) {
      if (p == null || !p.startsWith("/") || posix.normalize(p) !== p || p.endsWith("/")) {
        throw new Stop(`not an absolute normalized path: ${p}`);
      }
    }
    const state = stateDir!;
    out.base = base;
    out.stateDir = state;
    if (opts.expect != null && (opts.expect.base !== base || opts.expect.stateDir !== state)) {
      throw new Stop(
        `the resolved paths (base ${base}, state dir ${state}) are not the persist's own (records_base ${opts.expect.base}, records_state_dir ${opts.expect.stateDir})`,
      );
    }
    let bootId: string;
    try {
      const text = fs.readFileSync(opts.bootIdPath ?? BOOT_ID_PATH, "utf8");
      bootId = text.endsWith("\n") ? text.slice(0, -1) : text;
    } catch (err) {
      throw new Stop(`the boot id can't be read: ${errCode(err) ?? err}`);
    }
    if (!isBootId(bootId)) throw new Stop("the boot id is not a canonical UUID");
    out.bootId = bootId;

    // the plan, by class (B6)
    const bootContents: string[] = [];
    let bootDirEntry: string | undefined;
    const temps: string[] = [];
    let markerA: string | undefined;
    let markerB: string | undefined;
    let flag: string | undefined;

    const records = posix.join(base, RECORDS_DIR_NAME);
    const bootDir = posix.join(records, bootId);
    if (lstatOrUndefined(fs, base) != null) {
      ownDir(fs, base, uid, true);
      for (const name of list(fs, base)) {
        const path = posix.join(base, name);
        if (name === RECORDS_DIR_NAME) continue;
        if (name === MARKER_A_NAME) {
          ownFile(fs, path, uid);
          markerA = path;
          continue;
        }
        if (TMP_OF(MARKER_A_NAME).test(name)) {
          ownFile(fs, path, uid);
          temps.push(path);
          continue;
        }
        throw new Stop(`unlisted entry in the base: ${path}`);
      }
      if (lstatOrUndefined(fs, records) != null) {
        ownDir(fs, records, uid, true);
        for (const name of list(fs, records)) {
          // other boots' dirs are the gate's to prune: each a real dir of
          // ours (B5); anything else stops
          if (!isBootId(name)) throw new Stop(`unlisted entry in ${records}: ${name}`);
          ownDir(fs, posix.join(records, name), uid, false);
        }
        if (lstatOrUndefined(fs, bootDir) != null) {
          ownDir(fs, bootDir, uid, true);
          const classDirs: string[] = [];
          for (const name of list(fs, bootDir)) {
            const path = posix.join(bootDir, name);
            if (name === SENTINEL_NAME || TMP_OF(SENTINEL_NAME).test(name)) {
              ownFile(fs, path, uid);
              bootContents.push(path);
              continue;
            }
            if ((LEGACY_RECORD_CLASSES as readonly string[]).includes(name)) {
              ownDir(fs, path, uid, false);
              const entries = list(fs, path);
              if (entries.length > 0) {
                throw new Stop(
                  `records of this boot are present in ${path}: do NOT remove them; reboot the host first (they then belong to another boot), then run this again`,
                );
              }
              classDirs.push(`${path}/`);
              continue;
            }
            throw new Stop(`unlisted entry in this boot's records dir: ${path}`);
          }
          bootContents.push(...classDirs);
          bootDirEntry = `${bootDir}/`;
        }
      }
    }
    // the state dir: only marker B, the migration flag, their temp files and
    // poisoned/ (the post-reboot records: a real dir of ours, never listed
    // or changed (B5))
    if (lstatOrUndefined(fs, state) != null) {
      ownDir(fs, state, uid, false);
      for (const name of list(fs, state)) {
        const path = posix.join(state, name);
        if (name === "poisoned") {
          ownDir(fs, path, uid, false);
          continue;
        }
        if (name === MARKER_B_NAME) {
          ownFile(fs, path, uid);
          markerB = path;
          continue;
        }
        if (name === MIGRATION_FLAG_NAME) {
          ownFile(fs, path, uid);
          flag = path;
          continue;
        }
        if (TMP_OF(MARKER_B_NAME).test(name) || TMP_OF(MIGRATION_FLAG_NAME).test(name)) {
          ownFile(fs, path, uid);
          temps.push(path);
          continue;
        }
        throw new Stop(`unlisted entry in the state dir: ${path}`);
      }
    }
    // S5: only a FAILED creation; a complete set-up stops
    const setup = describeSetup(fs, base, state, bootId, uid);
    out.shape = setup.shape;
    if (setup.complete) {
      throw new Stop(`not a failed creation: this boot's set-up is complete (${setup.shape})`);
    }
    if (setup.createdThisBoot) {
      // the creation finished (A is written last): a later change (e.g. the
      // boot dir replaced, records_root_replaced) may have lost records of
      // this boot -- not this tool's case
      throw new Stop(
        `not a failed creation: marker A (written last) names this boot, so its set-up completed and changed afterwards (${setup.shape}); reboot the host first, then run this again`,
      );
    }
    // M1: the legacy tmpfs root is checked, never touched
    try {
      legacyGate(fs, legacyRunDir(env));
    } catch (err) {
      throw new Stop(`legacy records check: ${(err as Error).message}`);
    }
    const plan = [
      ...bootContents,
      ...(bootDirEntry != null ? [bootDirEntry] : []),
      ...temps.sort(),
      ...(markerA != null ? [markerA] : []),
      ...(markerB != null ? [markerB] : []),
      ...(flag != null ? [flag] : []),
    ];
    out.plan = plan;
    if (opts.apply) {
      // everything but the flag, made durable (the directories fsync'd)
      // BEFORE the flag goes, then the flag and its directory (review B7).
      // Any failure: the removals done so far, the state found now, and
      // "re-run this tool" -- never ok, and no claim about what the gate
      // does next (it may already create the root again).
      const beforeFlag = plan.filter((p) => p !== flag);
      let step = "";
      try {
        for (const p of beforeFlag) {
          step = `remove ${p}`;
          if (p.endsWith("/")) fs.rmdirSync(p.slice(0, -1));
          else fs.unlinkSync(p);
          out.applied.push(p);
        }
        for (const d of [records, base, state]) {
          step = `fsync ${d}`;
          if (lstatOrUndefined(fs, d) != null) fsyncDir(fs, d);
        }
        if (flag != null) {
          step = `remove ${flag}`;
          fs.unlinkSync(flag);
          out.applied.push(flag);
          step = `fsync ${state}`;
          fsyncDir(fs, state);
        }
      } catch (err) {
        let now = "unknown";
        try {
          now = describeSetup(fs, base, state, bootId, uid).shape;
        } catch {}
        throw new Stop(
          `partial apply: ${out.applied.length} of ${plan.length} removed, then ${step} failed (${errCode(err) ?? (err as Error)?.message ?? err}); now: ${now}; re-run this tool, or escalate`,
        );
      }
    }
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.stop = err instanceof Stop ? err.message : `unexpected: ${err}`;
  }
  return out;
}

// Writes the report and ends the process with code once the write is done:
// stdout to a pipe is asynchronous on POSIX, and process.exit() right
// after a write can drop what is still pending (review B8, SA 4315).
export function writeReportAndExit(
  out: string,
  code: number,
  stream: { write: (s: string, cb: (err?: unknown) => void) => unknown } = process.stdout,
  exit: (code: number) => void = (c) => process.exit(c),
): void {
  process.exitCode = code;
  stream.write(out, () => exit(code));
}

// The command (project-host main.ts: `persist-records-recover --base B
// --state-dir S [--apply]`, B and S the persist's diag values):
// prints the result as JSON; exit 0 only when ok.  env: the role's resolved
// environment; stateDir: persistStateDirFor(env).
export function runPersistRecordsRecoverCli(
  argv: string[],
  env: NodeJS.ProcessEnv,
  stateDir: string | undefined,
): { code: number; output: string } {
  // --base and --state-dir are REQUIRED: the persist's diag values
  // (records_base, records_state_dir), compared exactly (SA 4317 R2)
  const usage = (why: string) => ({
    code: 2,
    output: `usage: persist-records-recover --base <records_base> --state-dir <records_state_dir> [--apply]  (${why})\n`,
  });
  let apply = false;
  let expectBase: string | undefined;
  let expectState: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--base" && i + 1 < argv.length && expectBase == null) expectBase = argv[++i];
    else if (a === "--state-dir" && i + 1 < argv.length && expectState == null) expectState = argv[++i];
    else return usage(`unknown or repeated: ${a}`);
  }
  if (expectBase == null || expectState == null) return usage("--base and --state-dir are required");
  const r = recoverFailedRecordsCreation({
    env,
    stateDir,
    apply,
    expect: { base: expectBase, stateDir: expectState },
  });
  return { code: r.ok ? 0 : 2, output: JSON.stringify(r, null, 2) + "\n" };
}
