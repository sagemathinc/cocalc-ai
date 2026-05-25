/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const getClusterAccountByIdDirectMock = jest.fn();
const getClusterAccountByEmailDirectMock = jest.fn();
const getClusterBanEquivalentEmailAccountsDirectMock = jest.fn();
const reserveClusterAccountDirectoryEntryMock = jest.fn();
const updateClusterAccountBannedDirectMock = jest.fn();
const banUserMock = jest.fn();
const removeUserBanMock = jest.fn();
const recordAccountBanAuditEventMock = jest.fn();
const remoteSetBanMock = jest.fn();
const assertSignupEmailDomainAllowedMock = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-1"),
}));

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: jest.fn(() => "seed"),
  isMultiBayCluster: jest.fn(() => true),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: jest.fn(() => ({})),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  createInterBayAccountDirectoryClient: jest.fn(() => ({
    getBanEquivalentEmailAccounts: (...args: any[]) =>
      getClusterBanEquivalentEmailAccountsDirectMock(...args),
    updateBanned: (...args: any[]) =>
      updateClusterAccountBannedDirectMock(...args),
  })),
  createInterBayAccountLocalClient: jest.fn(() => ({
    setBan: (...args: any[]) => remoteSetBanMock(...args),
  })),
}));

jest.mock("@cocalc/server/accounts/cluster-directory", () => ({
  canonicalEmailForBanEquivalence: (email: string | undefined) =>
    email ? "codex@gmail.com" : undefined,
  deleteClusterAccountDirectoryEntry: jest.fn(),
  getClusterAccountByEmailDirect: (...args: any[]) =>
    getClusterAccountByEmailDirectMock(...args),
  getClusterAccountByIdDirect: (...args: any[]) =>
    getClusterAccountByIdDirectMock(...args),
  getClusterBanEquivalentEmailAccountsDirect: (...args: any[]) =>
    getClusterBanEquivalentEmailAccountsDirectMock(...args),
  markClusterAccountProvisioned: jest.fn(),
  reserveClusterAccountDirectoryEntry: (...args: any[]) =>
    reserveClusterAccountDirectoryEntryMock(...args),
  updateClusterAccountBannedDirect: (...args: any[]) =>
    updateClusterAccountBannedDirectMock(...args),
}));

jest.mock("@cocalc/server/accounts/ban", () => ({
  banUser: (...args: any[]) => banUserMock(...args),
  removeUserBan: (...args: any[]) => removeUserBanMock(...args),
}));

jest.mock("@cocalc/server/accounts/ban-audit", () => ({
  recordAccountBanAuditEvent: (...args: any[]) =>
    recordAccountBanAuditEventMock(...args),
}));

jest.mock("@cocalc/server/accounts/signup-email-domain-policy", () => ({
  assertSignupEmailDomainAllowed: (...args: any[]) =>
    assertSignupEmailDomainAllowedMock(...args),
}));

describe("inter-bay account ban routing", () => {
  beforeEach(() => {
    jest.resetModules();
    getClusterAccountByIdDirectMock.mockReset();
    getClusterAccountByEmailDirectMock.mockReset().mockResolvedValue(null);
    getClusterBanEquivalentEmailAccountsDirectMock
      .mockReset()
      .mockResolvedValue([]);
    reserveClusterAccountDirectoryEntryMock.mockReset().mockResolvedValue(null);
    updateClusterAccountBannedDirectMock.mockReset().mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
      banned: true,
    });
    banUserMock.mockReset().mockResolvedValue(undefined);
    removeUserBanMock.mockReset().mockResolvedValue(undefined);
    recordAccountBanAuditEventMock.mockReset().mockResolvedValue(undefined);
    remoteSetBanMock.mockReset().mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-2",
      banned: true,
    });
    assertSignupEmailDomainAllowedMock.mockReset().mockResolvedValue(undefined);
  });

  it("applies local bans on the account home bay and syncs the directory", async () => {
    getClusterAccountByIdDirectMock.mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
    });

    const { setClusterAccountBan } = await import("./accounts");
    await expect(
      setClusterAccountBan({
        account_id: "00000000-0000-4000-8000-000000000001",
        banned: true,
      }),
    ).resolves.toMatchObject({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
      banned: true,
    });

    expect(banUserMock).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(remoteSetBanMock).not.toHaveBeenCalled();
    expect(updateClusterAccountBannedDirectMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });
  });

  it("routes bans to a remote account home bay before syncing the directory", async () => {
    getClusterAccountByIdDirectMock.mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-2",
    });

    const { setClusterAccountBan } = await import("./accounts");
    await setClusterAccountBan({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });

    expect(remoteSetBanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: "00000000-0000-4000-8000-000000000001",
        banned: true,
      }),
    );
    expect(banUserMock).not.toHaveBeenCalled();
    expect(updateClusterAccountBannedDirectMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });
  });

  it("records local ban audit events with admin reason", async () => {
    getClusterAccountByIdDirectMock.mockResolvedValue({
      account_id: "00000000-0000-4000-8000-000000000001",
      home_bay_id: "bay-1",
    });

    const { setClusterAccountBan } = await import("./accounts");
    await setClusterAccountBan({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
      actor_account_id: "00000000-0000-4000-8000-000000000099",
      reason: "spam campaign",
    });

    expect(recordAccountBanAuditEventMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      action: "ban",
      actor_account_id: "00000000-0000-4000-8000-000000000099",
      reason: "spam campaign",
      metadata: undefined,
    });
    expect(updateClusterAccountBannedDirectMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000001",
      banned: true,
    });
  });

  it("blocks new or changed Gmail-equivalent identities when an equivalent account is banned", async () => {
    getClusterBanEquivalentEmailAccountsDirectMock.mockResolvedValue([
      {
        account_id: "00000000-0000-4000-8000-000000000001",
        email_address: "codex+abuse@gmail.com",
        home_bay_id: "bay-1",
        banned: true,
      },
    ]);

    const { assertNoClusterBannedEquivalentEmailAccount } =
      await import("./accounts");
    await expect(
      assertNoClusterBannedEquivalentEmailAccount({
        email_address: "cod.ex+new@googlemail.com",
      }),
    ).rejects.toThrow(/equivalent address is banned/);
    expect(getClusterBanEquivalentEmailAccountsDirectMock).toHaveBeenCalledWith(
      {
        email_address: "cod.ex+new@googlemail.com",
        limit: undefined,
      },
    );
  });

  it("rejects account creation before reserving a banned-equivalent email", async () => {
    getClusterBanEquivalentEmailAccountsDirectMock.mockResolvedValue([
      {
        account_id: "00000000-0000-4000-8000-000000000001",
        email_address: "codex@gmail.com",
        home_bay_id: "bay-1",
        banned: true,
      },
    ]);

    const { createClusterAccount } = await import("./accounts");
    await expect(
      createClusterAccount({
        email_address: "cod.ex+new@gmail.com",
        password: "secret",
        first_name: "Code",
        last_name: "Ex",
      } as any),
    ).rejects.toThrow(/equivalent address is banned/);

    expect(reserveClusterAccountDirectoryEntryMock).not.toHaveBeenCalled();
  });

  it("rejects account creation before reserving a disallowed email domain", async () => {
    assertSignupEmailDomainAllowedMock.mockRejectedValueOnce(
      new Error("Use an approved email address to create an account."),
    );

    const { createClusterAccount } = await import("./accounts");
    await expect(
      createClusterAccount({
        email_address: "codex@other.edu",
        password: "secret",
        first_name: "Code",
        last_name: "Ex",
      } as any),
    ).rejects.toThrow(/approved email address/);

    expect(assertSignupEmailDomainAllowedMock).toHaveBeenCalledWith({
      email_address: "codex@other.edu",
    });
    expect(
      getClusterBanEquivalentEmailAccountsDirectMock,
    ).not.toHaveBeenCalled();
    expect(reserveClusterAccountDirectoryEntryMock).not.toHaveBeenCalled();
  });

  it("allows the currently edited account to keep its own banned-equivalent email", async () => {
    getClusterBanEquivalentEmailAccountsDirectMock.mockResolvedValue([
      {
        account_id: "00000000-0000-4000-8000-000000000001",
        email_address: "codex+abuse@gmail.com",
        home_bay_id: "bay-1",
        banned: true,
      },
    ]);

    const { assertNoClusterBannedEquivalentEmailAccount } =
      await import("./accounts");
    await expect(
      assertNoClusterBannedEquivalentEmailAccount({
        email_address: "cod.ex+abuse@googlemail.com",
        allowed_account_id: "00000000-0000-4000-8000-000000000001",
      }),
    ).resolves.toBeUndefined();
  });

  it("bans Gmail-equivalent accounts as one admin action", async () => {
    getClusterAccountByIdDirectMock.mockImplementation(async (account_id) => ({
      account_id,
      email_address:
        account_id === "00000000-0000-4000-8000-000000000001"
          ? "codex@gmail.com"
          : "codex+abuse@gmail.com",
      home_bay_id: "bay-1",
    }));
    getClusterBanEquivalentEmailAccountsDirectMock.mockResolvedValue([
      {
        account_id: "00000000-0000-4000-8000-000000000001",
        email_address: "codex@gmail.com",
        home_bay_id: "bay-1",
      },
      {
        account_id: "00000000-0000-4000-8000-000000000002",
        email_address: "codex+abuse@gmail.com",
        home_bay_id: "bay-1",
      },
    ]);

    const { banClusterAccountAndEquivalentEmails } = await import("./accounts");
    await banClusterAccountAndEquivalentEmails({
      account_id: "00000000-0000-4000-8000-000000000001",
    });

    expect(getClusterBanEquivalentEmailAccountsDirectMock).toHaveBeenCalledWith(
      {
        email_address: "codex@gmail.com",
        limit: undefined,
      },
    );
    expect(banUserMock).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000001",
    );
    expect(banUserMock).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000002",
    );
    expect(updateClusterAccountBannedDirectMock).toHaveBeenCalledWith({
      account_id: "00000000-0000-4000-8000-000000000002",
      banned: true,
    });
  });
});
