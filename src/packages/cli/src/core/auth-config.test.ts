import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyAuthProfile,
  authConfigPath,
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

test("selectedProfileName uses globals then env then current", () => {
  const config: AuthConfig = { current_profile: "saved", profiles: {} };
  assert.equal(selectedProfileName({ profile: "flag" }, config, {} as any), "flag");
  assert.equal(
    selectedProfileName({}, config, { COCALC_PROFILE: "env" } as any),
    "env",
  );
  assert.equal(selectedProfileName({}, config, {} as any), "saved");
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
  assert.equal(result.globals.accountId, "00000000-1000-4000-8000-000000000001");
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
