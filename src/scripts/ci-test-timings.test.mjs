import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { slowestFiles, summaryMarkdown } from "./ci-test-timings.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function report(dir, name, results) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, name),
    JSON.stringify({
      testResults: results.map(([file, seconds]) => ({
        name: join(REPO_ROOT, file),
        startTime: 1_000,
        endTime: 1_000 + seconds * 1000,
      })),
    }),
  );
}

test("keeps each file's slowest run, across shards and retries, slowest first", () => {
  const dir = mkdtempSync(join(tmpdir(), "ci-timings-"));
  try {
    const server = join(dir, "shard-1-of-3", "packages-server");
    report(server, "jest-results-0.json", [
      ["src/packages/server/a.test.ts", 99],
      ["src/packages/server/b.test.ts", 2],
    ]);
    // A retry of a failed file: its slower run counts.
    report(server, "jest-results-1.json", [
      ["src/packages/server/b.test.ts", 5],
    ]);
    report(join(dir, "packages-util"), "jest-results-0.json", [
      ["src/packages/util/c.test.ts", 30],
    ]);
    // Not a Jest report, and an interrupted one.
    writeFileSync(join(server, "attempt-0.json"), "{}");
    writeFileSync(join(server, "jest-results-2.json"), "{");
    assert.deepEqual(slowestFiles(dir), [
      { file: "src/packages/server/a.test.ts", seconds: 99 },
      { file: "src/packages/util/c.test.ts", seconds: 30 },
      { file: "src/packages/server/b.test.ts", seconds: 5 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing report directory has no timings", () => {
  assert.deepEqual(slowestFiles(join(tmpdir(), "ci-timings-missing-x")), []);
});

test("the summary lists the top files and marks those over budget", () => {
  const markdown = summaryMarkdown(
    [
      { file: "src/packages/server/a.test.ts", seconds: 99 },
      { file: "src/packages/util/c.test.ts", seconds: 30 },
      { file: "src/packages/server/b.test.ts", seconds: 5 },
    ],
    { top: 2, budget: 60, title: "Slowest test files (server-1)" },
  );
  assert.match(markdown, /### Slowest test files \(server-1\)/);
  assert.match(markdown, /3 files, 134 s in total/);
  assert.match(
    markdown,
    /\| 99\.0 \| over budget \| `src\/packages\/server\/a\.test\.ts` \|/,
  );
  assert.match(
    markdown,
    /\| 30\.0 \| {2}\| `src\/packages\/util\/c\.test\.ts` \|/,
  );
  assert.doesNotMatch(markdown, /b\.test\.ts/);
});
