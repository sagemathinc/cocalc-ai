import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("./test-audit.mjs", import.meta.url);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "test-audit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(...args) {
  return spawnSync(process.execPath, [script.pathname, ...args], {
    encoding: "utf8",
    // Saved-report analysis must not need pnpm or a built workspace.
    env: { ...process.env, PATH: "" },
  });
}

function report(status = "passed") {
  return {
    success: status !== "failed",
    numTotalTests: 1,
    testResults: [
      {
        name: "/checkout/packages/example/a.test.ts",
        status,
        startTime: 1000,
        endTime: 3000,
        assertionResults: [
          { fullName: "example assertion", status, duration: 500 },
        ],
      },
    ],
  };
}

test("saved reports are read-only even when --out contains the input", (t) => {
  const dir = fixture(t);
  const file = join(dir, "passing.json");
  const original = JSON.stringify(report());
  writeFileSync(file, original);
  const result = run(`--report=${file}`, `--out=${dir}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /example assertion/);
  assert.equal(readFileSync(file, "utf8"), original);
});

test("a passing retry does not hide the failed attempt", (t) => {
  const dir = fixture(t);
  const failed = join(dir, "attempt-0.json");
  const passed = join(dir, "attempt-1.json");
  writeFileSync(failed, JSON.stringify(report("failed")));
  writeFileSync(passed, JSON.stringify(report()));
  const result = run(`--report=${failed}`, `--report=${passed}`);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /attempt-0.json/);
  assert.match(result.stdout, /attempt-1.json/);
});

test("skipped suites are not failures", (t) => {
  const dir = fixture(t);
  const file = join(dir, "skipped.json");
  writeFileSync(file, JSON.stringify(report("pending")));
  const result = run(`--report=${file}`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Non-Passing \/ Timeout Candidates\n  none/);
});

test("missing, malformed, and non-Jest reports fail explicitly", (t) => {
  const dir = fixture(t);
  const file = join(dir, "bad.json");
  assert.equal(run(`--report=${file}`).status, 1);
  for (const contents of ["not json", "{}", "null"]) {
    writeFileSync(file, contents);
    const result = run(`--report=${file}`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid Jest JSON report/);
  }
});
