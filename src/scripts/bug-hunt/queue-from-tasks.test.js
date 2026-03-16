const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { executeQueueFromTasks, parseArgs } = require("./queue-from-tasks.js");

test("parseArgs keeps batch-plan flags and queue controls separate", () => {
  const options = parseArgs([
    "--fresh",
    "--area",
    "chat,jupyter",
    "--queue-policy",
    "continue",
    "--failure-policy",
    "continue",
    "--max-errors",
    "2",
    "--dry-run",
    "--json",
  ]);
  assert.deepEqual(options.batchPlanArgs, [
    "--fresh",
    "--area",
    "chat,jupyter",
  ]);
  assert.equal(options.queuePolicy, "continue");
  assert.equal(options.failurePolicy, "continue");
  assert.equal(options.maxErrors, 2);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("executeQueueFromTasks generates a plan then runs the queue", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-qft-"));
  const payload = executeQueueFromTasks(
    {
      batchPlanArgs: ["--fresh", "--limit", "3"],
      queueRoot: path.join(tmp, "queue"),
      queuePolicy: "continue",
      failurePolicy: "continue",
      maxErrors: 2,
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 15, 16, 0, 0),
    {
      runNodeScript(script, args) {
        assert.ok(script.endsWith("batch-plan.js"));
        assert.ok(args.includes("--out"));
        return {
          total_candidates: 3,
          total_batches: 2,
          out_file: args[args.indexOf("--out") + 1],
        };
      },
      executeQueue(queueOptions) {
        assert.equal(queueOptions.plans.length, 1);
        assert.equal(queueOptions.queuePolicy, "continue");
        return {
          queue_dir: queueOptions.queueRoot,
          stopped_early: false,
        };
      },
    },
  );
  assert.equal(payload.batch_plan.total_candidates, 3);
  assert.equal(payload.batch_plan.total_batches, 2);
  assert.ok(
    fs.existsSync(path.join(payload.queue_dir, "queue-from-tasks.json")),
  );
});
