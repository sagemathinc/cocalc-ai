const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveApiUrl } = require("./launchpad-cli-helpers.js");

test("launchpad cli helpers resolve an explicit api url without canary imports", () => {
  const original = process.env.COCALC_API_URL;
  process.env.COCALC_API_URL = "http://stale.example";
  try {
    assert.equal(
      resolveApiUrl({ apiUrl: "http://127.0.0.1:9102" }),
      "http://127.0.0.1:9102",
    );
  } finally {
    if (original === undefined) {
      delete process.env.COCALC_API_URL;
    } else {
      process.env.COCALC_API_URL = original;
    }
  }
});
