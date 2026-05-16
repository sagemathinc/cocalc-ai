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
  account_queued = 0,
  account_running = 0,
  account_recent = 0,
  global_inflight = 0,
  global_queued = 0,
  global_running = 0,
  same_project_active = 0,
}: Partial<{
  account_inflight: number;
  account_queued: number;
  account_running: number;
  account_recent: number;
  global_inflight: number;
  global_queued: number;
  global_running: number;
  same_project_active: number;
}> = {}) {
  return {
    rows: [
      {
        account_inflight,
        account_queued,
        account_running,
        account_recent,
        global_inflight,
        global_queued,
        global_running,
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
    delete process.env.COCALC_PROJECT_HARD_DELETE_ACCOUNT_INFLIGHT_LIMIT;
    delete process.env.COCALC_PROJECT_HARD_DELETE_ACCOUNT_RECENT_LIMIT;
    delete process.env.COCALC_PROJECT_HARD_DELETE_ACCOUNT_RECENT_WINDOW_SECONDS;
    delete process.env.COCALC_PROJECT_HARD_DELETE_GLOBAL_INFLIGHT_LIMIT;
  });

  it("uses defaults when hard-delete limit env vars are unset or blank", async () => {
    process.env.COCALC_PROJECT_HARD_DELETE_ACCOUNT_INFLIGHT_LIMIT = "";

    const { getProjectHardDeleteAdmissionLimits } =
      await import("./hard-delete-admission");
    expect(getProjectHardDeleteAdmissionLimits()).toMatchObject({
      account_inflight: 2,
      account_recent: 10,
      account_recent_window_seconds: 60 * 60,
      global_inflight: 100,
    });
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
      account_queued: 0,
      account_running: 0,
      account_recent: 0,
      global_inflight: 0,
      global_queued: 0,
      global_running: 0,
      same_project_active: 0,
    });
    expect(ensureLroSchemaMock).toHaveBeenCalledTimes(1);
  });

  it("does not count expired or stale-running LROs as active inflight work", async () => {
    queryMock.mockResolvedValueOnce(counts());

    const { getProjectHardDeleteAdmissionCounts } =
      await import("./hard-delete-admission");
    await getProjectHardDeleteAdmissionCounts({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
      recent_window_seconds: 60 * 60,
    });

    const [sql, params] = queryMock.mock.calls[0];
    expect(`${sql}`).toContain("expires_at > now()");
    expect(`${sql}`).toContain("heartbeat_at IS NOT NULL");
    expect(`${sql}`).toContain("heartbeat_at >=");
    expect(params).toContain(120_000);
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

  it("treats zero limits as disabled rather than deny-all", async () => {
    queryMock.mockResolvedValueOnce(
      counts({
        account_inflight: 10,
        account_recent: 20,
        global_inflight: 30,
      }),
    );

    const { assertProjectHardDeleteAdmission } =
      await import("./hard-delete-admission");
    await expect(
      assertProjectHardDeleteAdmission({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        limits: {
          account_inflight: 0,
          account_recent: 0,
          account_recent_window_seconds: 60 * 60,
          global_inflight: 0,
        },
      }),
    ).resolves.toMatchObject({
      account_inflight: 10,
      account_recent: 20,
      global_inflight: 30,
    });
  });

  it.each([
    [
      "account_inflight",
      counts({ account_inflight: 2, account_queued: 2 }),
      "project_delete_rate_limited_account_inflight",
      "queued=2, running=0, total=2, limit=2",
    ],
    [
      "account_recent",
      counts({ account_recent: 10 }),
      "project_delete_rate_limited_account_recent",
      "recent=10, limit=10, window_seconds=3600",
    ],
    [
      "global_inflight",
      counts({ global_inflight: 100, global_queued: 99, global_running: 1 }),
      "project_delete_rate_limited_global_inflight",
      "queued=99, running=1, total=100, limit=100",
    ],
  ])(
    "rejects when %s reaches its limit",
    async (_name, result, code, messagePart) => {
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
      ).rejects.toMatchObject({
        code,
        message: expect.stringContaining(messagePart),
      });
    },
  );
});
