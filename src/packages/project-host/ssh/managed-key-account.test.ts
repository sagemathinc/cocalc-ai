/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { requireManagedSshKeyAccount } from "./managed-key-account";

describe("managed ssh key account resolution", () => {
  it("returns the resolved account id", async () => {
    await expect(
      requireManagedSshKeyAccount({
        project_id: "project-id",
        fingerprint: "SHA256:test",
        resolveAccount: async () => ({ account_id: "account-id" }),
      }),
    ).resolves.toBe("account-id");
  });

  it("rejects stale or banned managed keys that no longer resolve", async () => {
    await expect(
      requireManagedSshKeyAccount({
        project_id: "project-id",
        fingerprint: "SHA256:test",
        resolveAccount: async () => ({}),
      }),
    ).rejects.toThrow("managed ssh key is no longer authorized");
  });
});
