import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyAuthProfile,
  authConfigPath,
  ENV_AUTH_PROFILE,
  isEnvAuthProfileName,
  loadAuthConfig,
  sanitizeProfileName,
  saveAuthConfig,
  selectedProfileName,
  type AuthConfig,
} from "./auth-config";

test("sanitizeProfileName validates and defaults", () => {
  assert.equal(sanitizeProfileName(undefined), "default");
  assert.equal(sanitizeProfileName("  alpha-1  "), "alpha-1");
  assert.throws(() => sanitizeProfileName("bad name"), /invalid profile name/);
  assert.throws(
    () => sanitizeProfileName("_env"),
    /reserved for environment-based auth/,
  );
  assert.throws(
    () => sanitizeProfileName("env"),
    /reserved for environment-based auth/,
  );
  assert.equal(isEnvAuthProfileName("_env"), true);
  assert.equal(isEnvAuthProfileName("env"), true);
});

test("authConfigPath uses env override", () => {
  assert.equal(
    authConfigPath({ COCALC_CLI_CONFIG: "/tmp/custom-config.json" } as any),
    "/tmp/custom-config.json",
  );
});

test("loadAuthConfig/saveAuthConfig round-trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-config-"));
  const file = join(dir, "config.json");
  const config: AuthConfig = {
    current_profile: "dev",
    profiles: {
      dev: {
        api: "http://localhost:9104",
        account_id: "00000000-1000-4000-8000-000000000001",
        api_key: "secret",
      },
    },
  };
  saveAuthConfig(config, file);
  const loaded = loadAuthConfig(file);
  assert.deepEqual(loaded, config);
  rmSync(dir, { recursive: true, force: true });
});

test("saveAuthConfig stores credentials in a private config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-config-"));
  const file = join(dir, "config.json");
  try {
    saveAuthConfig(
      {
        current_profile: "dev",
        profiles: {
          dev: {
            api: "https://cocalc.example.test",
            cookie: "remember_me=secret-cookie",
            bearer: "secret-bearer",
            hub_password: "secret-hub-password",
          },
        },
      },
      file,
    );
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("selectedProfileName uses globals then env then current", () => {
  const config: AuthConfig = { current_profile: "saved", profiles: {} };
  assert.equal(
    selectedProfileName({ profile: "flag" }, config, {} as any),
    "flag",
  );
  assert.equal(
    selectedProfileName({}, config, { COCALC_PROFILE: "env" } as any),
    ENV_AUTH_PROFILE,
  );
  assert.equal(selectedProfileName({}, config, {} as any), "saved");
  assert.equal(
    selectedProfileName({ profile: "_env" }, config, {} as any),
    ENV_AUTH_PROFILE,
  );
  assert.equal(
    selectedProfileName(
      {},
      { current_profile: "_env", profiles: {} },
      {} as any,
    ),
    ENV_AUTH_PROFILE,
  );
});

test("applyAuthProfile merges selected profile values", () => {
  const config: AuthConfig = {
    current_profile: "default",
    profiles: {
      default: {
        api: "http://localhost:9104",
        account_id: "00000000-1000-4000-8000-000000000001",
        api_key: "abc",
      },
    },
  };
  const result = applyAuthProfile({}, config, {} as any);
  assert.equal(result.fromProfile, true);
  assert.equal(result.profile, "default");
  assert.equal(result.globals.api, "http://localhost:9104");
  assert.equal(
    result.globals.accountId,
    "00000000-1000-4000-8000-000000000001",
  );
  assert.equal(result.globals.apiKey, "abc");
});

test("applyAuthProfile does not override explicit globals", () => {
  const config: AuthConfig = {
    current_profile: "default",
    profiles: {
      default: {
        api: "http://localhost:9104",
        api_key: "abc",
      },
    },
  };
  const result = applyAuthProfile(
    { api: "http://127.0.0.1:9999", apiKey: "xyz" },
    config,
    {} as any,
  );
  assert.equal(result.globals.api, "http://127.0.0.1:9999");
  assert.equal(result.globals.apiKey, "xyz");
});

test("applyAuthProfile overrides ambient env defaults with selected profile values", () => {
  const config: AuthConfig = {
    current_profile: "bella",
    profiles: {
      bella: {
        api: "https://lite4b.cocalc.ai",
        account_id: "00000000-1000-4000-8000-000000000056",
        cookie: "remember_me=bella-cookie",
      },
    },
  };
  const result = applyAuthProfile({}, config, {
    COCALC_API_URL: "http://alpha.c.projecthosts.internal:9102",
    COCALC_ACCOUNT_ID: "00000000-1000-4000-8000-000000000999",
    COCALC_BEARER_TOKEN: "agent-token",
  } as any);
  assert.equal(result.globals.api, "https://lite4b.cocalc.ai");
  assert.equal(
    result.globals.accountId,
    "00000000-1000-4000-8000-000000000056",
  );
  assert.equal(result.globals.cookie, "remember_me=bella-cookie");
  assert.equal(result.globals.disableEnvAuthDefaults, true);
});

test("applyAuthProfile keeps ambient env auth when env auth profile is selected", () => {
  const config: AuthConfig = {
    current_profile: "default",
    profiles: {
      default: {
        api: "https://lite4b.cocalc.ai",
        cookie: "remember_me=stored",
      },
      _env: {
        api: "https://should-not-apply.example",
        cookie: "remember_me=reserved",
      },
    },
  };
  const result = applyAuthProfile({}, config, {
    COCALC_PROFILE: "_env",
  } as any);
  assert.equal(result.profile, ENV_AUTH_PROFILE);
  assert.equal(result.fromProfile, false);
  assert.equal(result.globals.api, undefined);
  assert.equal(result.globals.cookie, undefined);
  assert.equal(result.globals.disableEnvAuthDefaults, undefined);
});
