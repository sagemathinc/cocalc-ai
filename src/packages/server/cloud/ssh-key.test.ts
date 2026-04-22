/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const getServerSettingsMock = jest.fn();

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: () => getServerSettingsMock(),
}));

describe("host owner bay ssh keys", () => {
  const originalEnv = {
    COCALC_BAY_ID: process.env.COCALC_BAY_ID,
    COCALC_HOST_OWNER_SSH_PRIVATE_KEY_PATH:
      process.env.COCALC_HOST_OWNER_SSH_PRIVATE_KEY_PATH,
    COCALC_HOST_OWNER_SSH_PUBLIC_KEY_PATH:
      process.env.COCALC_HOST_OWNER_SSH_PUBLIC_KEY_PATH,
    COCALC_DATA_DIR: process.env.COCALC_DATA_DIR,
    DATA: process.env.DATA,
    SECRETS: process.env.SECRETS,
  };
  let tempDir: string;

  beforeEach(() => {
    jest.resetModules();
    getServerSettingsMock.mockReset();
    tempDir = mkdtempSync(join(tmpdir(), "cocalc-host-owner-ssh-"));
    process.env.COCALC_BAY_ID = "bay-test";
    process.env.COCALC_HOST_OWNER_SSH_PRIVATE_KEY_PATH = join(
      tempDir,
      "id_ed25519",
    );
    process.env.COCALC_HOST_OWNER_SSH_PUBLIC_KEY_PATH = join(
      tempDir,
      "id_ed25519.pub",
    );
    process.env.COCALC_DATA_DIR = tempDir;
    process.env.DATA = tempDir;
    process.env.SECRETS = join(tempDir, "secrets");
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value == null) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("generates a persistent bay-local identity", async () => {
    const { getHostOwnerBaySshIdentity } = await import("./ssh-key");

    const first = await getHostOwnerBaySshIdentity();
    const second = await getHostOwnerBaySshIdentity();

    expect(first.privateKeyPath).toBe(join(tempDir, "id_ed25519"));
    expect(first.publicKey).toMatch(
      /^ssh-ed25519 [^ ]+ cocalc-host-owner-bay:bay-test$/,
    );
    expect(second).toEqual(first);
    expect(existsSync(first.privateKeyPath)).toBe(true);
    expect(existsSync(`${first.privateKeyPath}.pub`)).toBe(true);
  });

  it("prepends the owner bay key to configured project-host ssh keys", async () => {
    getServerSettingsMock.mockResolvedValue({
      project_hosts_ssh_public_keys:
        "ssh-ed25519 AAAAMANUAL admin@test\nssh-ed25519 AAAAMANUAL admin@test",
    });
    const { getHostOwnerBaySshIdentity, getHostSshPublicKeys } =
      await import("./ssh-key");

    const identity = await getHostOwnerBaySshIdentity();
    const keys = await getHostSshPublicKeys();

    expect(keys).toEqual([
      identity.publicKey,
      "ssh-ed25519 AAAAMANUAL admin@test",
    ]);
  });
});
