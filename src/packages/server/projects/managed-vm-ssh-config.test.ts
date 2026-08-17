/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { readManagedVmProjectSshPublicKey } from "./managed-vm-ssh-config";

describe("readManagedVmProjectSshPublicKey", () => {
  it("uses the dedicated project RPC when available", async () => {
    const readTextFileFromProject = jest.fn();
    await expect(
      readManagedVmProjectSshPublicKey({
        managedVmSshPublicKey: async () => "ssh-ed25519 dedicated",
        readTextFileFromProject,
      }),
    ).resolves.toBe("ssh-ed25519 dedicated");
    expect(readTextFileFromProject).not.toHaveBeenCalled();
  });

  it("falls back to the generic file RPC for an older project bundle", async () => {
    await expect(
      readManagedVmProjectSshPublicKey({
        managedVmSshPublicKey: async () => {
          throw new Error(
            "unknown function 'system.managedVmSshPublicKey' -- available functions are []",
          );
        },
        readTextFileFromProject: async () => "ssh-ed25519 legacy\n",
      }),
    ).resolves.toBe("ssh-ed25519 legacy");
  });

  it("returns null when an older project has no deploy key", async () => {
    await expect(
      readManagedVmProjectSshPublicKey({
        managedVmSshPublicKey: async () => {
          throw new Error("unknown function 'managedVmSshPublicKey'");
        },
        readTextFileFromProject: async () => {
          const err = new Error("ENOENT: no such file or directory");
          Object.assign(err, { code: "ENOENT" });
          throw err;
        },
      }),
    ).resolves.toBeNull();
  });

  it("does not hide failures from the dedicated project RPC", async () => {
    const error = new Error("project host is unavailable");
    await expect(
      readManagedVmProjectSshPublicKey({
        managedVmSshPublicKey: async () => {
          throw error;
        },
        readTextFileFromProject: async () => "ssh-ed25519 legacy",
      }),
    ).rejects.toBe(error);
  });

  it("rejects malformed keys returned by the compatibility RPC", async () => {
    await expect(
      readManagedVmProjectSshPublicKey({
        managedVmSshPublicKey: async () => {
          throw new Error("unknown function 'managedVmSshPublicKey'");
        },
        readTextFileFromProject: async () =>
          "ssh-ed25519 first\nssh-ed25519 second",
      }),
    ).rejects.toThrow("project deploy public key is invalid");
  });
});
