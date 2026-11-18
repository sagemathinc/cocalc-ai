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
// persist-records-recovery.md.
//
// It STOPS, removing nothing, if anything is not exactly a partial set-up:
// a record of this boot (dirty, poisoned-file, poisoned-project), an
// unreadable or unlisted entry, a symlink, a path not owned by the user it
// runs as (it must run as the persist user, never as root: a root-created
// path makes the gate's T1 refuse), legacy records (M1).  It never touches
// the legacy tmpfs root (checked only) or the post-reboot records
// (<state>/poisoned).  Paths come from the role's configuration, exactly as
// the gate resolves them.
//
// usage, as the persist user with the persist's environment loaded:
//   node <backend dist>/conat/persist-records-recover.js            (dry run)
//   node <backend dist>/conat/persist-records-recover.js --apply

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
  // the post-reboot state dir (persistStateDir()), marker copy B's dir
  stateDir: string | undefined;
  apply?: boolean;
}

export interface RecoveryResult {
  ok: boolean;
  // why it stopped (nothing was removed)
  stop?: string;
  base?: string;
  stateDir?: string;
  bootId?: string;
  // what is (dry run) or was (apply) removed, in order
  plan: string[];
  applied: boolean;
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
  const out: RecoveryResult = { ok: false, plan: [], applied: false };
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
    out.base = base;
    out.stateDir = stateDir;
    let bootId: string;
    try {
      const text = fs.readFileSync(opts.bootIdPath ?? BOOT_ID_PATH, "utf8");
      bootId = text.endsWith("\n") ? text.slice(0, -1) : text;
    } catch (err) {
      throw new Stop(`the boot id can't be read: ${errCode(err) ?? err}`);
    }
    if (!isBootId(bootId)) throw new Stop("the boot id is not a canonical UUID");
    out.bootId = bootId;

    const plan: string[] = [];
    // the base: only marker A, its temp files and records/
    const records = posix.join(base, RECORDS_DIR_NAME);
    const bootDir = posix.join(records, bootId);
    if (lstatOrUndefined(fs, base) != null) {
      ownDir(fs, base, uid, true);
      for (const name of list(fs, base)) {
        const path = posix.join(base, name);
        if (name === RECORDS_DIR_NAME) continue;
        if (name === MARKER_A_NAME || TMP_OF(MARKER_A_NAME).test(name)) {
          ownFile(fs, path, uid);
          plan.push(path);
          continue;
        }
        throw new Stop(`unlisted entry in the base: ${path}`);
      }
      if (lstatOrUndefined(fs, records) != null) {
        ownDir(fs, records, uid, true);
        for (const name of list(fs, records)) {
          // other boots' dirs are the gate's to prune; anything else stops
          if (!isBootId(name)) throw new Stop(`unlisted entry in ${records}: ${name}`);
        }
        if (lstatOrUndefined(fs, bootDir) != null) {
          ownDir(fs, bootDir, uid, true);
          const inBoot: string[] = [];
          for (const name of list(fs, bootDir)) {
            const path = posix.join(bootDir, name);
            if (name === SENTINEL_NAME || TMP_OF(SENTINEL_NAME).test(name)) {
              ownFile(fs, path, uid);
              inBoot.push(path);
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
              inBoot.push(`${path}/`);
              continue;
            }
            throw new Stop(`unlisted entry in this boot's records dir: ${path}`);
          }
          plan.unshift(...inBoot, `${bootDir}/`);
        }
      }
    }
    // the state dir: only marker B, the migration flag, their temp files and
    // poisoned/ (the post-reboot records: kept, never touched)
    if (lstatOrUndefined(fs, stateDir!) != null) {
      ownDir(fs, stateDir!, uid, false);
      for (const name of list(fs, stateDir!)) {
        const path = posix.join(stateDir!, name);
        if (name === "poisoned") continue;
        if (
          name === MARKER_B_NAME ||
          name === MIGRATION_FLAG_NAME ||
          TMP_OF(MARKER_B_NAME).test(name) ||
          TMP_OF(MIGRATION_FLAG_NAME).test(name)
        ) {
          ownFile(fs, path, uid);
          plan.push(path);
          continue;
        }
        throw new Stop(`unlisted entry in the state dir: ${path}`);
      }
    }
    // M1: the legacy tmpfs root is checked, never touched
    try {
      legacyGate(fs, legacyRunDir(env));
    } catch (err) {
      throw new Stop(`legacy records check: ${(err as Error).message}`);
    }
    out.plan = plan;
    if (opts.apply) {
      // this boot's dir first (its sentinel, the empty class dirs, the dir),
      // then the copies and the flag; a crash midway leaves a state the gate
      // refuses and this can run again
      for (const p of plan) {
        if (p.endsWith("/")) fs.rmdirSync(p.slice(0, -1));
        else fs.unlinkSync(p);
      }
      for (const d of [records, base, stateDir!]) {
        if (lstatOrUndefined(fs, d) != null) fsyncDir(fs, d);
      }
      out.applied = true;
    }
    out.ok = true;
  } catch (err) {
    out.ok = false;
    out.stop = err instanceof Stop ? err.message : `unexpected: ${err}`;
    // nothing was removed unless apply ran: a failure in apply is reported
    // with the plan, and the gate refuses until this runs again
  }
  return out;
}

if (require.main === module) {
  // the post-reboot state dir as the persist resolves it
  const { persistStateDir } = require("./persist-durability");
  const r = recoverFailedRecordsCreation({
    stateDir: persistStateDir(),
    apply: process.argv.includes("--apply"),
  });
  process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  process.exit(r.ok ? 0 : 2);
}
