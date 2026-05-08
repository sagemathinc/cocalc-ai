import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";

import { registerAuthCommand, type AuthCommandDeps } from "./auth";
import { cookieNameFor, normalizeSecretValue } from "../../core/auth-cookies";

function makeDeps(
  capture: { data?: any },
  overrides: Partial<AuthCommandDeps> = {},
): AuthCommandDeps {
  return {
    env: {},
    runLocalCommand: async (_command: unknown, _name: string, fn: any) => {
      capture.data = await fn({});
    },
    authConfigPath: () => "/tmp/cocalc-cli-config.json",
    loadAuthConfig: () => ({ profiles: {} }),
    selectedProfileName: () => "default",
    applyAuthProfile: (globals: any) => ({
      globals,
      profile: "default",
      fromProfile: false,
    }),
    normalizeUrl: (url: string) => url,
    defaultApiBaseUrl: () => "https://lite4.cocalc.ai",
    getExplicitAccountId: () => undefined,
    durationToMs: () => 15_000,
    connectRemote: async () => ({
      client: { close() {} },
      user: { project_id: "890afc74-9156-4386-a395-afd4bebab4dd" },
    }),
    resolveAccountIdFromRemote: () => undefined,
    buildCookieHeader: () => undefined,
    cookieNameFor,
    normalizeSecretValue,
    maskSecret: () => null,
    sanitizeProfileName: (name: string | undefined) => name ?? "default",
    profileFromGlobals: () => ({}),
    saveAuthConfig: () => undefined,
    ...overrides,
  };
}

test("auth status reports project-scoped auth clearly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-status-"));
  const tokenPath = join(dir, "secret-token");
  writeFileSync(tokenPath, "project-secret-token\n", "utf8");
  try {
    const capture: { data?: any } = {};
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        env: {
          COCALC_SECRET_TOKEN: tokenPath,
          COCALC_PROJECT_ID: "890afc74-9156-4386-a395-afd4bebab4dd",
        },
      }),
    );
    await program.parseAsync(["node", "test", "auth", "status"]);
    assert.equal(capture.data.has_project_secret, true);
    assert.equal(capture.data.has_project_id, true);
    assert.equal(capture.data.has_project_scoped_auth, true);
    assert.equal(capture.data.project_auth_source, "COCALC_SECRET_TOKEN");
    assert.equal(capture.data.effective_remote_auth, "project_scoped");
    assert.match(
      capture.data.project_auth_message,
      /remote commands can authenticate even without api_key\/cookie\/bearer/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth login stores a dedicated browser-approved CLI session", async () => {
  const capture: { data?: any } = {};
  let config: any = { profiles: {} };
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    fetchCalls.push({ url: `${url}`, init });
    if (`${url}`.endsWith("/api/v2/auth/cli/login/start")) {
      return {
        json: async () => ({
          challenge_id: "challenge-1",
          poll_token: "poll-token-1",
          approval_url: "https://hub.example.test/auth/cli-login/challenge-1",
          expires_at: "2026-05-08T10:00:00.000Z",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/login/status")) {
      return {
        json: async () => ({
          challenge_id: "challenge-1",
          kind: "login",
          state: "approved",
          expires_at: "2026-05-08T10:00:00.000Z",
          redeem_token: "redeem-token-1",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/login/redeem")) {
      return {
        json: async () => ({
          account_id: "acct-123",
          remember_me: "remember-cookie-1",
          expire: "2026-11-08T10:00:00.000Z",
          email_address: "user@example.com",
          first_name: "User",
          last_name: "Example",
        }),
      } as any;
    }
    throw new Error(`unexpected fetch url ${url}`);
  }) as any;
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        loadAuthConfig: () => config,
        saveAuthConfig: (next: any) => {
          config = next;
        },
      }),
    );
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--email",
      "user@example.com",
    ]);
    assert.equal(capture.data.profile, "default");
    assert.equal(capture.data.account_id, "acct-123");
    assert.equal(capture.data.email_address, "user@example.com");
    assert.equal(capture.data.first_name, "User");
    assert.equal(capture.data.last_name, "Example");
    assert.equal(capture.data.interactive_session, true);
    assert.equal(config.current_profile, "default");
    assert.equal(config.profiles.default.api, "https://lite4.cocalc.ai");
    assert.equal(config.profiles.default.account_id, "acct-123");
    assert.equal(config.profiles.default.email_address, "user@example.com");
    assert.equal(config.profiles.default.first_name, "User");
    assert.equal(config.profiles.default.last_name, "Example");
    assert.match(
      config.profiles.default.cookie,
      /remember_me=remember-cookie-1/,
    );
    assert.equal(fetchCalls.length, 3);
    assert.deepEqual(
      fetchCalls.map((call) => call.url.replace(/^https?:\/\/[^/]+/, "")),
      [
        "/api/v2/auth/cli/login/start",
        "/api/v2/auth/cli/login/status",
        "/api/v2/auth/cli/login/redeem",
      ],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth list includes stored account identity details", async () => {
  const capture: { data?: any } = {};
  const program = new Command();
  registerAuthCommand(
    program,
    makeDeps(capture, {
      loadAuthConfig: () => ({
        current_profile: "default",
        profiles: {
          default: {
            api: "https://lite4.cocalc.ai",
            account_id: "acct-123",
            email_address: "user@example.com",
            first_name: "User",
            last_name: "Example",
            cookie: "remember_me=remember-cookie-1",
          },
        },
      }),
    }),
  );
  await program.parseAsync(["node", "test", "auth", "list"]);
  assert.deepEqual(capture.data, [
    {
      profile: "default",
      current: true,
      api: "https://lite4.cocalc.ai",
      account_id: "acct-123",
      email_address: "user@example.com",
      first_name: "User",
      last_name: "Example",
      api_key: null,
      cookie: null,
      bearer: null,
      hub_password: null,
    },
  ]);
});

test("auth list backfills missing identity details for cookie-backed profiles", async () => {
  const capture: { data?: any } = {};
  let config: any = {
    current_profile: "default",
    profiles: {
      default: {
        api: "https://lite4.cocalc.ai",
        account_id: "acct-123",
        cookie: "remember_me=remember-cookie-1",
      },
    },
  };
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request) => {
    if (`${url}`.endsWith("/api/v2/accounts/profile")) {
      return {
        json: async () => ({
          profile: {
            account_id: "acct-123",
            email_address: "user@example.com",
            first_name: "User",
            last_name: "Example",
          },
        }),
      } as any;
    }
    throw new Error(`unexpected fetch url ${url}`);
  }) as any;
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        loadAuthConfig: () => config,
        saveAuthConfig: (next: any) => {
          config = next;
        },
      }),
    );
    await program.parseAsync(["node", "test", "auth", "list"]);
    assert.equal(config.profiles.default.email_address, "user@example.com");
    assert.equal(config.profiles.default.first_name, "User");
    assert.equal(config.profiles.default.last_name, "Example");
    assert.equal(capture.data[0].email_address, "user@example.com");
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth elevate approves the current CLI session via browser polling", async () => {
  const capture: { data?: any } = {};
  let config: any = {
    current_profile: "default",
    profiles: {
      default: {
        api: "https://hub.example.test",
        account_id: "acct-123",
        cookie: "remember_me=remember-cookie-1",
      },
    },
  };
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    fetchCalls.push({ url: `${url}`, init });
    if (`${url}`.endsWith("/api/v2/auth/cli/elevate/start")) {
      return {
        json: async () => ({
          challenge_id: "challenge-2",
          poll_token: "poll-token-2",
          approval_url: "https://hub.example.test/auth/cli-elevate/challenge-2",
          expires_at: "2026-05-08T10:00:00.000Z",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/elevate/status")) {
      return {
        json: async () => ({
          challenge_id: "challenge-2",
          kind: "elevate",
          state: "approved",
          expires_at: "2026-05-08T10:00:00.000Z",
          factor_level: "totp",
          fresh_auth_until: "2026-05-08T18:00:00.000Z",
        }),
      } as any;
    }
    throw new Error(`unexpected fetch url ${url}`);
  }) as any;
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        loadAuthConfig: () => config,
        saveAuthConfig: (next: any) => {
          config = next;
        },
        applyAuthProfile: (globals: any) => ({
          globals: {
            ...config.profiles.default,
            ...globals,
          },
          profile: "default",
          fromProfile: true,
        }),
        buildCookieHeader: (_apiBaseUrl: string, effective: any) =>
          effective.cookie,
      }),
    );
    await program.parseAsync(["node", "test", "auth", "elevate", "--extended"]);
    assert.equal(capture.data.interactive_session, true);
    assert.equal(capture.data.factor_level, "totp");
    assert.equal(capture.data.fresh_auth_until, "2026-05-08T18:00:00.000Z");
    assert.deepEqual(
      fetchCalls.map((call) => call.url.replace(/^https?:\/\/[^/]+/, "")),
      ["/api/v2/auth/cli/elevate/start", "/api/v2/auth/cli/elevate/status"],
    );
    assert.equal(JSON.parse(fetchCalls[0].init.body).duration, "extended");
    assert.equal(
      fetchCalls[0].init.headers.Cookie,
      "remember_me=remember-cookie-1",
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth rename renames the selected profile and preserves current selection", async () => {
  const capture: { data?: any } = {};
  let config: any = {
    current_profile: "default",
    profiles: {
      default: {
        api: "https://lite4.cocalc.ai",
        account_id: "acct-123",
        email_address: "user@example.com",
      },
    },
  };
  const program = new Command();
  registerAuthCommand(
    program,
    makeDeps(capture, {
      loadAuthConfig: () => config,
      saveAuthConfig: (next: any) => {
        config = next;
      },
    }),
  );
  await program.parseAsync([
    "node",
    "test",
    "auth",
    "rename",
    "default",
    "wstein",
  ]);
  assert.deepEqual(capture.data, {
    renamed: "default",
    to: "wstein",
    current_profile: "wstein",
  });
  assert.equal(config.current_profile, "wstein");
  assert.equal(config.profiles.default, undefined);
  assert.equal(config.profiles.wstein.account_id, "acct-123");
});

test("auth rename rejects conflicting target profiles", async () => {
  const capture: { data?: any } = {};
  const config: any = {
    current_profile: "default",
    profiles: {
      default: { account_id: "acct-123" },
      wstein: { account_id: "acct-456" },
    },
  };
  const program = new Command();
  registerAuthCommand(
    program,
    makeDeps(capture, {
      loadAuthConfig: () => config,
    }),
  );
  await assert.rejects(
    program.parseAsync(["node", "test", "auth", "rename", "default", "wstein"]),
    /auth profile 'wstein' already exists/,
  );
});
