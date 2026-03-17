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
});
