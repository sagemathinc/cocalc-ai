const test = require("node:test");
const assert = require("node:assert/strict");

const { parseArgs } = require("./launchpad-move.js");

test("parseArgs forces the move scenario", () => {
  const options = parseArgs(["--provider", "gcp", "--dry-run", "--json"]);
  assert.deepEqual(options.providers, ["gcp"]);
  assert.deepEqual(options.scenarios, ["move"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.json, true);
});
