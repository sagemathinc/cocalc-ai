import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolve } from "node:path";
import { buildCookieHeader } from "../../core/auth-cookies";

import {
  effectiveDaemonGlobals,
  prepareDaemonAuthGlobals,
  shouldUseFileOpsDaemon,
} from "./daemon-globals";
import { selectProjectApiRelayTransport } from "../../core/api-relay";

test("freezing ambient daemon auth preserves its site rather than trusting an API override", async () => {
  const env = {
    COCALC_API_URL: "https://local.test",
    COCALC_API_RELAY_HUB_URL: "https://local.test",
    COCALC_CLI_TRANSPORT: "direct",
    COCALC_BEARER_TOKEN: "ambient-token",
  };
  const globals = effectiveDaemonGlobals(
    { api: "https://other.test" },
    { env },
  );
  assert.equal(globals.disableEnvAuthDefaults, true);
  assert.equal(globals.directAuthSite, "https://local.test");
  await assert.rejects(
    selectProjectApiRelayTransport({
      apiBaseUrl: globals.api!,
      credentialSite: globals.directAuthSite,
      env,
    }),
    /destination-scoped/,
  );
});
import { applyAuthProfile } from "../../core/auth-config";

test("manual and managed file-backed keys use the daemon", () => {
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
    true,
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

test("managed daemon requests carry source and provider, not ambient account authority", () => {
  const source = "00000000-0000-4000-8000-000000000001";
  const globals = effectiveDaemonGlobals(
    {},
    {
      env: {
        COCALC_CONNECTOR_API_KEY_FILE: "turn-key",
        COCALC_PROJECT_ID: source,
        COCALC_API_URL: "https://example.test",
        COCALC_ACCOUNT_ID: "00000000-0000-4000-8000-000000000002",
        COCALC_BEARER_TOKEN: "source-agent-token",
        COCALC_API_KEY: "unrelated-account-key",
        COCALC_HUB_PASSWORD: "unrelated-admin-password",
      },
    },
  );
  assert.deepEqual(globals.managedConnector, {
    keyFile: resolve("turn-key"),
    sourceProjectId: source,
  });
  assert.equal(globals.bearer, "source-agent-token");
  assert.equal(globals.authProjectId, source);
  assert.equal(globals.apiKey, undefined);
  assert.equal(globals.hubPassword, undefined);
  assert.equal(globals.profile, "_env");
  assert.equal(globals.disableEnvAuthDefaults, true);
  const explicit = effectiveDaemonGlobals(
    { profile: "manual", disableEnvAuthDefaults: true },
    {
      env: {
        COCALC_CONNECTOR_API_KEY_FILE: "turn-key",
        COCALC_PROJECT_ID: source,
      },
    },
  );
  assert.equal(explicit.managedConnector, undefined);
});

test("ordinary project daemon requests freeze their own project credential", () => {
  const source = "00000000-0000-4000-8000-000000000001";
  const globals = effectiveDaemonGlobals(
    {},
    {
      env: {
        COCALC_API_URL: "https://example.test",
        COCALC_PROJECT_ID: source,
        COCALC_PROJECT_SECRET: "request-project-secret",
      },
    },
  );
  assert.equal(globals.disableEnvAuthDefaults, true);
  assert.match(globals.cookie!, /request-project-secret/);
  assert.match(globals.cookie!, new RegExp(source));
  const header = buildCookieHeader(
    "https://example.test",
    globals,
    {},
    {
      COCALC_API_KEY: "daemon-account-key",
      COCALC_HUB_PASSWORD: "daemon-admin",
      COCALC_PROJECT_SECRET: "daemon-project-secret",
    },
  );
  assert.match(header ?? "", /request-project-secret/);
  assert.doesNotMatch(header ?? "", /daemon-/);
});

test("daemon admission never fills missing request credentials from its profile or environment", () => {
  const request = prepareDaemonAuthGlobals({ profile: "stored-human" });
  const applied = applyAuthProfile(request, {
    profiles: { "stored-human": { cookie: "human-cookie" } },
  });
  assert.equal(applied.globals.cookie, undefined);
  assert.equal(
    buildCookieHeader(
      "https://example.test",
      applied.globals,
      {},
      { COCALC_API_KEY: "old-key", COCALC_HUB_PASSWORD: "old-admin" },
    ),
    undefined,
  );
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
