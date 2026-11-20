/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The persist integrity check also runs in CoCalc Plus on Bun, which has no
// node:sqlite: plus/bun/build.sh refuses a bundle in which anything loads it.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@cocalc/backend/sqlite";
import { INTEGRITY_CHECK_SOURCE } from "@cocalc/backend/conat/persist-durability";

// the check in plus/bun/build.sh
const LOADS_NODE_SQLITE =
  /from ?['"]node:sqlite['"]|require\(['"]node:sqlite['"]\)/;

describe("persist integrity check under Node and Bun", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "persist-integrity-runtime-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("loads sqlite only through @cocalc/backend/sqlite", () => {
    expect(INTEGRITY_CHECK_SOURCE).not.toMatch(LOADS_NODE_SQLITE);
    const source = readFileSync(
      join(__dirname, "../../persist-durability.ts"),
      "utf8",
    );
    expect(source).not.toMatch(LOADS_NODE_SQLITE);
  });

  it("checks exactly the database named on stdin, and refuses other input", () => {
    const path = join(dir, "ok.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE t(x); INSERT INTO t VALUES (1)");
    db.close();
    const run = (input: string, args: string[] = []) =>
      JSON.parse(
        spawnSync(process.execPath, ["-e", INTEGRITY_CHECK_SOURCE, ...args], {
          input,
          encoding: "utf8",
          env: {},
          timeout: 30_000,
        }).stdout,
      );
    expect(run(JSON.stringify({ path }))).toEqual({ ok: true, rows: 1 });
    // an argument is never taken as the path
    expect(run(JSON.stringify({ path }), [join(dir, "other.db")])).toEqual({
      ok: true,
      rows: 1,
    });

    const damaged = join(dir, "damaged.db");
    writeFileSync(damaged, Buffer.alloc(8192, 0xcd));
    expect(run(JSON.stringify({ path: damaged })).ok).toBe(false);

    const refused = { ok: false, error: "expected exactly {path}" };
    for (const input of [
      "",
      "not json",
      "null",
      JSON.stringify([path]),
      JSON.stringify({}),
      JSON.stringify({ path: "" }),
      JSON.stringify({ path: 1 }),
      JSON.stringify({ path, extra: 1 }),
    ]) {
      expect([input, run(input)]).toEqual([input, refused]);
    }
  });
});
