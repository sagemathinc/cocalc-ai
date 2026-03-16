const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  createPlanRunRoot,
  executeQueue,
  listPlanFiles,
  parseArgs,
  summarizeQueue,
} = require("./run-queue.js");

test("parseArgs accepts queue controls", () => {
  const options = parseArgs([
    "--plan",
    "/tmp/one.json",
    "--plan",
    "/tmp/two.json",
    "--queue-policy",
    "continue",
    "--failure-policy",
    "continue",
    "--max-errors",
    "3",
    "--dry-run",
    "--json",
  ]);
  assert.deepEqual(options.plans, ["/tmp/one.json", "/tmp/two.json"]);
  assert.equal(options.queuePolicy, "continue");
  assert.equal(options.failurePolicy, "continue");
  assert.equal(options.maxErrors, 3);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("listPlanFiles merges explicit plans and plan-dir entries", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-queue-"));
  const a = path.join(tmp, "a.json");
  const b = path.join(tmp, "b.json");
  fs.writeFileSync(a, "{}\n");
  fs.writeFileSync(b, "{}\n");
  const plans = listPlanFiles({ plans: [a], planDir: tmp });
  assert.deepEqual(plans, [a, b]);
});

test("createPlanRunRoot creates stable per-plan subdirectories", () => {
  assert.equal(
    createPlanRunRoot("/tmp/queue", 1, "/tmp/My Plan.json"),
    "/tmp/queue/runs/02-my-plan",
  );
});

test("executeQueue writes queue summaries for dry runs", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-queue-"));
  const planOne = path.join(tmp, "one.json");
  const planTwo = path.join(tmp, "two.json");
  fs.writeFileSync(planOne, "{}\n");
  fs.writeFileSync(planTwo, "{}\n");
  const payload = executeQueue(
    {
      plans: [planOne, planTwo],
      planDir: "",
      queueRoot: path.join(tmp, "queue"),
      queuePolicy: "continue",
      failurePolicy: "continue",
      maxErrors: 2,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 15, 15, 0, 0),
    {
      executeBatchPlan(batchOptions) {
        return {
          run_dir: batchOptions.runRoot,
          failure_count: 0,
          stopped_early: false,
          stop_reason: "",
        };
      },
    },
  );
  assert.equal(payload.plans.length, 2);
  assert.equal(payload.total_plan_failures, 0);
  assert.equal(payload.total_iteration_failures, 0);
  assert.ok(fs.existsSync(path.join(payload.queue_dir, "queue-summary.json")));
  assert.ok(fs.existsSync(path.join(payload.queue_dir, "queue-ledger.json")));
});

test("executeQueue can stop after the first failed plan", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-queue-"));
  const planOne = path.join(tmp, "one.json");
  const planTwo = path.join(tmp, "two.json");
  fs.writeFileSync(planOne, "{}\n");
  fs.writeFileSync(planTwo, "{}\n");
  const payload = executeQueue(
    {
      plans: [planOne, planTwo],
      planDir: "",
      queueRoot: path.join(tmp, "queue"),
      queuePolicy: "stop",
      failurePolicy: "continue",
      maxErrors: 2,
      dryRun: false,
      json: true,
    },
    Date.UTC(2026, 2, 15, 15, 0, 0),
    {
      executeBatchPlan(batchOptions) {
        if (batchOptions.plan === planOne) {
          return {
            run_dir: batchOptions.runRoot,
            failure_count: 1,
            stopped_early: true,
            stop_reason: "iteration failed",
          };
        }
        return {
          run_dir: batchOptions.runRoot,
          failure_count: 0,
          stopped_early: false,
          stop_reason: "",
        };
      },
    },
  );
  assert.equal(payload.plans.length, 1);
  assert.equal(payload.stopped_early, true);
  assert.match(payload.stop_reason, /queue stopped/);
});

test("summarizeQueue returns the compact top-level record", () => {
  const summary = summarizeQueue({
    started_at: "2026-03-15T15:00:00.000Z",
    finished_at: "2026-03-15T15:05:00.000Z",
    queue_dir: "/tmp/queue",
    dry_run: true,
    queue_policy: "continue",
    batch_failure_policy: "continue",
    max_errors: 2,
    total_plan_failures: 1,
    total_iteration_failures: 3,
    stopped_early: false,
    stop_reason: "",
    plans: [
      { plan_file: "/tmp/one.json", completed: true },
      { plan_file: "/tmp/two.json", completed: false },
    ],
  });
  assert.equal(summary.queue_id, "queue");
  assert.equal(summary.completed_plans, 1);
  assert.deepEqual(summary.plan_files, ["/tmp/one.json", "/tmp/two.json"]);
});
