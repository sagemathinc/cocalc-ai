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

import { SRC, describeAncestors, multibayRecordsRoot } from "./cluster.mjs";

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

  it("the gate's R-c refuses a root below tmpdir() and accepts one outside it; T1 refuses a writable ancestor", () => {
    const gate = (root, extra = {}) => {
      const base = path.join(root, "bay-0", "persist-durability");
      const stateDir = path.join(root, "bay-0", "persist-state");
      mkdirSync(path.join(root, "bay-0"), { recursive: true, mode: 0o700 });
      return evaluateRecordsGate({
        env: {
          COCALC_PERSIST_RECORDS_BASE: base,
          COCALC_PERSIST_RUN_DIR: path.join(root, "no-legacy"),
          TMPDIR: tmpdir(),
        },
        stateDir,
        dataDir: path.join(root, "data"),
        retries: 0,
        // the machine's own ancestors are init()'s concern: walk from root
        walkFrom: root,
        ...extra,
      });
    };
    mkdirSync(path.join(homedir(), ".cache"), { recursive: true, mode: 0o700 });
    const outside = mkdtempSync(path.join(multibayRecordsRoot({}, homedir()) + "-test-"));
    const inside = mkdtempSync(path.join(tmpdir(), "mb-records-"));
    try {
      const ok = gate(outside);
      assert.equal(ok.ok, true, `${ok.code}: ${ok.reason}`);
      assert.equal(ok.t1, "pass");
      const refused = gate(inside);
      assert.equal(refused.ok, false);
      assert.equal(refused.code, "records_root_project_visible");
      // a group-writable directory between the root and the base
      const loose = mkdtempSync(path.join(multibayRecordsRoot({}, homedir()) + "-loose-"));
      try {
        mkdirSync(path.join(loose, "bay-0"), { mode: 0o700 });
        chmodSync(path.join(loose, "bay-0"), 0o775);
        const t1 = gate(loose);
        assert.equal(t1.ok, false);
        assert.equal(t1.code, "t1_failed");
      } finally {
        rmSync(loose, { recursive: true, force: true });
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
      rmSync(inside, { recursive: true, force: true });
    }
  });
});
