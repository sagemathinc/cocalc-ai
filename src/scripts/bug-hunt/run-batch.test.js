const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildIterationCommand,
  executeBatchPlan,
  parseArgs,
} = require("./run-batch.js");

test("parseArgs accepts runner controls", () => {
  const options = parseArgs([
    "--plan",
    "/tmp/plan.json",
    "--batch-id",
    "batch-chat-hub-01",
    "--max-tasks",
    "2",
    "--dry-run",
    "--json",
  ]);
  assert.equal(options.plan, "/tmp/plan.json");
  assert.equal(options.batchId, "batch-chat-hub-01");
  assert.equal(options.maxTasks, 2);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});

test("buildIterationCommand uses the batch runner and task artifact label", () => {
  const args = buildIterationCommand(
    {
      default_runner: {
        kind: "run-plan",
        plan: "seeded-chat-smoke",
        seed: "chat",
      },
    },
    { task_id: "task-1", artifact_label: "batch-chat-either-01-task-1" },
    "/tmp/context.json",
    "/tmp/run/batch-chat-either-01",
    true,
  );
  assert.deepEqual(args, [
    "--plan",
    "seeded-chat-smoke",
    "--context-file",
    "/tmp/context.json",
    "--artifact-root",
    "/tmp/run/batch-chat-either-01/batch-chat-either-01-task-1/artifacts",
    "--name",
    "task-1",
    "--json",
    "--seed",
    "chat",
    "--dry-run",
  ]);
});

test("executeBatchPlan writes a dry-run batch summary", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-run-batch-"),
  );
  const planFile = path.join(tmp, "plan.json");
  fs.writeFileSync(
    planFile,
    `${JSON.stringify(
      {
        batches: [
          {
            batch_id: "batch-chat-either-01",
            area: "chat",
            environment: "either",
            preferred_mode: "lite",
            default_runner: {
              kind: "run-plan",
              plan: "seeded-chat-smoke",
              seed: "chat",
            },
            tasks: [
              {
                task_id: "task-1",
                artifact_label: "batch-chat-either-01-task-1",
                note_flags: ["--task-id", "task-1", "--area", "chat"],
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  const payload = executeBatchPlan(
    {
      plan: planFile,
      batchId: "",
      maxTasks: 0,
      runRoot: path.join(tmp, "runs"),
      dryRun: true,
      json: true,
    },
    Date.UTC(2026, 2, 15, 13, 0, 0),
  );
  assert.equal(payload.batches.length, 1);
  assert.equal(payload.batches[0].default_runner.plan, "seeded-chat-smoke");
  assert.equal(payload.batches[0].iterations.length, 1);
  assert.deepEqual(payload.batches[0].iterations[0].note_flags, [
    "--task-id",
    "task-1",
    "--area",
    "chat",
  ]);
  assert.ok(
    fs.existsSync(
      path.join(payload.run_dir, "batch-chat-either-01", "batch-result.json"),
    ),
  );
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-summary.json")));
});
