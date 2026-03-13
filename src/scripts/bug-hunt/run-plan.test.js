const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  buildHarnessArgs,
  createArtifactDirName,
  parseArgs,
  planNameFromPath,
  resolvePlanFile,
  resolveSeedTypes,
} = require("./run-plan.js");

test("parseArgs ignores a leading pnpm separator", () => {
  const options = parseArgs([
    "--",
    "--plan",
    "seeded-files-smoke",
    "--seed",
    "files,tasks",
    "--json",
  ]);
  assert.equal(options.plan, "seeded-files-smoke");
  assert.deepEqual(options.seedTypes, ["files", "tasks"]);
  assert.equal(options.json, true);
});

test("resolveSeedTypes expands all and rejects duplicates", () => {
  assert.deepEqual(resolveSeedTypes("all"), [
    "chat",
    "jupyter",
    "tasks",
    "files",
    "whiteboard",
  ]);
  assert.deepEqual(resolveSeedTypes("files,files,chat"), ["files", "chat"]);
});

test("resolvePlanFile maps plan names into the repo plan directory", () => {
  const resolved = resolvePlanFile("seeded-files-smoke");
  assert.equal(
    resolved,
    path.join(
      "/home/wstein/build/cocalc-lite2/src/.agents/bug-hunt/plans",
      "seeded-files-smoke.json",
    ),
  );
});

test("planNameFromPath strips json suffix", () => {
  assert.equal(
    planNameFromPath("/tmp/bug-hunt/seeded-files-smoke.json"),
    "seeded-files-smoke",
  );
});

test("createArtifactDirName includes context and plan names", () => {
  const value = createArtifactDirName(
    Date.UTC(2026, 2, 13, 6, 7, 8),
    { mode: "lite", browser_mode: "spawned" },
    "seeded-files-smoke",
    "manual",
  );
  assert.match(
    value,
    /^2026-03-13T06-07-08-000Z-lite-spawned-plan-seeded-files-smoke-manual$/,
  );
});

test("buildHarnessArgs pins the selected browser and report dir", () => {
  const args = buildHarnessArgs(
    {
      dryRun: true,
      defaultRetries: "2",
      defaultTimeout: "30s",
      defaultRecovery: "reload",
      maxFailures: "1",
      logsOnFail: "50",
      networkOnFail: "25",
      screenshotOnFail: false,
      pinTarget: false,
      allowRawExec: true,
    },
    {
      browser_id: "browser-1",
      project_id: "project-1",
    },
    "/tmp/plan.json",
    "/tmp/report",
  );
  assert.deepEqual(args, [
    "browser",
    "harness",
    "run",
    "--plan",
    "/tmp/plan.json",
    "--browser",
    "browser-1",
    "--project-id",
    "project-1",
    "--report-dir",
    "/tmp/report",
    "--active-only",
    "--dry-run",
    "--default-retries",
    "2",
    "--default-timeout",
    "30s",
    "--default-recovery",
    "reload",
    "--max-failures",
    "1",
    "--logs-on-fail",
    "50",
    "--network-on-fail",
    "25",
    "--no-screenshot-on-fail",
    "--no-pin-target",
    "--allow-raw-exec",
  ]);
});
