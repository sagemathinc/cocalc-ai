import assert from "node:assert/strict";
import test from "node:test";

import { buildRememberMeStorageKeys, buildSpawnCookies } from "./spawn-state";

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
