import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";

import {
  effectiveDaemonGlobals,
  shouldUseFileOpsDaemon,
} from "./daemon-globals";

test("manual file-backed keys use the daemon; managed routing remains isolated", () => {
  assert.equal(
    shouldUseFileOpsDaemon(
      { apiKeyFile: "/tmp/scoped-key" },
      {} as NodeJS.ProcessEnv,
    ),
    true,
  );
  assert.equal(
    shouldUseFileOpsDaemon(
      {},
      {
        COCALC_CONNECTOR_API_KEY_FILE: "/tmp/rotating-key",
      },
    ),
    false,
  );
  assert.equal(shouldUseFileOpsDaemon({}, {} as NodeJS.ProcessEnv), true);
});

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

test("key-file daemon requests carry an absolute provider path without ambient credentials", () => {
  const globals = effectiveDaemonGlobals(
    { apiKeyFile: "private-key" },
    {
      env: {
        COCALC_API_URL: "https://example.test",
        COCALC_API_KEY: "ambient-key",
        COCALC_BEARER_TOKEN: "agent-token",
        COCALC_HUB_PASSWORD: "admin",
      },
    },
  );
  assert.equal(globals.apiKeyFile, resolve("private-key"));
  assert.equal(globals.api, "https://example.test");
  assert.equal(globals.disableEnvAuthDefaults, true);
  assert.equal(globals.apiKey, undefined);
  assert.equal(globals.bearer, undefined);
  assert.equal(globals.hubPassword, undefined);
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

test("effectiveDaemonGlobals does not leak ambient auth into named profiles", () => {
  const globals = effectiveDaemonGlobals(
    {
      profile: "local-cookie",
      disableEnvAuthDefaults: true,
    },
    {
      env: {
        COCALC_API_URL: "http://localhost:9100",
        COCALC_ACCOUNT_ID: "11111111-1111-4111-8111-111111111111",
        COCALC_BEARER_TOKEN: "unrelated-host-token",
        COCALC_API_KEY: "unrelated-api-key",
        COCALC_HUB_PASSWORD: "unrelated-hub-password",
      },
    },
  );
  assert.equal(globals.profile, "local-cookie");
  assert.equal(globals.api, "http://localhost:9100");
  assert.equal(globals.accountId, undefined);
  assert.equal(globals.bearer, undefined);
  assert.equal(globals.apiKey, undefined);
  assert.equal(globals.hubPassword, undefined);
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

test("effectiveDaemonGlobals reads the current rotating agent token", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-daemon-token-"));
  const tokenFile = join(dir, "token");
  try {
    writeFileSync(tokenFile, "rotated-token\n");
    const globals = effectiveDaemonGlobals(
      {},
      {
        env: {
          COCALC_BEARER_TOKEN_FILE: tokenFile,
          COCALC_BEARER_TOKEN: "stale-token",
        },
      },
    );
    assert.equal(globals.bearer, "rotated-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
