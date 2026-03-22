import assert from "node:assert/strict";
import test from "node:test";

import { buildSpawnCookies } from "./spawn-state";

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
