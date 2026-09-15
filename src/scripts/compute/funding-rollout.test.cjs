/* CoCalc: Copyright (c) 2026 Sagemath, Inc. License: MS-RSL. */
const assert = require("node:assert/strict");
const { generateKeyPairSync } = require("node:crypto");
const {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  statSync,
  rmSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");
const {
  FUNDING_ACCOUNT_WRITER_ROLES,
  FUNDING_RESOURCE_WRITER_ROLES,
} = require("../../packages/server/dist/compute/funding/production-rollout-contract");

test("operator signs and verifies a bounded manifest without overwriting or accepting tampering", () => {
  const dir = mkdtempSync(join(tmpdir(), "funding-rollout-"));
  const file = (name) => join(dir, name);
  const cli = (...args) =>
    spawnSync(
      process.execPath,
      [join(__dirname, "funding-rollout.cjs"), ...args],
      {
        encoding: "utf8",
        timeout: 20_000,
      },
    );
  try {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    writeFileSync(
      file("private.pem"),
      privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    writeFileSync(
      file("public.pem"),
      publicKey.export({ type: "spki", format: "pem" }),
    );
    const now = Date.now();
    const manifest = {
      kind: "cocalc-funding-rollout",
      version: 1,
      deployment_id: "offline-test",
      rollout_id: "rollout",
      seed_bay_id: "home",
      issued_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 600_000).toISOString(),
      exposure_allocation: {
        id: "quota",
        site_ceiling_usd: "10",
        bay_quotas: [{ bay_id: "home", amount_usd: "10" }],
      },
      bays: [
        {
          bay_id: "home",
          namespace: "abcdef0123456789",
          database: {
            name: "smc",
            system_identifier: "123456",
            writer_roles: ["hub"],
            operator_roles: ["operator"],
            retired_roles: [],
          },
          writers: [
            {
              id: "hub-1",
              build_id: "build-1",
              protocol_version: 1,
              database_role: "hub",
              roles: [
                ...FUNDING_ACCOUNT_WRITER_ROLES,
                ...FUNDING_RESOURCE_WRITER_ROLES,
              ],
            },
          ],
          resource_credentials: [],
          retired_resource_credentials: [],
          credential_rollout: {
            epoch: "new",
            mode: "bootstrap",
            completed_at: new Date(now - 2000).toISOString(),
            evidence_id: "test-census",
          },
        },
      ],
    };
    writeFileSync(file("unsigned.json"), JSON.stringify(manifest));
    const args = [
      "sign",
      "--manifest",
      file("unsigned.json"),
      "--private-key",
      file("private.pem"),
      "--output",
      file("signed.json"),
    ];
    const signed = cli(...args);
    assert.equal(signed.status, 0, signed.stderr);
    const report = JSON.parse(signed.stdout);
    assert.equal(report.validation, "offline-signature-and-contract-only");
    assert.match(report.exposure_allocation_sha256, /^[a-f0-9]{64}$/);
    assert.equal(statSync(file("signed.json")).mode & 0o777, 0o600);
    const before = readFileSync(file("signed.json"), "utf8");
    assert.notEqual(cli(...args).status, 0);
    assert.equal(readFileSync(file("signed.json"), "utf8"), before);
    const verify = [
      "verify",
      "--manifest",
      file("signed.json"),
      "--public-key",
      file("public.pem"),
    ];
    const verified = cli(...verify);
    assert.equal(verified.status, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout), report);
    const changed = JSON.parse(before);
    changed.manifest.deployment_id = "different";
    writeFileSync(file("signed.json"), JSON.stringify(changed));
    const rejected = cli(...verify);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stderr, /signature is invalid/);
    assert.equal(rejected.stdout, "");
    manifest.expires_at = new Date(now - 1).toISOString();
    writeFileSync(file("unsigned.json"), JSON.stringify(manifest));
    assert.match(cli(...args).stderr, /expired/);
    assert.match(
      cli("verify", "--manifest", file("signed.json")).stderr,
      /Invalid arguments/,
    );
    assert.equal(cli("--help").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
