const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildIterationCommand,
  executeBatchPlan,
  parseArgs,
  summarizeRun,
} = require("./run-batch.js");

test("parseArgs accepts runner controls", () => {
  const options = parseArgs([
    "--plan",
    "/tmp/plan.json",
    "--batch-id",
    "batch-chat-hub-01",
    "--max-tasks",
    "2",
    "--failure-policy",
    "continue",
    "--max-errors",
    "3",
    "--dry-run",
    "--json",
  ]);
  assert.equal(options.plan, "/tmp/plan.json");
  assert.equal(options.batchId, "batch-chat-hub-01");
  assert.equal(options.maxTasks, 2);
  assert.equal(options.failurePolicy, "continue");
  assert.equal(options.maxErrors, 3);
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
  assert.ok(fs.existsSync(path.join(payload.run_dir, "run-ledger.json")));
  assert.equal(payload.failure_count, 0);
  assert.equal(payload.stopped_early, false);
});

test("executeBatchPlan can continue after an iteration failure", () => {
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
              },
              {
                task_id: "task-2",
                artifact_label: "batch-chat-either-01-task-2",
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  let calls = 0;
  const payload = executeBatchPlan(
    {
      plan: planFile,
      batchId: "",
      maxTasks: 0,
      runRoot: path.join(tmp, "runs"),
      failurePolicy: "continue",
      maxErrors: 2,
      dryRun: false,
      json: true,
    },
    Date.UTC(2026, 2, 15, 13, 0, 0),
    {
      runNodeScript(script) {
        calls += 1;
        if (script.endsWith("attach.js")) {
          return { ok: true, browser_id: "browser-1" };
        }
        if (calls === 2) {
          throw new Error("simulated run-plan failure");
        }
        return { ok: true, artifact_dir: "/tmp/artifact" };
      },
    },
  );
  assert.equal(payload.failure_count, 1);
  assert.equal(payload.stopped_early, false);
  assert.equal(payload.batches[0].iterations.length, 2);
  assert.equal(payload.batches[0].iterations[0].ok, false);
  assert.equal(payload.batches[0].iterations[1].ok, true);
});

test("executeBatchPlan stops once maxErrors is reached", () => {
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
              },
              {
                task_id: "task-2",
                artifact_label: "batch-chat-either-01-task-2",
              },
            ],
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  let calls = 0;
  const payload = executeBatchPlan(
    {
      plan: planFile,
      batchId: "",
      maxTasks: 0,
      runRoot: path.join(tmp, "runs"),
      failurePolicy: "continue",
      maxErrors: 1,
      dryRun: false,
      json: true,
    },
    Date.UTC(2026, 2, 15, 13, 0, 0),
    {
      runNodeScript(script) {
        calls += 1;
        if (script.endsWith("attach.js")) {
          return { ok: true, browser_id: "browser-1" };
        }
        throw new Error(`simulated run-plan failure ${calls}`);
      },
    },
  );
  assert.equal(payload.failure_count, 1);
  assert.equal(payload.stopped_early, true);
  assert.match(payload.stop_reason, /max errors reached/);
  assert.equal(payload.batches[0].iterations.length, 1);
});

test("summarizeRun produces a compact run ledger payload", () => {
  const summary = summarizeRun({
    started_at: "2026-03-15T12:00:00.000Z",
    finished_at: "2026-03-15T12:05:00.000Z",
    run_dir: "/tmp/run",
    plan_file: "/tmp/plan.json",
    dry_run: true,
    failure_policy: "continue",
    max_errors: 3,
    failure_count: 1,
    stopped_early: false,
    stop_reason: "",
    batches: [
      { batch_id: "batch-chat-either-01", completed: true },
      { batch_id: "batch-jupyter-either-01", completed: false },
    ],
  });
  assert.equal(summary.run_id, "run");
  assert.equal(summary.completed_batches, 1);
  assert.deepEqual(summary.batch_ids, [
    "batch-chat-either-01",
    "batch-jupyter-either-01",
  ]);
});
