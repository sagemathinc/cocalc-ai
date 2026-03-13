const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildContext,
  mergeCleanupResults,
  parseArgs,
  selectLiveSession,
  unwrapCliJsonPayload,
} = require("./attach.js");

test("parseArgs applies attach defaults", () => {
  const options = parseArgs(["--mode", "lite"]);
  assert.equal(options.mode, "lite");
  assert.equal(options.browser, "auto");
  assert.equal(options.use, true);
  assert.equal(options.headed, false);
});

test("selectLiveSession prefers the saved browser id before project fallback", () => {
  const selected = selectLiveSession(
    [
      { browser_id: "other", active_project_id: "project-a" },
      { browser_id: "preferred", active_project_id: "project-b" },
    ],
    "preferred",
    "project-a",
  );
  assert.equal(selected.browser_id, "preferred");
});

test("selectLiveSession ignores locally spawned browser ids when excluded", () => {
  const selected = selectLiveSession(
    [
      { browser_id: "spawned-local", active_project_id: "project-a" },
      { browser_id: "real-live", active_project_id: "project-a" },
    ],
    "",
    "project-a",
    ["spawned-local"],
  );
  assert.equal(selected.browser_id, "real-live");
});

test("buildContext rewrites exported browser and project ids to the attached target", () => {
  const payload = buildContext(
    {
      api_url: "http://localhost:7002",
      cli_bin: "/tmp/cocalc.js",
      project_id: "project-default",
      exports: {
        COCALC_API_URL: "http://localhost:7002",
        COCALC_PROJECT_ID: "project-default",
        COCALC_BROWSER_ID: "old-browser",
      },
    },
    {
      mode: "lite",
      projectId: "",
      targetUrl: "",
    },
    {
      reap: { rows: [] },
      destroyed: [],
      remaining: [],
    },
    {
      browser_mode: "live",
      browser_id: "browser-new",
      active_project_id: "project-live",
      session_url: "http://localhost:7002/projects/project-live",
      session_name: "Live session",
    },
  );

  assert.equal(payload.browser_id, "browser-new");
  assert.equal(payload.project_id, "project-live");
  assert.equal(payload.exports.COCALC_BROWSER_ID, "browser-new");
  assert.equal(payload.exports.COCALC_PROJECT_ID, "project-live");
});

test("unwrapCliJsonPayload returns command data from the CLI envelope", () => {
  assert.deepEqual(
    unwrapCliJsonPayload({
      ok: true,
      command: "browser session spawned",
      data: [{ browser_id: "abc" }],
      meta: { api: "http://localhost:7002" },
    }),
    [{ browser_id: "abc" }],
  );
});

test("mergeCleanupResults keeps the latest remaining-state and combines destroyed rows", () => {
  const merged = mergeCleanupResults(
    {
      reap: { scanned: 1 },
      destroyed: [{ spawn_id: "old" }],
      remaining: [{ spawn_id: "old" }],
    },
    {
      reap: { scanned: 2 },
      destroyed: [{ spawn_id: "new" }],
      remaining: [],
    },
  );

  assert.deepEqual(merged, {
    reap: { scanned: 2 },
    destroyed: [{ spawn_id: "old" }, { spawn_id: "new" }],
    remaining: [],
  });
});
