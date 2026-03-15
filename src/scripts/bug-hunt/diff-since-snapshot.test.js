const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildDiffPayload, parseArgs } = require("./diff-since-snapshot.js");

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

test("parseArgs requires a snapshot", () => {
  const options = parseArgs(["--snapshot", "snap-20260315-100001", "--json"]);
  assert.equal(options.snapshot, "snap-20260315-100001");
  assert.equal(options.json, true);
});

test("buildDiffPayload compares the current repo to the selected snapshot", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-snaps-"));
  const repo = path.join(home, "build", "cocalc-lite2", "src");
  fs.mkdirSync(repo, { recursive: true });
  initRepo(repo);
  fs.writeFileSync(path.join(repo, "tracked.txt"), "before\n");
  run("git", ["add", "tracked.txt"], repo);

  const snapshotRoot = path.join(home, ".snapshots");
  const snapshotRepo = path.join(
    snapshotRoot,
    "snap-20260315-100001",
    "build",
    "cocalc-lite2",
    "src",
  );
  fs.mkdirSync(path.dirname(snapshotRepo), { recursive: true });
  fs.cpSync(repo, snapshotRepo, { recursive: true });

  fs.writeFileSync(path.join(repo, "tracked.txt"), "after\n");
  const payload = buildDiffPayload({
    snapshot: "snap-20260315-100001",
    repo,
    snapshotRoot,
    homeDir: home,
    limit: 10,
  });
  assert.equal(payload.summary.modified, 1);
  assert.deepEqual(payload.changes, [
    { path: "tracked.txt", status: "modified" },
  ]);
});
