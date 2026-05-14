/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { PROJECT_SECRETS_MOUNT_PATH } from "@cocalc/util/project-secrets";

const ensureVolume = jest.fn();

jest.mock("./file-server", () => ({
  ensureVolume: (...args: any[]) => ensureVolume(...args),
}));

describe("setupProjectSecretSshKey", () => {
  let root: string;
  const project_id = "5cfca79c-072f-4998-8f5c-3b2d5950da0b";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cocalc-project-ssh-key-test-"));
    ensureVolume.mockReset();
    ensureVolume.mockResolvedValue({ path: root });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes only the public key and private-key symlink", async () => {
    const { setupProjectSecretSshKey } =
      await import("./project-secret-ssh-key");

    const result = await setupProjectSecretSshKey({
      project_id,
      secret_name: "SSH_PRIVATE_KEY",
      public_key: "ssh-ed25519 AAAATEST cocalc-project:test",
    });

    expect(result).toEqual({
      private_key_path: ".ssh/id_ed25519",
      public_key_path: ".ssh/id_ed25519.pub",
      symlink_target: `${PROJECT_SECRETS_MOUNT_PATH}/SSH_PRIVATE_KEY`,
    });
    await expect(
      readFile(join(root, ".ssh/id_ed25519.pub"), "utf8"),
    ).resolves.toBe("ssh-ed25519 AAAATEST cocalc-project:test\n");
    await expect(readlink(join(root, ".ssh/id_ed25519"))).resolves.toBe(
      `${PROJECT_SECRETS_MOUNT_PATH}/SSH_PRIVATE_KEY`,
    );
  });

  it("preflights without writing project files", async () => {
    const { setupProjectSecretSshKey } =
      await import("./project-secret-ssh-key");

    await expect(
      setupProjectSecretSshKey({
        project_id,
        secret_name: "SSH_PRIVATE_KEY",
        check_only: true,
      }),
    ).resolves.toEqual({
      private_key_path: ".ssh/id_ed25519",
      public_key_path: ".ssh/id_ed25519.pub",
      symlink_target: `${PROJECT_SECRETS_MOUNT_PATH}/SSH_PRIVATE_KEY`,
    });
    await expect(
      readFile(join(root, ".ssh/id_ed25519.pub"), "utf8"),
    ).rejects.toThrow();
  });

  it("refuses to write when the default private key already exists", async () => {
    await mkdir(join(root, ".ssh"));
    await writeFile(join(root, ".ssh/id_ed25519"), "existing");
    const { setupProjectSecretSshKey } =
      await import("./project-secret-ssh-key");

    await expect(
      setupProjectSecretSshKey({
        project_id,
        secret_name: "SSH_PRIVATE_KEY",
        public_key: "ssh-ed25519 AAAATEST cocalc-project:test",
      }),
    ).rejects.toThrow(".ssh/id_ed25519 already exists");
  });

  it("refuses to follow a project .ssh symlink", async () => {
    await writeFile(join(root, ".ssh-placeholder"), "");
    await symlink(".ssh-placeholder", join(root, ".ssh"));
    const { setupProjectSecretSshKey } =
      await import("./project-secret-ssh-key");

    await expect(
      setupProjectSecretSshKey({
        project_id,
        secret_name: "SSH_PRIVATE_KEY",
        public_key: "ssh-ed25519 AAAATEST cocalc-project:test",
      }),
    ).rejects.toThrow(".ssh exists but is not a directory");
  });
});
