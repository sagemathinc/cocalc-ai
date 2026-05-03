const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildEntry, readJson, writeLedgerEntry } = require("./ledger-utils.js");
const { main, parseArgs, wantsJson } = require("./commit.js");

function run(cmd, args, cwd) {
  const result = cp.spawnSync(cmd, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${`${result.stderr ?? ""}`.trim() || `${result.stdout ?? ""}`.trim()}`,
    );
  }
  return `${result.stdout ?? ""}`.trim();
}

test("parseArgs accepts commit helper flags", () => {
  const options = parseArgs([
    "--task-id",
    "task-1",
    "--subject",
    "frontend/chat: fix bug",
    "--body",
    "details",
    "--path",
    "src/file.ts",
    "--json",
  ]);
  assert.equal(options.taskId, "task-1");
  assert.equal(options.subject, "frontend/chat: fix bug");
  assert.deepEqual(options.body, ["details"]);
  assert.equal(options.paths.length, 1);
  assert.equal(options.json, true);
});

test("wantsJson ignores a leading pnpm separator", () => {
  assert.equal(wantsJson(["--", "--task-id", "task-1", "--json"]), true);
  assert.equal(wantsJson(["--task-id", "task-1"]), false);
});

test("main commits staged paths and updates the matching ledger entry", () => {
  const repo = fs.mkdtempSync(
    path.join(os.tmpdir(), "cocalc-bug-hunt-commit-"),
  );
  run("git", ["init"], repo);
  run("git", ["config", "user.name", "Bug Hunt"], repo);
  run("git", ["config", "user.email", "bug-hunt@example.com"], repo);
  const file = path.join(repo, "demo.txt");
  fs.writeFileSync(file, "before\n");
  run("git", ["add", "demo.txt"], repo);
  run("git", ["commit", "-m", "init"], repo);

  const ledgerRoot = path.join(repo, ".agents", "bug-hunt", "ledger");
  const entry = buildEntry(
    {
      taskId: "task-1",
      area: "chat",
      result: "bug_fixed",
      ledgerRoot,
    },
    undefined,
    "2026-03-13T02:00:00.000Z",
  );
  const paths = writeLedgerEntry(ledgerRoot, entry);

  fs.writeFileSync(file, "after\n");
  const payload = main([
    "--repo",
    repo,
    "--ledger-root",
    ledgerRoot,
    "--task-id",
    "task-1",
    "--subject",
    "frontend/chat: save the fix",
    "--body",
    "Record the validated bug-hunt change.",
    "--path",
    file,
    "--json",
  ]);

  const head = run("git", ["rev-parse", "HEAD"], repo);
  const ledger = readJson(paths.json, "ledger entry");
  assert.equal(payload.commit_sha, head);
  assert.equal(ledger.commit_sha, head);
  assert.match(
    run("git", ["log", "-1", "--pretty=%s"], repo),
    /frontend\/chat: save the fix/,
  );
});

test("cli keeps --json failures machine-readable", () => {
  const script = path.join(__dirname, "commit.js");
  const result = cp.spawnSync(
    process.execPath,
    [script, "--task-id", "missing-task", "--subject", "smoke", "--json"],
    {
      cwd: path.resolve(__dirname, "..", ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(result.status, 1);
  assert.equal(`${result.stderr ?? ""}`.trim(), "");
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.match(parsed.error.message, /no matching ledger entry found/);
});
