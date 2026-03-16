const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  compareRepoContents,
  mapRepoIntoSnapshot,
  parseSnapshotName,
  selectSnapshotAfter,
  selectSnapshotBefore,
  summarizeChanges,
} = require("./snapshot-utils.js");

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

test("parseSnapshotName decodes snapshot timestamps", () => {
  const parsed = parseSnapshotName("snap-20260315-104501");
  assert.equal(parsed.timestamp, "2026-03-15T10:45:01.000Z");
});

test("mapRepoIntoSnapshot preserves the home-relative repo path", () => {
  const mapped = mapRepoIntoSnapshot(
    "/tmp/home/build/cocalc-lite2/src",
    "/tmp/home/.snapshots/snap-20260315-104501",
    "/tmp/home",
  );
  assert.equal(
    mapped,
    "/tmp/home/.snapshots/snap-20260315-104501/build/cocalc-lite2/src",
  );
});

test("selectSnapshotBefore/After pick surrounding snapshots", () => {
  const snapshots = [
    { name: "a", timestamp_ms: 10 },
    { name: "b", timestamp_ms: 20 },
    { name: "c", timestamp_ms: 30 },
  ];
  assert.equal(selectSnapshotBefore(snapshots, 25).name, "b");
  assert.equal(selectSnapshotAfter(snapshots, 25).name, "c");
});

test("compareRepoContents reports added, modified, and deleted files", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cocalc-bug-hunt-snaps-"));
  const currentRepo = path.join(home, "build", "cocalc-lite2", "src");
  fs.mkdirSync(currentRepo, { recursive: true });
  initRepo(currentRepo);
  fs.writeFileSync(path.join(currentRepo, "tracked.txt"), "before\n");
  fs.writeFileSync(path.join(currentRepo, "delete-me.txt"), "gone soon\n");
  run("git", ["add", "tracked.txt", "delete-me.txt"], currentRepo);

  const snapshotRepo = path.join(
    home,
    ".snapshots",
    "snap-20260315-100001",
    "build",
    "cocalc-lite2",
    "src",
  );
  fs.mkdirSync(path.dirname(snapshotRepo), { recursive: true });
  fs.cpSync(currentRepo, snapshotRepo, { recursive: true });

  fs.writeFileSync(path.join(currentRepo, "tracked.txt"), "after\n");
  fs.unlinkSync(path.join(currentRepo, "delete-me.txt"));
  fs.writeFileSync(path.join(currentRepo, "added.txt"), "new\n");

  const changes = compareRepoContents(snapshotRepo, currentRepo);
  assert.deepEqual(changes, [
    { path: "added.txt", status: "added" },
    { path: "delete-me.txt", status: "deleted" },
    { path: "tracked.txt", status: "modified" },
  ]);
  assert.deepEqual(summarizeChanges(changes), {
    total: 3,
    added: 1,
    deleted: 1,
    modified: 1,
  });
});
