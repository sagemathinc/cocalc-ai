const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  main,
  buildBatches,
  createBatchId,
  parseArgs,
  recommendRunner,
} = require("./batch-plan.js");

test("parseArgs keeps extractor flags and batch settings", () => {
  const options = parseArgs([
    "--fresh",
    "--area",
    "chat,jupyter",
    "--batch-size",
    "2",
    "--out",
    "/tmp/plan.json",
    "--json",
  ]);
  assert.equal(options.extract.freshOnly, true);
  assert.deepEqual(options.extract.areas, ["chat", "jupyter"]);
  assert.equal(options.batchSize, 2);
  assert.equal(options.out, "/tmp/plan.json");
});

test("createBatchId is stable and filesystem safe", () => {
  assert.equal(
    createBatchId("frontend/chat", "hub", 2),
    "batch-frontend-chat-hub-02",
  );
});

test("recommendRunner picks seeded plans for core editor areas", () => {
  assert.deepEqual(recommendRunner("chat"), {
    kind: "run-plan",
    plan: "seeded-chat-smoke",
    seed: "chat",
  });
  assert.deepEqual(recommendRunner("jupyter"), {
    kind: "run-plan",
    plan: "seeded-jupyter-smoke",
    seed: "jupyter",
  });
  assert.deepEqual(recommendRunner("general"), {
    kind: "run-plan",
    plan: "session-smoke",
    seed: "",
  });
});

test("buildBatches groups by area and environment and chunks by size", () => {
  const batches = buildBatches(
    [
      {
        task_id: "chat-1",
        title: "chat one",
        area: "chat",
        environment: "hub",
        severity: "blocker",
        status_hint: "fresh",
        score: 200,
      },
      {
        task_id: "chat-2",
        title: "chat two",
        area: "chat",
        environment: "hub",
        severity: "high",
        status_hint: "fresh",
        score: 150,
      },
      {
        task_id: "chat-3",
        title: "chat three",
        area: "chat",
        environment: "hub",
        severity: "medium",
        status_hint: "fresh",
        score: 120,
      },
      {
        task_id: "jupyter-1",
        title: "jupyter one",
        area: "jupyter",
        environment: "lite",
        severity: "high",
        status_hint: "fresh",
        score: 130,
      },
    ],
    { batchSize: 2 },
  );
  assert.equal(batches.length, 3);
  assert.equal(batches[0].batch_id, "batch-chat-hub-01");
  assert.deepEqual(
    batches[0].tasks.map((task) => task.task_id),
    ["chat-1", "chat-2"],
  );
  assert.equal(batches[1].batch_id, "batch-chat-hub-02");
  assert.equal(batches[2].preferred_mode, "lite");
  assert.equal(batches[0].default_runner.plan, "seeded-chat-smoke");
});

test("main writes a batch plan file", () => {
  const tmp = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-batches-"),
  );
  const tasksFile = path.join(tmp, "tasks.jsonl");
  fs.writeFileSync(
    tasksFile,
    [
      JSON.stringify({
        task_id: "chat-1",
        done: false,
        deleted: false,
        desc: "#bug #chat #0 send button breaks",
        last_edited: Date.UTC(2026, 2, 15),
      }),
      JSON.stringify({
        task_id: "jupyter-1",
        done: false,
        deleted: false,
        desc: "#bug #jupyter #1 kernel warning issue",
        last_edited: Date.UTC(2026, 2, 15),
      }),
    ].join("\n"),
  );
  const out = path.join(tmp, "plan.json");
  const payload = main(
    [
      "--tasks",
      tasksFile,
      "--fresh",
      "--batch-size",
      "1",
      "--out",
      out,
      "--json",
    ],
    Date.UTC(2026, 2, 15, 12, 0, 0),
  );
  assert.equal(payload.total_batches, 2);
  assert.ok(fs.existsSync(out));
});
