const assert = require("node:assert/strict");
const {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const { pruneCache } = require("./tools-cache-prune.cjs");

const HASHES = ["a", "b", "c", "d"].map((value) => value.repeat(64));
const roots = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "cocalc-tools-cache-"));
  roots.push(root);
  return root;
}

function makeEntry(root, name, { ageMs, bytes, now }) {
  const directory = path.join(root, name);
  mkdirSync(path.join(directory, "bin"), { recursive: true });
  writeFileSync(path.join(directory, "bin", "tool"), Buffer.alloc(bytes));
  const time = new Date(now - ageMs);
  utimesSync(directory, time, time);
  return directory;
}

test("retains the newest cache generations in each family", async () => {
  const root = makeRoot();
  const now = Date.now();
  const family = "tools-linux-amd64-all";
  const oldest = makeEntry(root, `${family}-${HASHES[0]}`, {
    ageMs: 4_000,
    bytes: 10,
    now,
  });
  makeEntry(root, `${family}-${HASHES[1]}`, {
    ageMs: 3_000,
    bytes: 10,
    now,
  });
  makeEntry(root, `${family}-${HASHES[2]}`, {
    ageMs: 2_000,
    bytes: 10,
    now,
  });

  const result = await pruneCache({
    cacheRoot: root,
    retentionCount: 2,
    maxBytes: 1_000,
    minAgeMs: 0,
    now,
  });

  assert.deepEqual(
    result.removed.map(({ path: entryPath }) => entryPath),
    [oldest],
  );
  assert.equal(result.entryCount, 2);
});

test("protects current and recently touched cache entries", async () => {
  const root = makeRoot();
  const now = Date.now();
  const family = "tools-linux-arm64-all";
  const protectedPath = makeEntry(root, `${family}-${HASHES[0]}`, {
    ageMs: 10_000,
    bytes: 10,
    now,
  });
  const recentPath = makeEntry(root, `${family}-${HASHES[1]}`, {
    ageMs: 100,
    bytes: 10,
    now,
  });
  const removablePath = makeEntry(root, `${family}-${HASHES[2]}`, {
    ageMs: 5_000,
    bytes: 10,
    now,
  });

  const result = await pruneCache({
    cacheRoot: root,
    protectedPaths: [protectedPath],
    retentionCount: 0,
    maxBytes: 0,
    minAgeMs: 1_000,
    now,
  });

  assert.deepEqual(
    result.removed.map(({ path: entryPath }) => entryPath),
    [removablePath],
  );
  assert.equal(result.entryCount, 2);
  assert.equal(result.overLimit, true);
  assert.equal(existsSync(protectedPath), true);
  assert.equal(existsSync(recentPath), true);
});

test("enforces the global byte limit using least-recently-used order", async () => {
  const root = makeRoot();
  const now = Date.now();
  const oldest = makeEntry(root, `tools-linux-amd64-all-${HASHES[0]}`, {
    ageMs: 4_000,
    bytes: 100,
    now,
  });
  makeEntry(root, `tools-linux-amd64-all-${HASHES[1]}`, {
    ageMs: 1_000,
    bytes: 100,
    now,
  });
  makeEntry(root, `tools-linux-arm64-all-${HASHES[2]}`, {
    ageMs: 3_000,
    bytes: 100,
    now,
  });

  const result = await pruneCache({
    cacheRoot: root,
    retentionCount: 2,
    maxBytes: 250,
    minAgeMs: 0,
    now,
  });

  assert.equal(result.removed[0].path, oldest);
  assert.equal(result.removed[0].reason, "size");
  assert.equal(result.totalBytes, 200);
  assert.equal(result.overLimit, false);
});

test("ignores unknown directories, temporary directories, and symlinks", async () => {
  const root = makeRoot();
  const now = Date.now();
  const unknown = makeEntry(root, "unrelated-data", {
    ageMs: 10_000,
    bytes: 100,
    now,
  });
  makeEntry(root, `tools-linux-amd64-all-${HASHES[0]}.tmp.123`, {
    ageMs: 10_000,
    bytes: 100,
    now,
  });
  symlinkSync(unknown, path.join(root, `tools-linux-amd64-all-${HASHES[1]}`));

  const result = await pruneCache({
    cacheRoot: root,
    retentionCount: 0,
    maxBytes: 0,
    minAgeMs: 0,
    now,
  });

  assert.equal(result.removed.length, 0);
  assert.equal(result.entryCount, 0);
});
