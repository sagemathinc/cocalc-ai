import test from "node:test";
import assert from "node:assert/strict";

import { effectiveDaemonGlobals } from "./daemon-globals";

test("effectiveDaemonGlobals propagates env-backed api and auth into daemon requests", () => {
  const globals = effectiveDaemonGlobals(
    { noDaemon: true },
    {
      env: {
        COCALC_API_URL: "http://localhost:7103",
        COCALC_ACCOUNT_ID: "11111111-1111-4111-8111-111111111111",
        COCALC_BEARER_TOKEN: "bearer-token",
      },
      defaultApiBaseUrl: () => {
        throw new Error("should not need default api");
      },
    },
  );
  assert.equal(globals.api, "http://localhost:7103");
  assert.equal(globals.accountId, "11111111-1111-4111-8111-111111111111");
  assert.equal(globals.bearer, "bearer-token");
});

test("effectiveDaemonGlobals preserves explicit globals over env fallbacks", () => {
  const globals = effectiveDaemonGlobals(
    {
      api: "https://explicit.example",
      accountId: "22222222-2222-4222-8222-222222222222",
      bearer: "explicit-bearer",
      apiKey: "explicit-key",
      hubPassword: "explicit-password",
    },
    {
      env: {
        COCALC_API_URL: "http://localhost:7103",
        COCALC_ACCOUNT_ID: "11111111-1111-4111-8111-111111111111",
        COCALC_BEARER_TOKEN: "bearer-token",
        COCALC_API_KEY: "api-key",
        COCALC_HUB_PASSWORD: "hub-password",
      },
    },
  );
  assert.equal(globals.api, "https://explicit.example");
  assert.equal(globals.accountId, "22222222-2222-4222-8222-222222222222");
  assert.equal(globals.bearer, "explicit-bearer");
  assert.equal(globals.apiKey, "explicit-key");
  assert.equal(globals.hubPassword, "explicit-password");
});

test("effectiveDaemonGlobals falls back to defaultApiBaseUrl and agent token", () => {
  const globals = effectiveDaemonGlobals(
    { noDaemon: true },
    {
      env: {
        COCALC_AGENT_TOKEN: "agent-token",
      },
      defaultApiBaseUrl: () => "http://127.0.0.1:7001",
    },
  );
  assert.equal(globals.api, "http://127.0.0.1:7001");
  assert.equal(globals.bearer, "agent-token");
});
