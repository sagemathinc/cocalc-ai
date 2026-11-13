import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, beforeEach, afterEach } from "node:test";
import { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import { readExternalAgentCredential } from "../core/external-agent-profile";

import {
  profileScopedFetch,
  registerAuthCommand,
  type AuthCommandDeps,
} from "./auth";
import { sanitizeProfileName } from "../../core/auth-config";
import { cookieNameFor, normalizeSecretValue } from "../../core/auth-cookies";
import { authGrantsPath, recordSessionGrant } from "../../core/auth-grants";

// login/elevate record grant timestamps next to the config path: keep the
// default path in a private temp dir, never a shared /tmp file.
const defaultConfigDir = mkdtempSync(join(tmpdir(), "cocalc-auth-test-"));
after(() => rmSync(defaultConfigDir, { recursive: true, force: true }));

let savedTransport: string | undefined;
let savedRelay: string | undefined;
beforeEach(() => {
  // These tests mock upstream auth endpoints, not the project relay.
  savedTransport = process.env.COCALC_CLI_TRANSPORT;
  savedRelay = process.env.COCALC_API_RELAY;
  process.env.COCALC_CLI_TRANSPORT = "auto";
  delete process.env.COCALC_API_RELAY;
});
afterEach(() => {
  if (savedTransport === undefined) delete process.env.COCALC_CLI_TRANSPORT;
  else process.env.COCALC_CLI_TRANSPORT = savedTransport;
  if (savedRelay === undefined) delete process.env.COCALC_API_RELAY;
  else process.env.COCALC_API_RELAY = savedRelay;
});

function makeDeps(
  capture: { data?: any },
  overrides: Partial<AuthCommandDeps> = {},
): AuthCommandDeps {
  return {
    env: {},
    runLocalCommand: async (_command: unknown, _name: string, fn: any) => {
      capture.data = await fn({});
    },
    authConfigPath: () => join(defaultConfigDir, "config.json"),
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
    maybeCreateLocalDevRememberMeCookie: async () => undefined,
    ...overrides,
  };
}

test("auth ssh-network changes only the selected profile preference", async () => {
  const capture: { data?: any } = {};
  const config = {
    profiles: {
      prod: { cookie: "fake", host_ssh_network: "auto" },
      other: { cookie: "other" },
    },
  };
  let saved: any;
  const program = new Command();
  registerAuthCommand(
    program,
    makeDeps(capture, {
      selectedProfileName: () => "prod",
      loadAuthConfig: () => config,
      saveAuthConfig: (value: any) => {
        saved = value;
      },
    }),
  );
  await program.parseAsync(["node", "test", "auth", "ssh-network", "private"]);
  assert.deepEqual(capture.data, {
    profile: "prod",
    host_ssh_network: "private",
  });
  assert.equal(saved.profiles.prod.cookie, "fake");
  assert.deepEqual(saved.profiles.other, { cookie: "other" });
  await assert.rejects(
    program.parseAsync(["node", "test", "auth", "ssh-network", "invalid"]),
    /network must be/,
  );
});

function logoutFixture(
  revoke: (api: string, cookie: string) => Promise<boolean>,
) {
  const capture: { data?: any } = {};
  const calls: Array<{ api: string; cookie: string }> = [];
  const config = {
    current_profile: "prod",
    profiles: {
      prod: { api: "https://cocalc.ai", cookie: "remember_me=prod-secret" },
      staging: { cookie: "remember_me=staging-secret" },
      keyonly: { api: "https://cocalc.ai", api_key: "sk-test" },
    },
  };
  let saved: any;
  const program = new Command();
  registerAuthCommand(
    program,
    makeDeps(capture, {
      loadAuthConfig: () => config,
      saveAuthConfig: (value: any) => {
        saved = value;
      },
      revokeSession: async (api: string, cookie: string) => {
        calls.push({ api, cookie });
        return await revoke(api, cookie);
      },
    }),
  );
  return { program, capture, calls, config, saved: () => saved };
}

test("auth logout signs out the profile's own server session, then removes it", async () => {
  const f = logoutFixture(async () => true);
  await f.program.parseAsync(["node", "test", "auth", "logout"]);
  assert.deepEqual(f.calls, [
    { api: "https://cocalc.ai", cookie: "remember_me=prod-secret" },
  ]);
  assert.equal(f.capture.data.removed, "prod");
  assert.equal(f.capture.data.server_session, "revoked");
  assert.equal(f.capture.data.warning, undefined);
  assert.equal(f.saved().profiles.prod, undefined);
  assert.ok(f.saved().profiles.staging);
});

test("auth logout without a server confirmation still removes the profile and warns", async () => {
  const f = logoutFixture(async () => false);
  await f.program.parseAsync(["node", "test", "auth", "logout"]);
  assert.deepEqual(f.calls, [
    { api: "https://cocalc.ai", cookie: "remember_me=prod-secret" },
  ]);
  assert.equal(f.capture.data.server_session, "not confirmed");
  assert.match(f.capture.data.warning, /may still be valid/);
  assert.equal(f.saved().profiles.prod, undefined);
});

test("auth logout never sends a cookie to an inferred API", async () => {
  const f = logoutFixture(async () => true);
  await f.program.parseAsync([
    "node",
    "test",
    "auth",
    "logout",
    "--target-profile",
    "staging",
  ]);
  // The staging profile has a cookie but no stored api: no request at all.
  assert.deepEqual(f.calls, []);
  assert.equal(f.capture.data.server_session, "not confirmed");
  assert.match(f.capture.data.warning, /may still be valid/);
  assert.equal(f.saved().profiles.staging, undefined);
});

test("auth logout --local-only leaves the server session alone", async () => {
  const f = logoutFixture(async () => true);
  await f.program.parseAsync([
    "node",
    "test",
    "auth",
    "logout",
    "--local-only",
  ]);
  assert.deepEqual(f.calls, []);
  assert.equal(f.capture.data.server_session, "skipped");
  assert.equal(f.saved().profiles.prod, undefined);
});

test("auth logout --all signs out every browser-cookie profile", async () => {
  const f = logoutFixture(async () => true);
  await f.program.parseAsync(["node", "test", "auth", "logout", "--all"]);
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.capture.data.server_sessions, {
    prod: "revoked",
    staging: "not confirmed",
    keyonly: "no browser session",
  });
  assert.deepEqual(f.saved().profiles, {});
});

test("auth logout --all still removes every profile when a sign-out throws", async () => {
  const f = logoutFixture(async (_api, cookie) => {
    if (cookie.includes("prod")) throw new Error("unexpected failure");
    return true;
  });
  await f.program.parseAsync(["node", "test", "auth", "logout", "--all"]);
  assert.deepEqual(f.capture.data.server_sessions, {
    prod: "not confirmed",
    staging: "not confirmed",
    keyonly: "no browser session",
  });
  assert.match(f.capture.data.warning, /may still be valid/);
  assert.deepEqual(f.saved().profiles, {});
});

test("auth logout --all keeps a profile added while it waited on the server", async () => {
  let config: any;
  const f = logoutFixture(async (_api, cookie) => {
    // Another CLI process signs in to a new profile meanwhile.
    if (cookie.includes("prod")) {
      config.profiles.fresh = { cookie: "remember_me=fresh-secret" };
    }
    return true;
  });
  config = f.config;
  await f.program.parseAsync(["node", "test", "auth", "logout", "--all"]);
  assert.deepEqual(Object.keys(f.saved().profiles), ["fresh"]);
  assert.equal(f.capture.data.remaining_profiles, 1);
  assert.equal(f.capture.data.server_sessions.fresh, undefined);
});

test("auth logout keeps a profile that was signed in again while it waited", async () => {
  let config: any;
  const f = logoutFixture(async () => {
    config.profiles.prod = {
      api: "https://cocalc.ai",
      cookie: "remember_me=new-secret",
    };
    return true;
  });
  config = f.config;
  await f.program.parseAsync(["node", "test", "auth", "logout"]);
  assert.equal(f.capture.data.removed, null);
  assert.deepEqual(f.capture.data.kept_changed_profiles, ["prod"]);
  assert.equal(f.saved().profiles.prod.cookie, "remember_me=new-secret");
});

test("auth logout still removes a profile whose metadata changed while it waited", async () => {
  let config: any;
  const f = logoutFixture(async () => {
    // Another CLI process edits only metadata, e.g. `auth ssh-network`.
    config.profiles.prod = {
      ...config.profiles.prod,
      host_ssh_network: "public",
    };
    return true;
  });
  config = f.config;
  await f.program.parseAsync(["node", "test", "auth", "logout"]);
  assert.equal(f.capture.data.removed, "prod");
  assert.equal(f.capture.data.kept_changed_profiles, undefined);
  assert.equal(f.saved().profiles.prod, undefined);
});

test("auth logout removes a profile renamed while it waited on the server", async () => {
  let config: any;
  const f = logoutFixture(async () => {
    // Another CLI process runs `auth rename prod work` meanwhile.
    config.profiles.work = config.profiles.prod;
    delete config.profiles.prod;
    config.current_profile = "work";
    return true;
  });
  config = f.config;
  await f.program.parseAsync(["node", "test", "auth", "logout"]);
  assert.equal(f.capture.data.removed, "work");
  assert.equal(f.saved().profiles.work, undefined);
  assert.equal(f.saved().profiles.prod, undefined);
  assert.ok(f.saved().profiles.staging);
});

test("auth logout --all removes a profile renamed while it waited", async () => {
  let config: any;
  const f = logoutFixture(async (_api, cookie) => {
    if (cookie.includes("prod")) {
      config.profiles.work = config.profiles.prod;
      delete config.profiles.prod;
    }
    return true;
  });
  config = f.config;
  await f.program.parseAsync(["node", "test", "auth", "logout", "--all"]);
  assert.deepEqual(f.saved().profiles, {});
  assert.equal(f.capture.data.remaining_profiles, 0);
});

test("auth logout survives malformed profile fields", async () => {
  for (const profile of [
    { api: "https://cocalc.ai", cookie: 42 },
    { api: { url: "https://cocalc.ai" }, cookie: "remember_me=x-secret" },
    { api: 7, cookie: ["remember_me=y"] },
  ]) {
    let config: any;
    const f = logoutFixture(async () => true);
    config = f.config;
    config.profiles.prod = profile;
    await f.program.parseAsync(["node", "test", "auth", "logout"]);
    assert.deepEqual(f.calls, []);
    assert.equal(f.capture.data.server_session, "not confirmed");
    assert.equal(f.capture.data.removed, "prod");
    assert.equal(f.saved().profiles.prod, undefined);
  }
});

test("a profile's sign-out request is scoped to the profile's own site", async () => {
  const calls: any[] = [];
  const relayFetch = (async (...args: any[]) => {
    calls.push(args);
    return new Response(JSON.stringify({ status: "success" }));
  }) as any;
  const scoped = profileScopedFetch("https://bay-2.cocalc.ai", relayFetch);
  await scoped("https://bay-2.cocalc.ai/api/v2/accounts/sign-out", {
    method: "POST",
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][3], { credentialSite: "https://bay-2.cocalc.ai" });
  assert.equal(calls[0][2], undefined);
});

test("external agent login creates only a separate scoped profile, despite ambient human credentials", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-external-login-"));
  const priorHome = process.env.HOME,
    priorFetch = globalThis.fetch;
  process.env.HOME = dir;
  const challenge_id = randomUUID(),
    account_id = randomUUID(),
    agent_id = randomUUID();
  const calls: { url: string; body: any; headers: any }[] = [];
  let secretHash = "";
  globalThis.fetch = (async (url, options) => {
    const body = JSON.parse(`${options?.body}`);
    calls.push({ url: `${url}`, body, headers: options?.headers });
    if (`${url}`.endsWith("auth/cli/agent/start")) {
      secretHash = body.secret_hash;
      assert.equal(body.label, "Security agent");
      return {
        json: async () => ({
          challenge_id,
          poll_token: "poll-only",
          approval_url: "https://origin.test/approve",
          expires_at: new Date(Date.now() + 900_000).toISOString(),
        }),
      } as Response;
    }
    assert.ok(`${url}`.endsWith("auth/cli/login/status"));
    return {
      json: async () => ({
        challenge_id,
        kind: "external-agent",
        state: "approved",
        external: {
          api_url: "https://home.test",
          installation: {
            installation_id: challenge_id,
            account_id,
            agent_id,
            state: "active",
            expires_at: new Date(Date.now() + 3600_000).toISOString(),
            destinations: [],
          },
        },
      }),
    } as Response;
  }) as typeof fetch;
  try {
    const capture: { data?: any } = {};
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        runLocalCommand: async (_cmd, _name, fn) => {
          capture.data = await fn({
            api: "https://origin.test",
            cookie: "human-cookie",
            bearer: "human-bearer",
          });
        },
        saveAuthConfig: () => {
          throw new Error("human profile must not change");
        },
      }),
    );
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--agent",
      "soc2",
      "--agent-label",
      "Security agent",
    ]);
    const credential = readExternalAgentCredential("soc2", dir);
    assert.equal(credential.source.agent_id, agent_id);
    assert.equal(
      createHash("sha256")
        .update(credential.token.split(".").at(-1)!)
        .digest("hex"),
      secretHash,
    );
    assert.equal(capture.data.human_profile_unchanged, true);
    assert.equal(calls.length, 2);
    assert.ok(!JSON.stringify(calls).includes("human-cookie"));
    assert.ok(!JSON.stringify(calls).includes("human-bearer"));
    assert.ok(!JSON.stringify(capture.data).includes(credential.token));
  } finally {
    globalThis.fetch = priorFetch;
    if (priorHome === undefined) delete process.env.HOME;
    else process.env.HOME = priorHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

test("auth status prefers selected cookie-backed profiles over ambient project auth", async () => {
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
          COCALC_API_URL: "http://alpha.c.projecthosts.internal:9102",
          COCALC_ACCOUNT_ID: "00000000-1000-4000-8000-000000000999",
          COCALC_SECRET_TOKEN: tokenPath,
          COCALC_PROJECT_ID: "890afc74-9156-4386-a395-afd4bebab4dd",
        },
        getExplicitAccountId: (globals: any) =>
          globals.accountId ?? globals.account_id,
        applyAuthProfile: (globals: any) => ({
          globals: {
            ...globals,
            api: "https://lite4b.cocalc.ai",
            accountId: "00000000-1000-4000-8000-000000000056",
            cookie: "remember_me=bella-cookie",
            disableEnvAuthDefaults: true,
          },
          profile: "bella",
          fromProfile: true,
        }),
      }),
    );
    await program.parseAsync(["node", "test", "auth", "status"]);
    assert.equal(capture.data.api, "https://lite4b.cocalc.ai");
    assert.equal(
      capture.data.account_id,
      "00000000-1000-4000-8000-000000000056",
    );
    assert.equal(capture.data.has_cookie, true);
    assert.equal(capture.data.has_bearer, false);
    assert.equal(capture.data.has_project_scoped_auth, false);
    assert.equal(capture.data.effective_remote_auth, "cookie");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth status --check validates cookie-backed profiles over HTTP", async () => {
  const capture: { data?: any } = {};
  const originalFetch = global.fetch;
  const fetchCalls: string[] = [];
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    const asString = `${url}`;
    fetchCalls.push(asString.replace(/^https?:\/\/[^/]+/, ""));
    if (asString.endsWith("/api/v2/accounts/profile")) {
      assert.equal(init?.headers?.Cookie, "remember_me=bella-cookie");
      return {
        json: async () => ({
          profile: {
            account_id: "00000000-1000-4000-8000-000000000056",
          },
        }),
      } as any;
    }
    if (asString.endsWith("/api/v2/auth/cli/session-status")) {
      assert.equal(init?.headers?.Cookie, "remember_me=bella-cookie");
      return {
        json: async () => ({
          auth_client: "cli",
          factor_level: "totp",
          fresh_auth_until: "2026-05-08T12:00:00.000Z",
          expire: "2026-11-08T12:00:00.000Z",
          auth_session_hash: "session-hash-1",
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
        applyAuthProfile: (globals: any) => ({
          globals: {
            ...globals,
            api: "https://lite4b.cocalc.ai",
            accountId: "00000000-1000-4000-8000-000000000056",
            cookie: "remember_me=bella-cookie",
            disableEnvAuthDefaults: true,
          },
          profile: "bella",
          fromProfile: true,
        }),
        connectRemote: async () => {
          throw new Error("connectRemote should not be used for cookie checks");
        },
        buildCookieHeader: () => "remember_me=bella-cookie",
      }),
    );
    await program.parseAsync(["node", "test", "auth", "status", "--check"]);
    assert.equal(capture.data.effective_remote_auth, "cookie");
    assert.deepEqual(capture.data.check, {
      ok: true,
      account_id: "00000000-1000-4000-8000-000000000056",
      project_id: null,
      auth_actor: "account",
      auth_session_hash: "session-hash-1",
      interactive_session: true,
      auth_client: "cli",
      factor_level: "totp",
      fresh_auth_until: "2026-05-08T12:00:00.000Z",
      session_expire: "2026-11-08T12:00:00.000Z",
    });
    assert.deepEqual(fetchCalls, [
      "/api/v2/accounts/profile",
      "/api/v2/auth/cli/session-status",
    ]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth login stores a dedicated browser-approved CLI session", async () => {
  const capture: { data?: any } = {};
  let config: any = { profiles: {} };
  const fetchCalls: Array<{ url: string; init: any }> = [];
  let loginStatusAttempts = 0;
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    fetchCalls.push({ url: `${url}`, init });
    if (`${url}`.endsWith("/api/v2/auth/cli/login/start")) {
      return {
        json: async () => ({
          challenge_id: "challenge-1",
          poll_token: "poll-token-1",
          approval_url: "https://hub.example.test/auth/cli-login/challenge-1",
          expires_at: "2099-05-08T10:00:00.000Z",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/login/status")) {
      loginStatusAttempts += 1;
      if (loginStatusAttempts === 1) {
        throw new TypeError("fetch failed");
      }
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
          home_bay_id: "bay-2",
          home_bay_url: "https://bay-2-lite4.cocalc.ai",
          email_address: "user@example.com",
          display_name: "User Example",
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
      "--poll-ms",
      "200ms",
    ]);
    assert.equal(capture.data.profile, "default");
    assert.equal(capture.data.account_id, "acct-123");
    assert.equal(capture.data.api, "https://bay-2-lite4.cocalc.ai");
    assert.equal(capture.data.login_api, "https://lite4.cocalc.ai");
    assert.equal(capture.data.home_bay_id, "bay-2");
    assert.equal(capture.data.email_address, "user@example.com");
    assert.equal(capture.data.display_name, "User Example");
    assert.equal(capture.data.interactive_session, true);
    assert.equal(config.current_profile, "default");
    assert.equal(config.profiles.default.api, "https://bay-2-lite4.cocalc.ai");
    assert.equal(config.profiles.default.account_id, "acct-123");
    assert.equal(config.profiles.default.email_address, "user@example.com");
    assert.equal(config.profiles.default.display_name, "User Example");
    assert.equal(config.profiles.default.first_name, undefined);
    assert.equal(config.profiles.default.last_name, undefined);
    assert.match(
      config.profiles.default.cookie,
      /remember_me=remember-cookie-1/,
    );
    assert.equal(fetchCalls.length, 4);
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {});
    assert.deepEqual(
      fetchCalls.map((call) => call.url.replace(/^https?:\/\/[^/]+/, "")),
      [
        "/api/v2/auth/cli/login/start",
        "/api/v2/auth/cli/login/status",
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
            display_name: "User Example",
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
      display_name: "User Example",
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
            display_name: "User Example",
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
    assert.equal(config.profiles.default.display_name, "User Example");
    assert.equal(config.profiles.default.first_name, undefined);
    assert.equal(config.profiles.default.last_name, undefined);
    assert.equal(capture.data[0].email_address, "user@example.com");
    assert.equal(capture.data[0].display_name, "User Example");
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
    await program.parseAsync(["node", "test", "auth", "elevate"]);
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

test("auth elevate registers Codex attention without printing the approval URL", async () => {
  const capture: { data?: any } = {};
  const project_id = "890afc74-9156-4386-a395-afd4bebab4dd";
  const challenge_id = "00000000-3000-4000-8000-000000000003";
  const approvalUrl = `https://hub.example.test/auth/cli-elevate/${challenge_id}`;
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const output: string[] = [];
  const originalFetch = global.fetch;
  const originalWrite = process.stderr.write;
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    fetchCalls.push({ url: `${url}`, init });
    if (`${url}`.endsWith("/api/v2/auth/cli/elevate/start")) {
      return {
        json: async () => ({
          challenge_id,
          poll_token: "poll-token-3",
          approval_url: approvalUrl,
          attention_registered: true,
          expires_at: "2099-09-02T10:00:00.000Z",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/elevate/status")) {
      return {
        json: async () => ({
          challenge_id,
          kind: "elevate",
          state: "approved",
          expires_at: "2099-09-02T10:00:00.000Z",
          factor_level: "totp",
          fresh_auth_until: "2099-09-02T18:00:00.000Z",
        }),
      } as any;
    }
    throw new Error(`unexpected fetch url ${url}`);
  }) as any;
  process.stderr.write = ((chunk: any) => {
    output.push(`${chunk}`);
    return true;
  }) as typeof process.stderr.write;
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        env: {
          COCALC_CLI_AGENT_MODE: "1",
          COCALC_PROJECT_ID: project_id,
          COCALC_CODEX_CHAT_PATH: "agent.chat",
          COCALC_CODEX_THREAD_ID: "thread-1",
          COCALC_CODEX_MESSAGE_DATE: "2099-09-02T00:00:00.000Z",
        },
        applyAuthProfile: (globals: any) => ({
          globals: {
            ...globals,
            api: "https://hub.example.test",
            account_id: "acct-123",
            cookie: "remember_me=remember-cookie-1",
          },
          profile: "default",
          fromProfile: true,
        }),
        buildCookieHeader: () => "remember_me=remember-cookie-1",
      }),
    );
    await program.parseAsync(["node", "test", "auth", "elevate"]);
    const body = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(body.codex_attention_context, {
      project_id,
      path: "agent.chat",
      thread_id: "thread-1",
      message_date: "2099-09-02T00:00:00.000Z",
    });
    assert.match(output.join(""), /Approval requested in CoCalc/);
    assert.doesNotMatch(output.join(""), /cli-elevate/);
    assert.doesNotMatch(output.join(""), new RegExp(challenge_id));
  } finally {
    global.fetch = originalFetch;
    process.stderr.write = originalWrite;
  }
});

test("auth bootstrap runs one elevated login and checks the session", async () => {
  const capture: { data?: any } = {};
  let config: any = { profiles: {} };
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    fetchCalls.push({ url: `${url}`, init });
    if (`${url}`.endsWith("/api/v2/auth/cli/login/start")) {
      return {
        json: async () => ({
          challenge_id: "login-challenge",
          poll_token: "login-poll",
          approval_url:
            "https://hub.example.test/auth/cli-login/login-challenge",
          expires_at: "2026-05-08T10:00:00.000Z",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/login/status")) {
      return {
        json: async () => ({
          challenge_id: "login-challenge",
          kind: "login",
          state: "approved",
          expires_at: "2026-05-08T10:00:00.000Z",
          redeem_token: "login-redeem",
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
          display_name: "User Example",
          first_name: "User",
          last_name: "Example",
          factor_level: "passkey",
          fresh_auth_until: "2026-05-08T18:00:00.000Z",
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/accounts/profile")) {
      assert.equal(init?.headers?.Cookie, "remember_me=remember-cookie-1");
      return {
        json: async () => ({
          profile: {
            account_id: "acct-123",
          },
        }),
      } as any;
    }
    if (`${url}`.endsWith("/api/v2/auth/cli/session-status")) {
      assert.equal(init?.headers?.Cookie, "remember_me=remember-cookie-1");
      return {
        json: async () => ({
          auth_client: "cli",
          auth_session_hash: "session-hash-1",
          factor_level: "passkey",
          fresh_auth_until: "2026-05-08T18:00:00.000Z",
          expire: "2026-11-08T10:00:00.000Z",
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
        defaultApiBaseUrl: () => "https://hub.example.test",
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
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "bootstrap",
      "--email",
      "user@example.com",
    ]);
    assert.equal(capture.data.profile, "default");
    assert.equal(capture.data.login.account_id, "acct-123");
    assert.equal(capture.data.elevation.factor_level, "passkey");
    assert.equal(capture.data.status.ok, true);
    assert.equal(capture.data.status.account_id, "acct-123");
    assert.equal(
      capture.data.status.fresh_auth_until,
      "2026-05-08T18:00:00.000Z",
    );
    assert.deepEqual(
      fetchCalls.map((call) => call.url.replace(/^https?:\/\/[^/]+/, "")),
      [
        "/api/v2/auth/cli/login/start",
        "/api/v2/auth/cli/login/status",
        "/api/v2/auth/cli/login/redeem",
        "/api/v2/accounts/profile",
        "/api/v2/auth/cli/session-status",
      ],
    );
    assert.deepEqual(JSON.parse(fetchCalls[0].init.body), {
      email: "user@example.com",
      elevated_login: true,
      duration: "extended",
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth elevate --dev --short approves the current CLI session with hub password", async () => {
  const capture: { data?: any } = {};
  let cookieGlobals: any;
  const fetchCalls: Array<{ url: string; init: any }> = [];
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request, init?: any) => {
    fetchCalls.push({ url: `${url}`, init });
    if (`${url}`.endsWith("/api/v2/auth/cli/elevate/dev")) {
      assert.equal(
        init?.headers?.Cookie,
        "remember_me=remember-cookie-1; hub_password=hub-secret",
      );
      assert.equal(JSON.parse(init.body).duration, "default");
      return {
        json: async () => ({
          approved: true,
          dev: true,
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
        env: {
          COCALC_HUB_PASSWORD: "hub-secret",
        },
        applyAuthProfile: (globals: any) => ({
          globals: {
            ...globals,
            api: "https://hub.example.test",
            accountId: "acct-123",
            cookie: "remember_me=remember-cookie-1",
            disableEnvAuthDefaults: true,
          },
          profile: "default",
          fromProfile: true,
        }),
        buildCookieHeader: (_apiBaseUrl: string, effective: any) => {
          cookieGlobals = effective;
          return `remember_me=remember-cookie-1; hub_password=${effective.hubPassword}`;
        },
        getExplicitAccountId: (globals: any) => globals.accountId,
      }),
    );
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "elevate",
      "--dev",
      "--short",
    ]);
    assert.equal(cookieGlobals.hubPassword, "hub-secret");
    assert.equal(cookieGlobals.disableEnvAuthDefaults, false);
    assert.equal(capture.data.interactive_session, true);
    assert.equal(capture.data.dev, true);
    assert.equal(capture.data.factor_level, "totp");
    assert.equal(capture.data.fresh_auth_until, "2026-05-08T18:00:00.000Z");
    assert.deepEqual(
      fetchCalls.map((call) => call.url.replace(/^https?:\/\/[^/]+/, "")),
      ["/api/v2/auth/cli/elevate/dev"],
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("auth elevate --dev bootstraps a local dev session when only hub password auth is available", async () => {
  const capture: { data?: any } = {};
  let bootstrapArgs: any;
  let config: any = { profiles: {} };
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request) => {
    throw new Error(`unexpected fetch url ${url}`);
  }) as any;
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        env: {
          COCALC_HUB_PASSWORD: "/tmp/hub-password",
          COCALC_ACCOUNT_ID: "00000000-1000-4000-8000-000000000056",
        },
        applyAuthProfile: (globals: any) => ({
          globals: {
            ...globals,
            api: "http://127.0.0.1:9100",
          },
          profile: "default",
          fromProfile: false,
        }),
        loadAuthConfig: () => config,
        saveAuthConfig: (next: any) => {
          config = next;
        },
        buildCookieHeader: (_apiBaseUrl: string, effective: any) => {
          if (effective.cookie) return effective.cookie;
          return effective.hubPassword
            ? `hub_password=${effective.hubPassword}`
            : undefined;
        },
        getExplicitAccountId: (globals: any) => globals.accountId,
        maybeCreateLocalDevRememberMeCookie: async (args: any) => {
          bootstrapArgs = args;
          return {
            value: "remember-cookie-1",
            session_hash: "session-hash-1",
            account_id: "00000000-1000-4000-8000-000000000056",
            apiBaseUrl: "http://127.0.0.1:13114",
            bay_id: "bay-1",
            factor_level: "totp",
            fresh_auth_until: "2026-05-08T18:00:00.000Z",
          };
        },
      }),
    );
    await program.parseAsync(["node", "test", "auth", "elevate", "--dev"]);
    assert.equal(
      bootstrapArgs.requestedAccountId,
      "00000000-1000-4000-8000-000000000056",
    );
    assert.equal(bootstrapArgs.freshAuthDuration, "extended");
    assert.equal(capture.data.bootstrapped_session, true);
    assert.equal(capture.data.dev, true);
    assert.equal(capture.data.api, "http://127.0.0.1:13114");
    assert.equal(capture.data.bay_id, "bay-1");
    assert.equal(capture.data.factor_level, "totp");
    assert.equal(capture.data.fresh_auth_until, "2026-05-08T18:00:00.000Z");
    assert.equal(config.current_profile, "default");
    assert.deepEqual(config.profiles.default, {
      api: "http://127.0.0.1:13114",
      account_id: "00000000-1000-4000-8000-000000000056",
      cookie: "remember_me=remember-cookie-1",
    });
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

test("auth use rejects reserved env auth profile names", async () => {
  const capture: { data?: any } = {};
  const config: any = {
    current_profile: "default",
    profiles: {
      default: { account_id: "acct-123" },
    },
  };
  const program = new Command();
  registerAuthCommand(
    program,
    makeDeps(capture, {
      loadAuthConfig: () => config,
      sanitizeProfileName,
    }),
  );
  await assert.rejects(
    program.parseAsync(["node", "test", "auth", "use", "_env"]),
    /reserved for environment-based auth/,
  );
});

// ---- recorded grant timestamps (client-side, informational only)

function grantFixture() {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-auth-grant-"));
  const configPath = join(dir, "config.json");
  return { dir, configPath };
}

function fakeFetch(
  routes: Record<string, () => any>,
  calls: string[] = [],
): () => void {
  const originalFetch = global.fetch;
  global.fetch = (async (url: string | URL | Request) => {
    const path = `${url}`.replace(/^https?:\/\/[^/]+/, "");
    calls.push(path);
    const route = routes[path];
    if (!route) throw new Error(`unexpected fetch url ${url}`);
    return { json: async () => route() } as any;
  }) as any;
  return () => {
    global.fetch = originalFetch;
  };
}

function elevateDeps(
  capture: { data?: any },
  configPath: string,
  config: { profiles: any; current_profile?: string },
  saves: { n: number },
) {
  return makeDeps(capture, {
    authConfigPath: () => configPath,
    loadAuthConfig: () => config,
    saveAuthConfig: () => {
      saves.n += 1;
    },
    applyAuthProfile: (globals: any) => ({
      globals: { ...config.profiles.prod, ...globals },
      profile: "prod",
      fromProfile: true,
    }),
    buildCookieHeader: (_api: string, effective: any) => effective.cookie,
  });
}

const PROD = {
  api: "https://hub.example.test",
  account_id: "acct-123",
  cookie: "remember_me=remember-cookie-1",
};

test("auth login records the session and fresh-auth expiry; auth status shows them without any request", async () => {
  const { dir, configPath } = grantFixture();
  const capture: { data?: any } = {};
  let config: any = { profiles: {} };
  const restore = fakeFetch({
    "/api/v2/auth/cli/login/start": () => ({
      challenge_id: "c1",
      poll_token: "p1",
      approval_url: "https://hub.example.test/a",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
    "/api/v2/auth/cli/login/status": () => ({
      challenge_id: "c1",
      kind: "login",
      state: "approved",
      expires_at: "2099-01-01T00:00:00.000Z",
      redeem_token: "r1",
    }),
    "/api/v2/auth/cli/login/redeem": () => ({
      account_id: "acct-123",
      remember_me: "remember-cookie-1",
      expire: "2099-02-01T00:00:00.000Z",
      fresh_auth_until: "2099-01-01T08:00:00.000Z",
    }),
  });
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(capture, {
        authConfigPath: () => configPath,
        loadAuthConfig: () => config,
        saveAuthConfig: (next: any) => {
          config = next;
        },
        defaultApiBaseUrl: () => "https://hub.example.test",
      }),
    );
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "login",
      "--poll-ms",
      "200ms",
    ]);
  } finally {
    restore();
  }
  // the credential file is not touched by the record
  assert.equal(JSON.stringify(config).includes("fresh_auth"), false);
  assert.equal(JSON.stringify(config).includes("recorded"), false);

  const calls: string[] = [];
  const restore2 = fakeFetch({}, calls);
  try {
    const status: { data?: any } = {};
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(status, {
        authConfigPath: () => configPath,
        loadAuthConfig: () => config,
        applyAuthProfile: (globals: any) => ({
          globals: { ...config.profiles.default, ...globals },
          profile: "default",
          fromProfile: true,
        }),
      }),
    );
    await program.parseAsync(["node", "test", "auth", "status"]);
    assert.deepEqual(calls, []); // no RPC
    assert.equal(status.data.recorded_profile, "default");
    assert.equal(
      status.data.recorded_session_expires_at,
      "2099-02-01T00:00:00.000Z",
    );
    assert.equal(
      status.data.recorded_fresh_auth_until,
      "2099-01-01T08:00:00.000Z",
    );
    assert.ok(status.data.fresh_auth_remaining_s > 0);
    assert.ok(status.data.session_remaining_s > 0);
    assert.match(status.data.recorded_note, /this CLI config on this machine/);
    // no secret-derived value in plain status
    const text = JSON.stringify(status.data);
    assert.equal(text.includes("remember-cookie-1"), false);
    assert.equal(text.includes("auth_session_hash"), false);
  } finally {
    restore2();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth elevate records fresh auth in the sidecar only: the credential file is not written", async () => {
  const { dir, configPath } = grantFixture();
  const config = { current_profile: "prod", profiles: { prod: { ...PROD } } };
  const before = JSON.stringify(config);
  const saves = { n: 0 };
  recordSessionGrant(configPath, "prod", {
    api: PROD.api,
    session_expires_at: "2099-02-01T00:00:00.000Z",
    fresh_auth_until: null,
  });
  // another CLI process records a different profile during the browser wait
  let polls = 0;
  const restore = fakeFetch({
    "/api/v2/auth/cli/elevate/start": () => ({
      challenge_id: "c2",
      poll_token: "p2",
      approval_url: "https://hub.example.test/e",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
    "/api/v2/auth/cli/elevate/status": () => {
      polls += 1;
      recordSessionGrant(configPath, "staging", {
        api: "https://staging.example.test",
        session_expires_at: "2099-03-01T00:00:00.000Z",
        fresh_auth_until: null,
      });
      return {
        challenge_id: "c2",
        kind: "elevate",
        state: "approved",
        expires_at: "2099-01-01T00:00:00.000Z",
        fresh_auth_until: "2099-01-01T08:00:00.000Z",
      };
    },
  });
  try {
    const capture: { data?: any } = {};
    const program = new Command();
    registerAuthCommand(
      program,
      elevateDeps(capture, configPath, config, saves),
    );
    await program.parseAsync(["node", "test", "auth", "elevate"]);
    assert.equal(polls, 1);
    assert.equal(saves.n, 0);
    assert.equal(JSON.stringify(config), before);
    const grants = JSON.parse(
      readFileSync(authGrantsPath(configPath), "utf8"),
    ).grants;
    assert.equal(grants.prod.fresh_auth_until, "2099-01-01T08:00:00.000Z");
    assert.equal(grants.prod.session_expires_at, "2099-02-01T00:00:00.000Z");
    assert.equal(grants.staging.session_expires_at, "2099-03-01T00:00:00.000Z");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failed auth elevate clears the recorded fresh-auth window", async () => {
  const { dir, configPath } = grantFixture();
  const config = { current_profile: "prod", profiles: { prod: { ...PROD } } };
  recordSessionGrant(configPath, "prod", {
    api: PROD.api,
    session_expires_at: "2099-02-01T00:00:00.000Z",
    fresh_auth_until: "2099-01-01T08:00:00.000Z",
  });
  const restore = fakeFetch({
    "/api/v2/auth/cli/elevate/start": () => ({ error: "denied" }),
  });
  try {
    const program = new Command();
    registerAuthCommand(program, elevateDeps({}, configPath, config, { n: 0 }));
    await assert.rejects(
      program.parseAsync(["node", "test", "auth", "elevate"]),
      /denied/,
    );
    const grants = JSON.parse(
      readFileSync(authGrantsPath(configPath), "utf8"),
    ).grants;
    assert.equal(grants.prod.fresh_auth_until, null);
    assert.equal(grants.prod.session_expires_at, "2099-02-01T00:00:00.000Z");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth elevate with an explicit --cookie does not write a record for the stored profile", async () => {
  const { dir, configPath } = grantFixture();
  const config = { current_profile: "prod", profiles: { prod: { ...PROD } } };
  const restore = fakeFetch({
    "/api/v2/auth/cli/elevate/start": () => ({
      challenge_id: "c3",
      poll_token: "p3",
      approval_url: "https://hub.example.test/e",
      expires_at: "2099-01-01T00:00:00.000Z",
    }),
    "/api/v2/auth/cli/elevate/status": () => ({
      challenge_id: "c3",
      kind: "elevate",
      state: "approved",
      expires_at: "2099-01-01T00:00:00.000Z",
      fresh_auth_until: "2099-01-01T08:00:00.000Z",
    }),
  });
  try {
    const program = new Command();
    registerAuthCommand(
      program,
      makeDeps(
        {},
        {
          authConfigPath: () => configPath,
          loadAuthConfig: () => config,
          runLocalCommand: async (_c: unknown, _n: string, fn: any) => {
            await fn({ cookie: "remember_me=other-session" });
          },
          applyAuthProfile: (globals: any) => ({
            globals: { ...config.profiles.prod, ...globals },
            profile: "prod",
            fromProfile: true,
          }),
          buildCookieHeader: (_api: string, effective: any) => effective.cookie,
        },
      ),
    );
    await program.parseAsync(["node", "test", "auth", "elevate"]);
    assert.throws(() => readFileSync(authGrantsPath(configPath)));
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("auth logout removes the profile's record; auth rename moves it", async () => {
  const { dir, configPath } = grantFixture();
  let config: any = {
    current_profile: "prod",
    profiles: { prod: { ...PROD }, keep: { ...PROD } },
  };
  const grant = {
    api: PROD.api,
    session_expires_at: "2099-02-01T00:00:00.000Z",
    fresh_auth_until: "2099-01-01T08:00:00.000Z",
  };
  recordSessionGrant(configPath, "prod", grant);
  recordSessionGrant(configPath, "keep", grant);
  try {
    const deps = (capture: { data?: any }) =>
      makeDeps(capture, {
        authConfigPath: () => configPath,
        loadAuthConfig: () => structuredClone(config),
        saveAuthConfig: (next: any) => {
          config = next;
        },
        revokeSession: async () => true,
      });
    let program = new Command();
    registerAuthCommand(program, deps({}));
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "rename",
      "keep",
      "kept",
    ]);
    let grants = JSON.parse(
      readFileSync(authGrantsPath(configPath), "utf8"),
    ).grants;
    assert.deepEqual(Object.keys(grants).sort(), ["kept", "prod"]);
    program = new Command();
    registerAuthCommand(program, deps({}));
    await program.parseAsync([
      "node",
      "test",
      "auth",
      "logout",
      "--target-profile",
      "prod",
    ]);
    grants = JSON.parse(
      readFileSync(authGrantsPath(configPath), "utf8"),
    ).grants;
    assert.deepEqual(Object.keys(grants), ["kept"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the writer and auth status reference the recorded grant fields", () => {
  // Informational only: no other code may read them to decide anything.
  const srcRoot = join(__dirname, "..", "..");
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".js") && !p.endsWith(".test.js")) {
        const text = readFileSync(p, "utf8");
        if (/auth-grants|recordedAuthStatus/.test(text))
          hits.push(p.slice(srcRoot.length + 1));
      }
    }
  };
  walk(srcRoot);
  assert.deepEqual(hits.sort(), [
    "bin/commands/auth.js",
    "bin/main.js",
    "core/auth-grants.js",
  ]);
  const authJs = readFileSync(
    join(srcRoot, "bin", "commands", "auth.js"),
    "utf8",
  );
  // auth.ts only writes records, and reads them in exactly one place (status)
  assert.equal((authJs.match(/recordedAuthStatus\)?\(/g) ?? []).length, 1);
});

for (const outcome of ["approved", "error"] as const) {
  for (const change of ["re-login", "logout"] as const) {
    test(`auth elevate (${outcome}) after a ${change} during the wait leaves the new state's record alone (review R3)`, async () => {
      const { dir, configPath } = grantFixture();
      const config: any = {
        current_profile: "prod",
        profiles: { prod: { ...PROD } },
      };
      recordSessionGrant(configPath, "prod", {
        api: PROD.api,
        session_expires_at: "2099-02-01T00:00:00.000Z",
        fresh_auth_until: "2099-01-01T02:00:00.000Z",
      });
      const restore = fakeFetch({
        "/api/v2/auth/cli/elevate/start": () => ({
          challenge_id: "c4",
          poll_token: "p4",
          approval_url: "https://hub.example.test/e",
          expires_at: "2099-01-01T00:00:00.000Z",
        }),
        "/api/v2/auth/cli/elevate/status": () => {
          // another CLI process changes this profile during the wait
          if (change === "re-login") {
            config.profiles.prod = {
              ...PROD,
              cookie: "remember_me=new-session",
            };
            recordSessionGrant(configPath, "prod", {
              api: PROD.api,
              session_expires_at: "2099-03-01T00:00:00.000Z",
              fresh_auth_until: "2099-01-01T05:00:00.000Z",
            });
          } else {
            delete config.profiles.prod;
          }
          if (outcome === "error") return { error: "denied" };
          return {
            challenge_id: "c4",
            kind: "elevate",
            state: "approved",
            expires_at: "2099-01-01T00:00:00.000Z",
            fresh_auth_until: "2099-01-01T08:00:00.000Z",
          };
        },
      });
      try {
        const program = new Command();
        registerAuthCommand(
          program,
          makeDeps(
            {},
            {
              authConfigPath: () => configPath,
              loadAuthConfig: () => config,
              applyAuthProfile: (globals: any) => ({
                globals: { ...config.profiles.prod, ...globals },
                profile: "prod",
                fromProfile: true,
              }),
              buildCookieHeader: (_api: string, effective: any) =>
                effective.cookie,
            },
          ),
        );
        const run = program.parseAsync(["node", "test", "auth", "elevate"]);
        if (outcome === "error") await assert.rejects(run, /denied/);
        else await run;
        const grants = JSON.parse(
          readFileSync(authGrantsPath(configPath), "utf8"),
        ).grants;
        if (change === "re-login") {
          // the new session's record is untouched by the old session's result
          assert.equal(
            grants.prod.session_expires_at,
            "2099-03-01T00:00:00.000Z",
          );
          assert.equal(
            grants.prod.fresh_auth_until,
            "2099-01-01T05:00:00.000Z",
          );
        } else {
          // logged out meanwhile: the old record is not refreshed
          assert.equal(
            grants.prod.fresh_auth_until,
            "2099-01-01T02:00:00.000Z",
          );
        }
      } finally {
        restore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
