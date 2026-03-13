const test = require("node:test");
const assert = require("node:assert/strict");

const {
  FIXTURE_TYPES,
  buildFixturePlan,
  createSeedDirName,
  normalizeProjectPath,
  parseArgs,
  resolveSeedBaseDir,
  resolveFixtureTypes,
  shouldWriteFixturesLocally,
} = require("./seed.js");

test("parseArgs ignores a leading pnpm separator", () => {
  const options = parseArgs(["--", "--chat", "--json"]);
  assert.deepEqual(options.fixtures, ["chat"]);
  assert.equal(options.json, true);
});

test("resolveFixtureTypes expands --all", () => {
  assert.deepEqual(
    resolveFixtureTypes({ all: true, fixtures: new Set(["chat"]) }),
    FIXTURE_TYPES,
  );
});

test("normalizeProjectPath keeps fixture roots project-relative", () => {
  assert.equal(
    normalizeProjectPath("./.bug-hunt/fixtures"),
    ".bug-hunt/fixtures",
  );
  assert.equal(
    normalizeProjectPath("bug-hunt\\fixtures\\seed"),
    "bug-hunt/fixtures/seed",
  );
});

test("resolveSeedBaseDir defaults lite seeds into scratch", () => {
  const resolved = resolveSeedBaseDir("lite", "", false);
  assert.match(resolved, /\/scratch\/cocalc-bug-hunt\/fixtures$/);
});

test("shouldWriteFixturesLocally only enables direct writes for absolute lite roots", () => {
  assert.equal(
    shouldWriteFixturesLocally({ mode: "lite" }, "/tmp/bug-hunt-fixtures"),
    true,
  );
  assert.equal(
    shouldWriteFixturesLocally({ mode: "hub" }, "/tmp/bug-hunt-fixtures"),
    false,
  );
  assert.equal(
    shouldWriteFixturesLocally({ mode: "lite" }, ".bug-hunt/fixtures"),
    false,
  );
});

test("createSeedDirName includes an optional label", () => {
  const value = createSeedDirName(Date.UTC(2026, 2, 13, 5, 6, 7), "Lite Smoke");
  assert.match(value, /^2026-03-13T05-06-07-000Z-lite-smoke$/);
});

test("buildFixturePlan creates valid notebook, tasks, and board seed content", () => {
  const fixtures = buildFixturePlan(
    "bug-hunt/fixtures/smoke",
    1_700_000_000_000,
    ["jupyter", "tasks", "whiteboard"],
  );
  const jupyter = fixtures.find((fixture) => fixture.type === "jupyter");
  const tasks = fixtures.find((fixture) => fixture.type === "tasks");
  const board = fixtures.find((fixture) => fixture.type === "whiteboard");

  assert.ok(jupyter);
  assert.ok(tasks);
  assert.ok(board);

  const notebook = JSON.parse(jupyter.upload[0].content);
  assert.equal(notebook.nbformat, 4);
  assert.equal(notebook.nbformat_minor, 5);
  assert.equal(notebook.metadata.kernelspec.name, "python3");

  const taskRows = tasks.upload[0].content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(taskRows.length, 2);
  assert.equal(taskRows[0].last_edited, 1_700_000_000_000);

  const boardRows = board.upload[0].content
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(boardRows[0].type, "page");
  assert.equal(boardRows[1].page, boardRows[0].id);
});

test("buildFixturePlan creates a reusable files directory fixture", () => {
  const fixtures = buildFixturePlan("bug-hunt/fixtures/smoke", 1, ["files"]);
  assert.deepEqual(fixtures[0].open_paths, [
    "bug-hunt/fixtures/smoke/files/README.md",
  ]);
  assert.equal(fixtures[0].directory_path, "bug-hunt/fixtures/smoke/files");
  assert.equal(fixtures[0].upload.length, 3);
});
