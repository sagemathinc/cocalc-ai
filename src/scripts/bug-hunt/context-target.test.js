const test = require("node:test");
const assert = require("node:assert/strict");

const {
  refreshLiveContextTargetFromSessions,
  selectLiveSessionForContext,
} = require("./context-target.js");

test("selectLiveSessionForContext prefers the exact browser id when still present", () => {
  const selected = selectLiveSessionForContext(
    {
      browser_mode: "live",
      browser_id: "browser-current",
      project_id: "project-a",
      session_name: "Current Session",
    },
    [
      {
        browser_id: "browser-other",
        active_project_id: "project-a",
        session_name: "Other Session",
      },
      {
        browser_id: "browser-current",
        active_project_id: "project-a",
        session_name: "Current Session",
      },
    ],
  );
  assert.equal(selected.browser_id, "browser-current");
});

test("refreshLiveContextTargetFromSessions updates stale live browser ids by project/session match", () => {
  const refreshed = refreshLiveContextTargetFromSessions(
    {
      browser_mode: "live",
      browser_id: "browser-stale",
      project_id: "project-a",
      session_name: "lite2 - CoCalc Launchpad",
      session_url: "http://localhost:7002/projects/project-a/project-home",
      exports: {
        COCALC_BROWSER_ID: "browser-stale",
        COCALC_PROJECT_ID: "project-a",
      },
    },
    [
      {
        browser_id: "browser-new",
        active_project_id: "project-a",
        session_name: "lite2 - CoCalc Launchpad",
        url: "http://localhost:7002/projects/project-a/files/home/wstein/test.tasks",
        updated_at: "2026-03-13T05:00:00.000Z",
      },
    ],
  );

  assert.equal(refreshed.browser_id, "browser-new");
  assert.equal(refreshed.project_id, "project-a");
  assert.equal(refreshed.session_name, "lite2 - CoCalc Launchpad");
  assert.equal(
    refreshed.session_url,
    "http://localhost:7002/projects/project-a/files/home/wstein/test.tasks",
  );
  assert.equal(refreshed.exports.COCALC_BROWSER_ID, "browser-new");
});

test("refreshLiveContextTargetFromSessions leaves non-live contexts untouched", () => {
  const original = {
    browser_mode: "spawned",
    browser_id: "spawned-browser",
    project_id: "project-a",
    exports: {
      COCALC_BROWSER_ID: "spawned-browser",
      COCALC_PROJECT_ID: "project-a",
    },
  };
  assert.deepEqual(
    refreshLiveContextTargetFromSessions(original, []),
    original,
  );
});
