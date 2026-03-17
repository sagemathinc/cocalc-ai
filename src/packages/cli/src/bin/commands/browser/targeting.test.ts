import assert from "node:assert/strict";
import test from "node:test";

import { chooseBrowserSession } from "./targeting";
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
