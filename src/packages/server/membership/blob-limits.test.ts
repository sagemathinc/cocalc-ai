/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let centralLogMock: jest.Mock;
let resolveMembershipForAccountMock: jest.Mock;
let getProjectUsageAccountIdMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/database/postgres/central-log", () => ({
  __esModule: true,
  default: (...args: any[]) => centralLogMock(...args),
}));

jest.mock("./resolve", () => ({
  __esModule: true,
  resolveMembershipForAccount: (...args: any[]) =>
    resolveMembershipForAccountMock(...args),
}));

jest.mock("./project-usage", () => ({
  __esModule: true,
  getProjectUsageAccountId: (...args: any[]) =>
    getProjectUsageAccountIdMock(...args),
}));

describe("blob membership limits", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const projectUsageAccountId = "22222222-2222-4222-8222-222222222222";
  const project_id = "33333333-3333-4333-8333-333333333333";
  const uuid = "44444444-4444-4444-8444-444444444444";
  let existingBlob = false;
  let accountUsage = { count: 0, total_bytes: 0 };
  let projectUsage = { count: 0, total_bytes: 0 };

  beforeEach(() => {
    jest.resetModules();
    existingBlob = false;
    accountUsage = { count: 0, total_bytes: 0 };
    projectUsage = { count: 0, total_bytes: 0 };
    centralLogMock = jest.fn(async () => undefined);
    resolveMembershipForAccountMock = jest.fn(async (id: string) => ({
      class: "free",
      source: "free",
      entitlements: {},
      effective_limits: {
        blob_account_total_bytes: id === account_id ? 100 : 1_000,
        blob_account_count: 2,
        blob_project_total_bytes: 200,
        blob_project_count: 2,
      },
    }));
    getProjectUsageAccountIdMock = jest.fn(async () => projectUsageAccountId);
    queryMock = jest.fn(async (sql: string) => {
      if (sql.includes("SELECT 1 FROM blobs")) {
        return { rows: existingBlob ? [{ "?column?": 1 }] : [] };
      }
      if (sql.includes("account_id=$1::uuid")) {
        return { rows: [accountUsage] };
      }
      if (sql.includes("project_id=$1")) {
        return { rows: [projectUsage] };
      }
      throw Error(`unexpected query: ${sql}`);
    });
  });

  it("allows a new blob within account and project limits", async () => {
    accountUsage = { count: 1, total_bytes: 40 };
    projectUsage = { count: 1, total_bytes: 150 };
    const { assertCanSaveBlobForAccount } = await import("./blob-limits");
    await expect(
      assertCanSaveBlobForAccount({
        account_id,
        project_id,
        uuid,
        blobSize: 50,
      }),
    ).resolves.toBeUndefined();
  });

  it("blocks when account blob byte quota would be exceeded", async () => {
    accountUsage = { count: 1, total_bytes: 90 };
    const { assertCanSaveBlobForAccount } = await import("./blob-limits");
    await expect(
      assertCanSaveBlobForAccount({
        account_id,
        uuid,
        blobSize: 20,
      }),
    ).rejects.toThrow("blob_account_total_bytes");
    expect(centralLogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "blob_quota_denied",
        value: expect.objectContaining({
          account_id,
          limit: "blob_account_total_bytes",
        }),
      }),
    );
  });

  it("blocks when project blob count quota would be exceeded", async () => {
    accountUsage = { count: 0, total_bytes: 0 };
    projectUsage = { count: 2, total_bytes: 10 };
    const { assertCanSaveBlobForAccount } = await import("./blob-limits");
    await expect(
      assertCanSaveBlobForAccount({
        account_id,
        project_id,
        uuid,
        blobSize: 20,
      }),
    ).rejects.toThrow("blob_project_count");
    expect(resolveMembershipForAccountMock).toHaveBeenCalledWith(
      projectUsageAccountId,
    );
  });

  it("does not charge quota again for an already stored blob", async () => {
    existingBlob = true;
    const { assertCanSaveBlobForAccount } = await import("./blob-limits");
    await expect(
      assertCanSaveBlobForAccount({
        account_id,
        project_id,
        uuid,
        blobSize: 1_000_000,
      }),
    ).resolves.toBeUndefined();
    expect(resolveMembershipForAccountMock).not.toHaveBeenCalled();
  });
});
