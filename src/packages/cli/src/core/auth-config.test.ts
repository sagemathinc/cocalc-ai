import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

test("host SSH profile default respects API scope and explicit overrides", () => {
  const config: AuthConfig = {
    current_profile: "prod",
    profiles: {
      prod: { api: "https://prod.example", host_ssh_network: "private" },
    },
  };
  assert.equal(
    applyAuthProfile({}, config, {}).globals.hostSshNetwork,
    "private",
  );
  assert.equal(
    applyAuthProfile({ hostSshNetwork: "public" }, config, {}).globals
      .hostSshNetwork,
    "public",
  );
  assert.equal(
    applyAuthProfile({ api: "https://other.example" }, config, {}).globals
      .hostSshNetwork,
    undefined,
  );
});

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

test("an explicit API key file does not inherit a profile key", () => {
  const config: AuthConfig = {
    current_profile: "default",
    profiles: { default: { api_key: "profile-secret" } },
  };
  const result = applyAuthProfile(
    { apiKeyFile: "/tmp/scoped-key" },
    config,
    {} as any,
  );
  assert.equal(result.globals.apiKey, undefined);
  assert.equal(result.globals.apiKeyFile, "/tmp/scoped-key");
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

test("applyAuthProfile defaults agent runtimes to ambient auth", () => {
  const config: AuthConfig = {
    current_profile: "prod",
    profiles: {
      prod: {
        api: "https://cocalc.ai",
        cookie: "remember_me=stored-account-session",
      },
    },
  };
  const result = applyAuthProfile({}, config, {
    COCALC_CLI_AGENT_MODE: "1",
    COCALC_API_URL: "http://project-host.internal:9102",
    COCALC_BEARER_TOKEN: "project-agent-token",
  } as any);
  assert.equal(result.profile, ENV_AUTH_PROFILE);
  assert.equal(result.fromProfile, false);
  assert.equal(result.globals.api, undefined);
  assert.equal(result.globals.cookie, undefined);
  assert.equal(result.globals.disableEnvAuthDefaults, undefined);
});

test("an explicit profile overrides the agent runtime default", () => {
  const config: AuthConfig = {
    current_profile: "default",
    profiles: {
      prod: { api: "https://cocalc.ai" },
    },
  };
  assert.equal(
    selectedProfileName({ profile: "prod" }, config, {
      COCALC_CLI_AGENT_MODE: "1",
    } as any),
    "prod",
  );
});

function sampleConfig(cookie: string): AuthConfig {
  return {
    current_profile: "dev",
    profiles: { dev: { api: "https://cocalc.example.test", cookie } },
  };
}

test("saveAuthConfig replaces the file atomically: 0600, no temp file left", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-config-"));
  const file = join(dir, "config.json");
  try {
    writeFileSync(file, "{}\n", { mode: 0o644 });
    saveAuthConfig(sampleConfig("remember_me=a"), file);
    saveAuthConfig(sampleConfig("remember_me=b"), file);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), ["config.json"]);
    assert.equal(loadAuthConfig(file).profiles.dev.cookie, "remember_me=b");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveAuthConfig keeps a symlinked config's link and updates its target", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-config-"));
  const real = join(dir, "real", "config.json");
  const link = join(dir, "config.json");
  try {
    mkdirSync(join(dir, "real"));
    writeFileSync(real, "{}\n");
    symlinkSync(join("real", "config.json"), link);
    saveAuthConfig(sampleConfig("remember_me=linked"), link);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(
      loadAuthConfig(real).profiles.dev.cookie,
      "remember_me=linked",
    );
    assert.equal(statSync(real).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(join(dir, "real")), ["config.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveAuthConfig writes through a dangling symlink, as before", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-config-"));
  const link = join(dir, "config.json");
  try {
    symlinkSync("target.json", link);
    saveAuthConfig(sampleConfig("remember_me=new"), link);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(
      loadAuthConfig(join(dir, "target.json")).profiles.dev.cookie,
      "remember_me=new",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "a failed save leaves the existing config intact",
  { skip: process.getuid?.() === 0 },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-config-"));
    const file = join(dir, "config.json");
    try {
      saveAuthConfig(sampleConfig("remember_me=original"), file);
      const before = readFileSync(file, "utf8");
      chmodSync(dir, 0o500); // no new files can be created in the directory
      assert.throws(() =>
        saveAuthConfig(sampleConfig("remember_me=new"), file),
      );
      chmodSync(dir, 0o700);
      assert.equal(readFileSync(file, "utf8"), before);
      assert.deepEqual(readdirSync(dir), ["config.json"]);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
