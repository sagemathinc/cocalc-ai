import assert from "node:assert/strict";
import test from "node:test";

import {
  BUILD_TRIGGER_COMMAND,
  DEFAULT_BUILD_TRIGGER_TIMEOUT_S,
  MAX_BUILD_LOG_CHARS,
  buildTriggerExecOptions,
  isBuildResultFor,
  normalizeBuildPath,
  summarizeBuildResult,
} from "./build";

test("normalizeBuildPath accepts absolute buildable documents", () => {
  assert.equal(normalizeBuildPath("/root/paper.tex"), "/root/paper.tex");
  assert.equal(normalizeBuildPath("  /root/report.Rmd  "), "/root/report.Rmd");
  assert.equal(normalizeBuildPath("/root/paper.Rnw"), "/root/paper.Rnw");
});

test("normalizeBuildPath requires a non-empty absolute path", () => {
  assert.throws(() => normalizeBuildPath(""), /path must be specified/);
  assert.throws(() => normalizeBuildPath(undefined), /path must be specified/);
  assert.throws(() => normalizeBuildPath("paper.tex"), /path must be absolute/);
});

test("normalizeBuildPath rejects documents with no build action", () => {
  assert.throws(
    () => normalizeBuildPath("/root/notes.md"),
    /is not a buildable document/,
  );
  assert.throws(() => normalizeBuildPath("/root/nb.ipynb"), /tex, rnw/);
});

test("buildTriggerExecOptions starts an async job in the document build group", () => {
  assert.deepEqual(
    buildTriggerExecOptions({ path: "/root/paper.tex", aggregate: 1234 }),
    {
      command: BUILD_TRIGGER_COMMAND,
      bash: true,
      timeout: DEFAULT_BUILD_TRIGGER_TIMEOUT_S,
      err_on_exit: false,
      async_call: true,
      job_group: "build:/root/paper.tex",
      aggregate: 1234,
    },
  );
});

test("buildTriggerExecOptions routes knitr sources to the derived .tex group", () => {
  // the latex editor watches build:<name>.tex even for .Rnw/.Rtex sources
  assert.equal(
    buildTriggerExecOptions({ path: "/root/paper.Rnw", aggregate: 1 })
      .job_group,
    "build:/root/paper.tex",
  );
});

test("buildTriggerExecOptions tags the request with id and path", () => {
  assert.equal(
    buildTriggerExecOptions({
      path: "/root/a.tex",
      aggregate: 1,
      request_id: "req-1",
    }).job_key,
    // the path is carried too, so the .Rnw and .tex editors sharing a build
    // group can tell which of them the request is for
    `build-request:req-1:${encodeURIComponent("/root/a.tex")}`,
  );
  assert.equal(
    "job_key" in buildTriggerExecOptions({ path: "/root/a.tex", aggregate: 1 }),
    false,
  );
});

test("buildTriggerExecOptions honours an explicit timeout", () => {
  assert.equal(
    buildTriggerExecOptions({ path: "/root/a.tex", aggregate: 1, timeout: 5 })
      .timeout,
    5,
  );
});

test("isBuildResultFor only accepts the matching request", () => {
  assert.equal(isBuildResultFor({ request_id: "req-1" } as any, "req-1"), true);
  // an unrelated build finishing in the same group must not be adopted
  assert.equal(
    isBuildResultFor({ request_id: "other" } as any, "req-1"),
    false,
  );
  assert.equal(isBuildResultFor({} as any, "req-1"), false);
  assert.equal(isBuildResultFor(undefined, "req-1"), false);
});

test("summarizeBuildResult reports the pipeline outcome", () => {
  assert.deepEqual(
    summarizeBuildResult({
      request_id: "req-1",
      path: "/root/a.tex",
      exit_code: 12,
      error_count: 2,
      error: "boom",
      log: "latexmk output",
      jobs: [
        { name: "knitr", exit_code: 0 },
        { name: "latex", exit_code: 12 },
      ],
    }),
    {
      exit_code: 12,
      error: "boom",
      error_count: 2,
      log: "latexmk output",
      jobs: [
        { name: "knitr", exit_code: 0 },
        { name: "latex", exit_code: 12 },
      ],
    },
  );
});

test("summarizeBuildResult omits empty fields and truncates a huge log", () => {
  assert.deepEqual(
    summarizeBuildResult({ request_id: "r", path: "/root/a.tex" }),
    {},
  );
  const big = summarizeBuildResult({
    request_id: "r",
    path: "/root/a.tex",
    log: "x".repeat(MAX_BUILD_LOG_CHARS + 100),
  });
  assert.match(big.log ?? "", /truncated 100 chars/);
});

test("isBuildResultFor rejects a reply from the other editor of a knitr pair", () => {
  // paper.Rnw and its generated paper.tex share one build group, so both
  // editors can answer the same request; only the one we asked about counts
  const reply = (path: string) => ({ request_id: "req-1", path }) as any;
  assert.equal(
    isBuildResultFor(reply("/root/paper.Rnw"), "req-1", "/root/paper.Rnw"),
    true,
  );
  assert.equal(
    isBuildResultFor(reply("/root/paper.tex"), "req-1", "/root/paper.Rnw"),
    false,
  );
  assert.equal(
    isBuildResultFor(reply("/root/paper.tex"), "req-1", "/root/paper.tex"),
    true,
  );
});
