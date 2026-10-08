/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A full site master key rotation over every store the key protects:
// encrypt under K1, rotate to K2 (K1 retired), check the dry run, execute,
// and verify that everything decrypts with K2 alone.

import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const secretsDir = mkdtempSync(join(tmpdir(), "cocalc-master-key-migration-"));
jest.mock("@cocalc/backend/data", () => ({
  get secrets() {
    return secretsDir;
  },
}));

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { testCleanup } from "@cocalc/database/test-utils";
import {
  activateSiteMasterKey,
  deriveSiteMasterKey,
  siteMasterKeyId,
  stageNextSiteMasterKey,
} from "@cocalc/util/master-key-lifecycle";
import {
  decryptProjectSecretValue,
  encryptProjectSecretValue,
} from "@cocalc/util/project-secrets";
import {
  decryptSecretSettingValue,
  encryptSecretSettingValue,
} from "@cocalc/util/secret-settings-crypto";
import { inviteEmailHash, runMasterKeyMigration } from "./master-key-migration";

const PROJECT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FACTOR = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CREDENTIAL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const REPO = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TURN = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const HOST = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const INVITE = "12121212-1212-4212-8212-121212121212";

function backupSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

describe("site master key rotation re-encryption", () => {
  const k1 = randomBytes(32);
  const settings1 = deriveSiteMasterKey(k1, "secret-settings:v1");
  const enc = (aad: string, value: string) =>
    encryptSecretSettingValue(aad, value, settings1, siteMasterKeyId(k1));

  beforeAll(async () => {
    writeFileSync(join(secretsDir, "site-master-key"), k1.toString("base64"), {
      mode: 0o600,
    });
    await initEphemeralDatabase({});
    const pool = getPool();
    await pool.query(`CREATE TABLE IF NOT EXISTS project_secrets (
      project_id UUID NOT NULL, name TEXT NOT NULL, encrypted_value JSONB NOT NULL,
      value_bytes INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (project_id, name))`);
    await pool.query(`CREATE TABLE IF NOT EXISTS project_secrets_runtime_state (
      project_id UUID PRIMARY KEY, generation BIGINT NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ)`);

    await pool.query(
      "INSERT INTO server_settings(name, value) VALUES ('stripe_secret_key', $1)",
      [enc("stripe_secret_key", "sk_live_x")],
    );
    await pool.query(
      "INSERT INTO account_second_factors(id, secret_encrypted) VALUES ($1, $2)",
      [FACTOR, enc(`account_second_factor_secret:${FACTOR}`, "totp-seed")],
    );
    await pool.query(
      `INSERT INTO external_credentials(id, provider, kind, scope, encrypted_payload)
       VALUES ($1, 'openai', 'api-key', 'site', $2)`,
      [CREDENTIAL, enc("external_credentials:openai:api-key:site", "payload")],
    );
    await pool.query(
      "INSERT INTO project_backup_repos(id, secret) VALUES ($1, $2)",
      [
        REPO,
        backupSecret(
          "repo-password",
          deriveSiteMasterKey(k1, "project-backup-repo-secrets:v1"),
        ),
      ],
    );
    await pool.query("INSERT INTO registration_tokens(token) VALUES ($1)", [
      enc("registration_tokens.token", "signup-token"),
    ]);
    await pool.query(
      `INSERT INTO agent_cocalc_connector_turns(
         turn_id, secret_ciphertext, account_id, agent_id, config_id, config_revision,
         expires_at, idempotency_key, key_id, run_id, source_host_id, source_project_id)
       VALUES ($1, $2, $3, $3, $3, 1, NOW() + INTERVAL '1 hour', $3, 'k', $3, $3, $3)`,
      [TURN, enc(`agent-cocalc-connector-turn:${TURN}`, "api-key"), PROJECT],
    );
    await pool.query(
      "INSERT INTO project_host_exam_configs(host_id, token_ciphertext) VALUES ($1, $2)",
      [HOST, enc(`project-host-exam-token:${HOST}`, "exam-token")],
    );
    await pool.query(
      `INSERT INTO project_collab_invites(invite_id, project_id, email_ciphertext, email_hash, token_ciphertext)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        INVITE,
        PROJECT,
        enc("project_collab_invites.email", "alice@example.com"),
        inviteEmailHash(settings1, "alice@example.com"),
        enc("project_collab_invites.token", "invite-token"),
      ],
    );
    await pool.query(
      "INSERT INTO project_secrets(project_id, name, encrypted_value) VALUES ($1, 'API_KEY', $2)",
      [
        PROJECT,
        JSON.stringify(
          encryptProjectSecretValue({
            project_id: PROJECT,
            name: "API_KEY",
            value: "project-secret",
            key: deriveSiteMasterKey(k1, "project-secrets:v1"),
          }),
        ),
      ],
    );
    await pool.query(
      "INSERT INTO project_secrets_runtime_state(project_id, generation) VALUES ($1, 5)",
      [PROJECT],
    );
  }, 30000);

  afterAll(async () => {
    await testCleanup();
  });

  it("reports nothing to do while K1 is the only key", async () => {
    const report = await runMasterKeyMigration();
    expect(report.totals.errors).toBe(0);
    expect(report.totals.to_migrate).toBe(0);
    expect(report.totals.current).toBe(10);
  });

  it("moves every store from a retired key to the new active key", async () => {
    const paths = { secretsDir };
    const { id: id2, key: k2 } = await stageNextSiteMasterKey(paths);
    await activateSiteMasterKey(id2, paths);
    const id1 = siteMasterKeyId(k1);

    const dry = await runMasterKeyMigration();
    expect(dry.active_key_id).toBe(id2);
    expect(dry.keyring).toEqual([
      { id: id2, role: "active" },
      { id: id1, role: "retired" },
    ]);
    expect(dry.totals).toMatchObject({
      errors: 0,
      rotated: 10,
      to_migrate: 10,
    });
    for (const table of dry.tables.filter((t) => t.total > 0)) {
      expect(table.by_key).toEqual({ [id1]: 1 });
    }

    const executed = await runMasterKeyMigration({ execute: true });
    expect(executed.totals.migrated).toBe(10);
    const after = await runMasterKeyMigration();
    expect(after.totals).toMatchObject({
      rotated: 0,
      to_migrate: 0,
      errors: 0,
      current: 10,
    });

    // Everything now decrypts with K2 alone.
    const settings2 = deriveSiteMasterKey(k2, "secret-settings:v1");
    const pool = getPool();
    const one = async (sql: string) => (await pool.query(sql)).rows[0];
    expect(
      decryptSecretSettingValue(
        "stripe_secret_key",
        (
          await one(
            "SELECT value FROM server_settings WHERE name='stripe_secret_key'",
          )
        ).value,
        settings2,
      ),
    ).toBe("sk_live_x");
    const invite = await one(
      "SELECT email_ciphertext, email_hash, token_ciphertext FROM project_collab_invites",
    );
    expect(
      decryptSecretSettingValue(
        "project_collab_invites.email",
        invite.email_ciphertext,
        settings2,
      ),
    ).toBe("alice@example.com");
    expect(invite.email_hash).toBe(
      inviteEmailHash(settings2, "alice@example.com"),
    );
    const secret = await one("SELECT encrypted_value FROM project_secrets");
    expect(
      decryptProjectSecretValue({
        project_id: PROJECT,
        name: "API_KEY",
        encrypted: secret.encrypted_value,
        key: deriveSiteMasterKey(k2, "project-secrets:v1"),
      }),
    ).toBe("project-secret");
    // Hosts re-sync the rewrapped project secrets.
    expect(
      Number(
        (await one("SELECT generation FROM project_secrets_runtime_state"))
          .generation,
      ),
    ).toBe(6);
  });

  it("refuses to execute while any value cannot be decrypted", async () => {
    await getPool().query(
      "INSERT INTO account_second_factors(id, secret_encrypted) VALUES ($1, $2)",
      [
        "13131313-1313-4313-8313-131313131313",
        encryptSecretSettingValue("x", "y", randomBytes(32), "smk_unknown"),
      ],
    );
    const report = await runMasterKeyMigration();
    expect(report.totals.errors).toBe(1);
    await expect(runMasterKeyMigration({ execute: true })).rejects.toThrow(
      "decrypt errors",
    );
  });
});
