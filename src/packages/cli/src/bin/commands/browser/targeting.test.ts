import assert from "node:assert/strict";
import test from "node:test";

import { chooseBrowserSession, resolveTargetProjectId } from "./targeting";
import type { BrowserCommandContext } from "./types";

function makeContext(
  listBrowserSessions: BrowserCommandContext["hub"]["system"]["listBrowserSessions"],
): BrowserCommandContext {
  return {
    globals: {},
    accountId: "00000000-1000-4000-8000-000000000001",
    timeoutMs: 30_000,
    apiBaseUrl: "http://localhost:7003",
    remote: { client: {} },
    hub: {
      system: {
        listBrowserSessions,
        removeBrowserSession: async () => ({ removed: false }),
        issueBrowserSignInCookie: async () => ({}),
        generateUserAuthToken: async () => "token",
      },
    },
  };
}

test("chooseBrowserSession falls back to exact browser id when discovery fails", async () => {
  const ctx = makeContext(async () => {
    throw new Error(
      "command_failed: code 408 while publishing to system.listBrowserSessions",
    );
  });

  const session = await chooseBrowserSession({
    ctx,
    browserHint: "wZbV6ZDCkk",
    sessionProjectId: "00000000-1000-4000-8000-000000000000",
  });

  assert.equal(session.browser_id, "wZbV6ZDCkk");
  assert.equal(session.stale, false);
});

test("chooseBrowserSession falls back to saved browser id when discovery fails", async () => {
  const ctx = makeContext(async () => {
    throw new Error(
      "command_failed: code 408 while publishing to system.listBrowserSessions",
    );
  });

  const session = await chooseBrowserSession({
    ctx,
    fallbackBrowserId: "wZbV6ZDCkk",
    sessionProjectId: "00000000-1000-4000-8000-000000000000",
  });

  assert.equal(session.browser_id, "wZbV6ZDCkk");
  assert.equal(session.stale, false);
});

test("chooseBrowserSession still throws discovery errors when there is no direct browser id", async () => {
  const prev = process.env.COCALC_CLI_AGENT_MODE;
  delete process.env.COCALC_CLI_AGENT_MODE;
  try {
    const ctx = makeContext(async () => {
      throw new Error(
        "command_failed: code 408 while publishing to system.listBrowserSessions",
      );
    });

    await assert.rejects(
      () =>
        chooseBrowserSession({
          ctx,
          sessionProjectId: "00000000-1000-4000-8000-000000000000",
        }),
      /system\.listBrowserSessions/,
    );
  } finally {
    if (prev == null) {
      delete process.env.COCALC_CLI_AGENT_MODE;
    } else {
      process.env.COCALC_CLI_AGENT_MODE = prev;
    }
  }
});

test("chooseBrowserSession uses direct exact browser id in agent mode even when discovery would otherwise be required", async () => {
  const prev = process.env.COCALC_CLI_AGENT_MODE;
  process.env.COCALC_CLI_AGENT_MODE = "1";
  try {
    const ctx = makeContext(async () => {
      throw new Error("listBrowserSessions should not be called");
    });

    const session = await chooseBrowserSession({
      ctx,
      browserHint: "wZbV6ZDCkk",
      requireDiscovery: true,
    });

    assert.equal(session.browser_id, "wZbV6ZDCkk");
    assert.equal(session.stale, false);
  } finally {
    if (prev == null) {
      delete process.env.COCALC_CLI_AGENT_MODE;
    } else {
      process.env.COCALC_CLI_AGENT_MODE = prev;
    }
  }
});

test("chooseBrowserSession uses direct exact browser id in agent mode even with project and active filters", async () => {
  const prev = process.env.COCALC_CLI_AGENT_MODE;
  process.env.COCALC_CLI_AGENT_MODE = "1";
  try {
    const ctx = makeContext(async () => {
      throw new Error("listBrowserSessions should not be called");
    });

    const session = await chooseBrowserSession({
      ctx,
      browserHint: "wZbV6ZDCkk",
      requireDiscovery: true,
      sessionProjectId: "00000000-1000-4000-8000-000000000000",
      activeOnly: true,
    });

    assert.equal(session.browser_id, "wZbV6ZDCkk");
    assert.equal(session.stale, false);
  } finally {
    if (prev == null) {
      delete process.env.COCALC_CLI_AGENT_MODE;
    } else {
      process.env.COCALC_CLI_AGENT_MODE = prev;
    }
  }
});

test("chooseBrowserSession fails fast in agent mode when no direct browser id is available", async () => {
  const prev = process.env.COCALC_CLI_AGENT_MODE;
  process.env.COCALC_CLI_AGENT_MODE = "1";
  try {
    const ctx = makeContext(async () => {
      throw new Error("listBrowserSessions should not be called");
    });

    await assert.rejects(
      () =>
        chooseBrowserSession({
          ctx,
          requireDiscovery: true,
        }),
      /discovery is unavailable under agent auth/,
    );
  } finally {
    if (prev == null) {
      delete process.env.COCALC_CLI_AGENT_MODE;
    } else {
      process.env.COCALC_CLI_AGENT_MODE = prev;
    }
  }
});

test("chooseBrowserSession lets an explicit browser id win even if sessionProjectId does not match", async () => {
  const ctx = makeContext(async () => [
    {
      browser_id: "browser-1",
      active_project_id: "00000000-1000-4000-8000-000000000111",
      open_projects: [],
      stale: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      url: "http://localhost:13004/projects/00000000-1000-4000-8000-000000000111/files",
    },
  ]);

  const session = await chooseBrowserSession({
    ctx,
    browserHint: "browser-1",
    sessionProjectId: "00000000-1000-4000-8000-000000000999",
  });

  assert.equal(session.browser_id, "browser-1");
});

test("resolveTargetProjectId prefers the active browser-session project over ambient env", async () => {
  const prevProjectId = process.env.COCALC_PROJECT_ID;
  process.env.COCALC_PROJECT_ID = "00000000-1000-4000-8000-000000000099";
  try {
    const ctx = makeContext(async () => []);
    const calls: string[] = [];
    const project_id = await resolveTargetProjectId({
      deps: {
        resolveProject: async (_ctx, project) => {
          calls.push(project);
          return { project_id: project };
        },
      },
      ctx,
      sessionInfo: {
        browser_id: "browser-1",
        active_project_id: "00000000-1000-4000-8000-000000000111",
        open_projects: [],
        stale: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    });

    assert.equal(project_id, "00000000-1000-4000-8000-000000000111");
    assert.deepEqual(calls, ["00000000-1000-4000-8000-000000000111"]);
  } finally {
    if (prevProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = prevProjectId;
    }
  }
});

test("resolveTargetProjectId still lets explicit project-id override the browser-session project", async () => {
  const ctx = makeContext(async () => []);
  const calls: string[] = [];
  const project_id = await resolveTargetProjectId({
    deps: {
      resolveProject: async (_ctx, project) => {
        calls.push(project);
        return { project_id: project };
      },
    },
    ctx,
    projectId: "00000000-1000-4000-8000-000000000222",
    sessionInfo: {
      browser_id: "browser-1",
      active_project_id: "00000000-1000-4000-8000-000000000111",
      open_projects: [],
      stale: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  });

  assert.equal(project_id, "00000000-1000-4000-8000-000000000222");
  assert.deepEqual(calls, []);
});

test("resolveTargetProjectId falls back to the project encoded in the session URL before ambient env", async () => {
  const prevProjectId = process.env.COCALC_PROJECT_ID;
  process.env.COCALC_PROJECT_ID = "00000000-1000-4000-8000-000000000099";
  try {
    const ctx = makeContext(async () => []);
    const calls: string[] = [];
    const project_id = await resolveTargetProjectId({
      deps: {
        resolveProject: async (_ctx, project) => {
          calls.push(project);
          return { project_id: project };
        },
      },
      ctx,
      sessionInfo: {
        browser_id: "browser-1",
        active_project_id: "",
        open_projects: [],
        stale: false,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        url: "http://localhost:13004/projects/00000000-1000-4000-8000-000000000333/files?_cocalc_browser_spawn=test",
      },
    });

    assert.equal(project_id, "00000000-1000-4000-8000-000000000333");
    assert.deepEqual(calls, ["00000000-1000-4000-8000-000000000333"]);
  } finally {
    if (prevProjectId == null) {
      delete process.env.COCALC_PROJECT_ID;
    } else {
      process.env.COCALC_PROJECT_ID = prevProjectId;
    }
  }
});
