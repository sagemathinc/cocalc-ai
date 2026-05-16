/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();
const ensureLroSchemaMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
  })),
}));

jest.mock("@cocalc/server/lro/lro-db", () => ({
  ensureLroSchema: (...args: any[]) => ensureLroSchemaMock(...args),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const PROJECT_ID = "22222222-2222-4222-8222-222222222222";

function counts({
  account_inflight = 0,
  account_recent = 0,
  global_inflight = 0,
  same_project_active = 0,
}: Partial<{
  account_inflight: number;
  account_recent: number;
  global_inflight: number;
  same_project_active: number;
}> = {}) {
  return {
    rows: [
      {
        account_inflight,
        account_recent,
        global_inflight,
        same_project_active,
      },
    ],
  };
}

describe("hard-delete admission", () => {
  beforeEach(() => {
    queryMock.mockReset();
    ensureLroSchemaMock.mockReset();
    ensureLroSchemaMock.mockResolvedValue(undefined);
  });

  it("allows a delete below admission limits", async () => {
    queryMock.mockResolvedValueOnce(counts());

    const { assertProjectHardDeleteAdmission } =
      await import("./hard-delete-admission");
    await expect(
      assertProjectHardDeleteAdmission({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        limits: {
          account_inflight: 2,
          account_recent: 10,
          account_recent_window_seconds: 60 * 60,
          global_inflight: 100,
        },
      }),
    ).resolves.toMatchObject({
      account_inflight: 0,
      account_recent: 0,
      global_inflight: 0,
      same_project_active: 0,
    });
    expect(ensureLroSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("allows repeated admission for an already-active delete on the same project", async () => {
    queryMock.mockResolvedValueOnce(
      counts({
        account_inflight: 2,
        account_recent: 10,
        global_inflight: 100,
        same_project_active: 1,
      }),
    );

    const { assertProjectHardDeleteAdmission } =
      await import("./hard-delete-admission");
    await expect(
      assertProjectHardDeleteAdmission({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        limits: {
          account_inflight: 2,
          account_recent: 10,
          account_recent_window_seconds: 60 * 60,
          global_inflight: 100,
        },
      }),
    ).resolves.toMatchObject({ same_project_active: 1 });
  });

  it.each([
    [
      "account_inflight",
      counts({ account_inflight: 2 }),
      "project_delete_rate_limited_account_inflight",
    ],
    [
      "account_recent",
      counts({ account_recent: 10 }),
      "project_delete_rate_limited_account_recent",
    ],
    [
      "global_inflight",
      counts({ global_inflight: 100 }),
      "project_delete_rate_limited_global_inflight",
    ],
  ])("rejects when %s reaches its limit", async (_name, result, code) => {
    queryMock.mockResolvedValueOnce(result);

    const { assertProjectHardDeleteAdmission } =
      await import("./hard-delete-admission");
    await expect(
      assertProjectHardDeleteAdmission({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        limits: {
          account_inflight: 2,
          account_recent: 10,
          account_recent_window_seconds: 60 * 60,
          global_inflight: 100,
        },
      }),
    ).rejects.toMatchObject({ code });
  });
});
