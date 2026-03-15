const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildEntry, writeLedgerEntry } = require("./ledger-utils.js");
const { buildRecoverPayload, parseArgs } = require("./recover-iteration.js");

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
}

function initRepo(repo) {
  run("git", ["init"], repo);
  run("git", ["config", "user.name", "Bug Hunt"], repo);
  run("git", ["config", "user.email", "bug-hunt@example.com"], repo);
}

test("parseArgs accepts iteration selectors", () => {
  const options = parseArgs(["--task-id", "task-1", "--json"]);
  assert.equal(options.taskId, "task-1");
  assert.equal(options.json, true);
});

test("buildRecoverPayload compares the snapshot before an iteration to the next snapshot", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-snaps-"));
  const repo = path.join(home, "build", "cocalc-lite2", "src");
  fs.mkdirSync(repo, { recursive: true });
  initRepo(repo);
  fs.writeFileSync(path.join(repo, ".gitignore"), ".agents/bug-hunt/ledger/\n");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
  run("git", ["add", "tracked.txt"], repo);

  const snapshotRoot = path.join(home, ".snapshots");
  const beforeRepo = path.join(
    snapshotRoot,
    "snap-20260315-100001",
    "build",
    "cocalc-lite2",
    "src",
  );
  fs.mkdirSync(path.dirname(beforeRepo), { recursive: true });
  fs.cpSync(repo, beforeRepo, { recursive: true });

  const ledgerRoot = path.join(repo, ".agents", "bug-hunt", "ledger");
  writeLedgerEntry(
    ledgerRoot,
    buildEntry(
      {
        taskId: "task-1",
        area: "bug-hunt",
        result: "bug_fixed",
        ledgerRoot,
      },
      undefined,
      "2026-03-15T10:07:00.000Z",
    ),
  );

  fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");
  const afterRepo = path.join(
    snapshotRoot,
    "snap-20260315-101501",
    "build",
    "cocalc-lite2",
    "src",
  );
  fs.mkdirSync(path.dirname(afterRepo), { recursive: true });
  fs.cpSync(repo, afterRepo, { recursive: true });

  const payload = buildRecoverPayload({
    taskId: "task-1",
    repo,
    ledgerRoot,
    snapshotRoot,
    homeDir: home,
    compareTo: "after-snapshot",
    limit: 10,
  });
  assert.equal(payload.before.name, "snap-20260315-100001");
  assert.equal(payload.after.name, "snap-20260315-101501");
  assert.equal(payload.summary.modified, 1);
  assert.deepEqual(payload.changes, [
    { path: "tracked.txt", status: "modified" },
  ]);
});
