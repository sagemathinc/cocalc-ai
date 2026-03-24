import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildCookieHeader,
  cookieNameFor,
  describeProjectScopedAuth,
  normalizeSecretValue,
} from "./auth-cookies";

test("normalizeSecretValue reads token contents from a file path", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-cookie-"));
  const tokenPath = join(dir, "secret-token");
  writeFileSync(tokenPath, "secret-token-value\n", "utf8");
  assert.equal(normalizeSecretValue(tokenPath), "secret-token-value");
  rmSync(dir, { recursive: true, force: true });
});

test("buildCookieHeader includes project_secret and project_id from launchpad agent env", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-cookie-"));
  const tokenPath = join(dir, "secret-token");
  writeFileSync(tokenPath, "project-secret-token\n", "utf8");
  const projectId = "890afc74-9156-4386-a395-afd4bebab4dd";
  const header = buildCookieHeader("https://lite2.cocalc.ai", {}, {}, {
    COCALC_SECRET_TOKEN: tokenPath,
    COCALC_PROJECT_ID: projectId,
  } as any);
  assert.ok(
    header?.includes(
      `${cookieNameFor("https://lite2.cocalc.ai", "project_secret")}=project-secret-token`,
    ),
  );
  assert.ok(
    header?.includes(
      `${cookieNameFor("https://lite2.cocalc.ai", "project_id")}=${projectId}`,
    ),
  );
  rmSync(dir, { recursive: true, force: true });
});

test("buildCookieHeader skips project auth when project_id is invalid", () => {
  const header = buildCookieHeader("https://lite2.cocalc.ai", {}, {}, {
    project_secret: "secret-token",
    project_id: "not-a-uuid",
  } as any);
  assert.equal(header, undefined);
});

test("describeProjectScopedAuth explains when project-scoped auth is active", () => {
  const dir = mkdtempSync(join(tmpdir(), "cocalc-cli-auth-cookie-"));
  const tokenPath = join(dir, "secret-token");
  writeFileSync(tokenPath, "project-secret-token\n", "utf8");
  const status = describeProjectScopedAuth({
    COCALC_SECRET_TOKEN: tokenPath,
    COCALC_PROJECT_ID: "890afc74-9156-4386-a395-afd4bebab4dd",
  } as any);
  assert.equal(status.has_project_secret, true);
  assert.equal(status.has_project_id, true);
  assert.equal(status.has_project_scoped_auth, true);
  assert.equal(status.project_auth_source, "COCALC_SECRET_TOKEN");
  assert.match(status.project_auth_message, /project-scoped auth is available/);
  rmSync(dir, { recursive: true, force: true });
});
