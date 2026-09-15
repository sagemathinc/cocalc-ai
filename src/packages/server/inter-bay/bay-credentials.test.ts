/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import getPool, { initEphemeralDatabase } from "@cocalc/database/pool";

import {
  authenticateBayCredential,
  issueBayCredential,
  isBayCredentialUserActive,
  listBayCredentials,
  resetBayCredentialTableForTests,
  revokeBayCredential,
} from "./bay-credentials";

describe("bay credentials", () => {
  beforeAll(async () => {
    process.env.COCALC_CLUSTER_ID = "credential-test-cluster";
    process.env.COCALC_CLUSTER_ROLE = "seed";
    await initEphemeralDatabase();
  });

  beforeEach(async () => {
    await getPool().query("DROP TABLE IF EXISTS cluster_bay_credentials");
    resetBayCredentialTableForTests();
  });

  afterAll(() => {
    delete process.env.COCALC_CLUSTER_ID;
    delete process.env.COCALC_CLUSTER_ROLE;
  });

  it("issues, attributes, rotates, and revokes independent bay secrets", async () => {
    const first = await issueBayCredential({ bay_id: "bay-1" });
    const principal = await authenticateBayCredential(first.credential);
    expect(principal).toEqual({
      hub_id: "bay:bay-1",
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
});
