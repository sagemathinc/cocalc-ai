import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Command } from "commander";

import { registerAuthCommand, type AuthCommandDeps } from "./auth";
import { normalizeSecretValue } from "../../core/auth-cookies";

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
