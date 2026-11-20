/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The multibay records root (finding 028, ALT-D2; review B9): one rule for
// CI and local runs, outside tmpdir(), checked with the persist's own gate
// (the built backend).  The full walk from / is machine-specific; it runs in
// MultibayCluster.init() on the real runner, which prints every ancestor.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  SRC,
  bayRecordsPaths,
  describeAncestors,
  multibayRecordsRoot,
} from "./cluster.mjs";

const require = createRequire(import.meta.url);
const { evaluateRecordsGate } = require(
  path.join(SRC, "packages/backend/dist/conat/persist-records-root.js"),
);

describe("multibay records root", () => {
  it("default and explicit selection", () => {
    assert.equal(
      multibayRecordsRoot({}, "/home/u"),
      "/home/u/.cache/cocalc-multibay-records",
    );
    assert.equal(multibayRecordsRoot({ MULTIBAY_RECORDS_DIR: "/srv/mb/" }, "/home/u"), "/srv/mb");
    assert.equal(multibayRecordsRoot({ MULTIBAY_RECORDS_DIR: "" }, "/home/u"), "/home/u/.cache/cocalc-multibay-records");
    // the default is not below tmpdir()
    const def = multibayRecordsRoot();
    const t = tmpdir();
    assert.ok(!(def === t || def.startsWith(t + "/")), `${def} is below ${t}`);
    assert.ok(describeAncestors(def).length >= 2);
  });

  it("the selector's own results through the gate predicate: the default (a fake home), an explicit safe root pass; an explicit root below TMPDIR (R-c) and one under a group-writable dir (T1) are refused", () => {
    // the gate on a bay's paths below a selected root, exactly as
    // MultibayCluster does (bayRecordsPaths, the env it gives the hubs);
    // the walk starts at `bound` (the host's own ancestors are init()'s
    // real-walk record on the runner, and staging2's)
    const gateFor = (recordsRoot, bound) => {
      const recordsDir = path.join(recordsRoot, "mb-test");
      const { base, stateDir } = bayRecordsPaths(recordsDir, "bay-0");
      mkdirSync(path.join(recordsDir, "bay-0"), { recursive: true, mode: 0o700 });
      return evaluateRecordsGate({
        env: {
          COCALC_PERSIST_RECORDS_BASE: base,
          COCALC_PERSIST_RUN_DIR: path.join(recordsDir, "no-legacy"),
          TMPDIR: tmpdir(),
        },
        stateDir,
        dataDir: path.join(recordsDir, "data"),
        retries: 0,
        walkFrom: bound,
      });
    };
    mkdirSync(path.join(homedir(), ".cache"), { recursive: true, mode: 0o700 });
    const scratch = mkdtempSync(path.join(homedir(), ".cache", "mb-records-test-"));
    const inTmp = mkdtempSync(path.join(tmpdir(), "mb-records-"));
    try {
      // 1. the DEFAULT selection, for a home outside tmpdir()
      const fakeHome = path.join(scratch, "home");
      mkdirSync(fakeHome, { mode: 0o700 });
      const def = multibayRecordsRoot({}, fakeHome);
      assert.equal(def, path.join(fakeHome, ".cache", "cocalc-multibay-records"));
      mkdirSync(def, { recursive: true, mode: 0o700 });
      const g1 = gateFor(def, scratch);
      assert.equal(g1.ok, true, `${g1.code}: ${g1.reason}`);
      assert.equal(g1.t1, "pass");
      // 2. an EXPLICIT safe root
      const explicitSafe = multibayRecordsRoot({ MULTIBAY_RECORDS_DIR: path.join(scratch, "explicit") }, fakeHome);
      mkdirSync(explicitSafe, { mode: 0o700 });
      const g2 = gateFor(explicitSafe, scratch);
      assert.equal(g2.ok, true, `${g2.code}: ${g2.reason}`);
      // 3. an EXPLICIT root below TMPDIR: R-c
      const explicitTmp = multibayRecordsRoot({ MULTIBAY_RECORDS_DIR: path.join(inTmp, "records") }, fakeHome);
      mkdirSync(explicitTmp, { mode: 0o700 });
      const g3 = gateFor(explicitTmp, inTmp);
      assert.equal(g3.ok, false);
      assert.equal(g3.code, "records_root_project_visible");
      // 4. an EXPLICIT root under a group-writable directory: T1
      const loose = path.join(scratch, "loose");
      mkdirSync(loose, { mode: 0o700 });
      chmodSync(loose, 0o775);
      const explicitLoose = multibayRecordsRoot({ MULTIBAY_RECORDS_DIR: path.join(loose, "records") }, fakeHome);
      mkdirSync(explicitLoose, { mode: 0o700 });
      const g4 = gateFor(explicitLoose, scratch);
      assert.equal(g4.ok, false);
      assert.equal(g4.code, "t1_failed");
      assert.equal(g4.t1, `fail: ${loose}: group/other-writable (mode 775)`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(inTmp, { recursive: true, force: true });
    }
  });
});
