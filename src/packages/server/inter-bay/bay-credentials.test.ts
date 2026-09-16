/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  authenticateBayCredential,
  issueBayCredential,
  isBayCredentialUserActive,
  ensureLocalSeedBayCredential,
  listBayCredentials,
  resetBayCredentialTableForTests,
  revokeBayCredential,
} from "./bay-credentials";

describe("bay credentials", () => {
  beforeAll(async () => {
    process.env.COCALC_CLUSTER_ID = "credential-test-cluster";
    process.env.COCALC_CLUSTER_ROLE = "seed";
    process.env.COCALC_BAY_ID = "bay-0";
    await initEphemeralDatabase();
  });

  beforeEach(async () => {
    await getPool().query("DROP TABLE IF EXISTS cluster_bay_credentials");
    resetBayCredentialTableForTests();
    delete process.env.COCALC_BAY_CREDENTIAL_FILE;
    delete process.env.COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE;
  });

  afterAll(() => {
    delete process.env.COCALC_CLUSTER_ID;
    delete process.env.COCALC_CLUSTER_ROLE;
    delete process.env.COCALC_BAY_ID;
    delete process.env.COCALC_BAY_CREDENTIAL_FILE;
    delete process.env.COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE;
  });

  it("issues, attributes, rotates, and revokes independent bay secrets", async () => {
    const first = await issueBayCredential({ bay_id: "bay-1" });
    const principal = await authenticateBayCredential(first.credential);
    expect(principal).toEqual({
      hub_id: "bay:bay-1",
      cluster_id: "credential-test-cluster",
      bay_id: "bay-1",
      bay_credential_id: first.credential_id,
    });
    expect(await isBayCredentialUserActive(principal)).toBe(true);

    const replacement = await issueBayCredential({
      bay_id: "bay-1",
      replaces_credential_id: first.credential_id,
    });
    expect(await listBayCredentials({ bay_id: "bay-1" })).toHaveLength(2);
    expect(
      await authenticateBayCredential(replacement.credential),
    ).toMatchObject({
      bay_id: "bay-1",
      bay_credential_id: replacement.credential_id,
    });

    await revokeBayCredential({ credential_id: first.credential_id });
    await expect(authenticateBayCredential(first.credential)).rejects.toThrow(
      "invalid or revoked",
    );
    expect(await isBayCredentialUserActive(principal)).toBe(false);
    expect(
      await isBayCredentialUserActive(
        await authenticateBayCredential(replacement.credential),
      ),
    ).toBe(true);
  });

  it("does not authenticate a changed secret", async () => {
    const issued = await issueBayCredential({ bay_id: "bay-2" });
    await expect(
      authenticateBayCredential(`${issued.credential.slice(0, -1)}x`),
    ).rejects.toThrow("invalid or revoked");
  });

  it("does not consult the seed registry from an attached bay", async () => {
    const issued = await issueBayCredential({ bay_id: "bay-2" });
    process.env.COCALC_CLUSTER_ROLE = "attached";
    await expect(authenticateBayCredential(issued.credential)).rejects.toThrow(
      "only available on the seed bay",
    );
    process.env.COCALC_CLUSTER_ROLE = "seed";
  });

  async function writeBootstrap({
    credential_id = randomUUID(),
    secret = randomBytes(32).toString("base64url"),
    bay_id = "bay-0",
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "bay-credential-test-"));
    const credentialFile = join(dir, "credential");
    const bootstrapFile = join(dir, "bootstrap.json");
    await writeFile(
      credentialFile,
      `cocalc-bay-v1.${credential_id}.${secret}\n`,
      { mode: 0o600 },
    );
    await writeFile(
      bootstrapFile,
      JSON.stringify([
        {
          credential_id,
          cluster_id: "credential-test-cluster",
          bay_id,
          secret_digest: createHash("sha256").update(secret).digest("hex"),
        },
      ]),
      { mode: 0o600 },
    );
    process.env.COCALC_BAY_CREDENTIAL_FILE = credentialFile;
    process.env.COCALC_BAY_CREDENTIAL_BOOTSTRAP_FILE = bootstrapFile;
    return { credential_id, secret, bay_id, bootstrapFile };
  }

  it("imports a bootstrap once and consumes the manifest", async () => {
    const { bootstrapFile } = await writeBootstrap();
    await ensureLocalSeedBayCredential();
    await expect(readFile(bootstrapFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(`${bootstrapFile}.complete`, "utf8")).toMatch(
      /^[0-9a-f]{64}\n$/,
    );
  });

  it("enrolls a newly delivered manifest without restarting", async () => {
    const first = await writeBootstrap();
    await ensureLocalSeedBayCredential();
    const credential_id = randomUUID();
    const secret = randomBytes(32).toString("base64url");
    await writeFile(
      first.bootstrapFile,
      JSON.stringify([
        {
          credential_id,
          cluster_id: "credential-test-cluster",
          bay_id: "bay-1",
          secret_digest: createHash("sha256").update(secret).digest("hex"),
        },
      ]),
      { mode: 0o600 },
    );
    let principal;
    for (let i = 0; i < 30; i++) {
      try {
        principal = await authenticateBayCredential(
          `cocalc-bay-v1.${credential_id}.${secret}`,
        );
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    expect(principal).toMatchObject({
      bay_id: "bay-1",
      bay_credential_id: credential_id,
    });
  });

  it("rejects a bootstrap id bound to another identity", async () => {
    const first = await writeBootstrap();
    await ensureLocalSeedBayCredential();
    resetBayCredentialTableForTests();
    await writeBootstrap({
      credential_id: first.credential_id,
      secret: first.secret,
      bay_id: "bay-1",
    });
    await expect(ensureLocalSeedBayCredential()).rejects.toThrow(
      "conflicts with registry",
    );
  });

  it("does not resurrect a revoked bootstrap credential", async () => {
    const first = await writeBootstrap();
    await ensureLocalSeedBayCredential();
    await revokeBayCredential({ credential_id: first.credential_id });
    resetBayCredentialTableForTests();
    await writeFile(
      first.bootstrapFile,
      JSON.stringify([
        {
          credential_id: first.credential_id,
          cluster_id: "credential-test-cluster",
          bay_id: first.bay_id,
          secret_digest: createHash("sha256")
            .update(first.secret)
            .digest("hex"),
        },
      ]),
    );
    await expect(ensureLocalSeedBayCredential()).rejects.toThrow(
      "conflicts with registry",
    );
  });

  it("does not self-enroll from a raw credential after registry loss", async () => {
    const first = await writeBootstrap();
    await ensureLocalSeedBayCredential();
    resetBayCredentialTableForTests();
    await getPool().query("DROP TABLE cluster_bay_credentials");
    await expect(ensureLocalSeedBayCredential()).rejects.toThrow(
      "invalid or revoked bay credential",
    );
    await expect(readFile(first.bootstrapFile, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
