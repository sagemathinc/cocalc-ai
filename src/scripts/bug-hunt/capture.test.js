const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createArtifactDirName,
  parseArgs,
  sanitizeSegment,
} = require("./capture.js");

test("parseArgs ignores a leading pnpm separator", () => {
  const options = parseArgs(["--", "--name", "Smoke", "--json"]);
  assert.equal(options.name, "Smoke");
  assert.equal(options.json, true);
});

test("sanitizeSegment keeps artifact names filesystem-safe", () => {
  assert.equal(sanitizeSegment("Hub Smoke / #1"), "hub-smoke-1");
});

test("createArtifactDirName includes mode, browser mode, and optional label", () => {
  const value = createArtifactDirName(
    Date.UTC(2026, 2, 13, 4, 5, 6),
    { mode: "hub", browser_mode: "unattached" },
    "Hub Smoke",
  );
  assert.match(value, /^2026-03-13T04-05-06-000Z-hub-unattached-hub-smoke$/);
});
