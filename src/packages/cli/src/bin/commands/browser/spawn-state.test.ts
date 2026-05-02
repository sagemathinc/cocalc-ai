import assert from "node:assert/strict";
import test from "node:test";

import {
  buildControlPlaneOriginStorageKey,
  buildRememberMeStorageKeys,
  buildSpawnCookies,
  spawnStateHasActiveRemoteSession,
  waitForSpawnedSession,
} from "./spawn-state";

test("buildSpawnCookies prefers remember_me over hub/api cookies", () => {
  const cookies = buildSpawnCookies({
    apiUrl: "http://localhost:9001",
    hubPassword: "hub-secret",
    apiKey: "api-secret",
    rememberMe: "remember-secret",
    accountId: "00000000-1000-4000-8000-000000000001",
  });
  const names = cookies.map(({ name }) => name);
  assert.ok(names.includes("remember_me"));
  assert.ok(names.includes("account_id"));
  assert.ok(!names.includes("hub_password"));
  assert.ok(!names.includes("api_key"));
});

test("buildSpawnCookies falls back to hub/api cookies without remember_me", () => {
  const cookies = buildSpawnCookies({
    apiUrl: "http://localhost:9001",
    hubPassword: "hub-secret",
    apiKey: "api-secret",
  });
  const names = cookies.map(({ name }) => name);
  assert.ok(names.includes("hub_password"));
  assert.ok(names.includes("api_key"));
});

test("buildRememberMeStorageKeys matches frontend remember_me localStorage keys", () => {
  assert.deepEqual(buildRememberMeStorageKeys("http://localhost:9001"), [
    "remember_me",
  ]);
  assert.deepEqual(buildRememberMeStorageKeys("https://example.test/cocalc/"), [
    "remember_me",
    "remember_mecocalc",
  ]);
});

test("buildControlPlaneOriginStorageKey matches frontend control-plane key", () => {
  assert.equal(
    buildControlPlaneOriginStorageKey("http://localhost:9001"),
    "cocalc-control-plane-origin:/",
  );
  assert.equal(
    buildControlPlaneOriginStorageKey("https://example.test/cocalc/"),
    "cocalc-control-plane-origin:/cocalc",
  );
});

test("waitForSpawnedSession ignores transient registrations and returns a stable session", async () => {
  const marker = "pw-test-abc123";
  const sessionA = {
    browser_id: "browser-a",
    stale: false,
    url: `http://localhost:9100/projects/test/files?_cocalc_browser_spawn=${marker}`,
  };
  const sessionAStale = {
    ...sessionA,
    stale: true,
  };
  const sessionB = {
    browser_id: "browser-b",
    stale: false,
    url: `http://localhost:9100/projects/test/files?_cocalc_browser_spawn=${marker}`,
  };
  const sequences = [[sessionA], [sessionAStale], [sessionB], [sessionB]];
  let calls = 0;
  const result = await waitForSpawnedSession({
    ctx: {
      hub: {
        system: {
          listBrowserSessions: async () =>
            (sequences[calls++] ?? [sessionB]) as any,
        },
      },
    } as any,
    marker,
    timeoutMs: 5_000,
    pollMs: 0,
    sleepFn: async () => {},
  });
  assert.equal(result.browser_id, "browser-b");
  assert.equal(calls, 4);
});

test("spawnStateHasActiveRemoteSession matches active session by browser id", () => {
  const state = {
    browser_id: "browser-1",
    target_url:
      "http://localhost:9100/projects/test/files?_cocalc_browser_spawn=pw-test-1",
  };
  const sessions = [
    {
      browser_id: "browser-1",
      stale: false,
      url: "http://localhost:9100/projects/test/files?_cocalc_browser_spawn=pw-test-1",
    },
  ];
  assert.equal(
    spawnStateHasActiveRemoteSession({
      state: state as any,
      sessions: sessions as any,
    }),
    true,
  );
});

test("spawnStateHasActiveRemoteSession treats stale matching rows as inactive", () => {
  const state = {
    browser_id: "browser-1",
    target_url:
      "http://localhost:9100/projects/test/files?_cocalc_browser_spawn=pw-test-1",
  };
  const sessions = [
    {
      browser_id: "browser-1",
      stale: true,
      url: "http://localhost:9100/projects/test/files?_cocalc_browser_spawn=pw-test-1",
    },
  ];
  assert.equal(
    spawnStateHasActiveRemoteSession({
      state: state as any,
      sessions: sessions as any,
    }),
    false,
  );
});
