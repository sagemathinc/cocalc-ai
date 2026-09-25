/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

const queryMock = jest.fn();
const resolveAccountHomeBayMock = jest.fn();
const getConfiguredBayIdMock = jest.fn(() => "bay-local");
const getAccountUsageOverviewMock = jest.fn();
const getAIUsageStatusMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => queryMock(...args) }),
}));

jest.mock("@cocalc/server/bay-directory", () => ({
  ...jest.requireActual("@cocalc/server/bay-directory"),
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  ...jest.requireActual("@cocalc/server/bay-config"),
  getConfiguredBayId: () => getConfiguredBayIdMock(),
}));

jest.mock("@cocalc/conat/inter-bay/api", () => ({
  ...jest.requireActual("@cocalc/conat/inter-bay/api"),
  createInterBayAccountLocalClient: () => ({
    getAccountUsageOverview: (...args: any[]) =>
      getAccountUsageOverviewMock(...args),
  }),
}));

jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  getInterBayFabricClient: () => ({}),
}));

jest.mock("@cocalc/server/ai/usage-status", () => ({
  getAIUsageStatus: (...args: any[]) => getAIUsageStatusMock(...args),
}));

describe("Codex payment source project-host authorization", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";
  const project_id = "22222222-2222-4222-8222-222222222222";
  const host_id = "33333333-3333-4333-8333-333333333333";

  beforeEach(() => queryMock.mockReset());

  it("accepts the assigned host for a collaborator account", async () => {
    queryMock.mockResolvedValue({ rowCount: 1 });
    const { assertCodexPaymentSourceCaller } = await import("./system");

    await expect(
      assertCodexPaymentSourceCaller({ account_id, project_id, host_id }),
    ).resolves.toBeUndefined();

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("users ?"), [
      project_id,
      host_id,
      account_id,
    ]);
  });

  it("rejects an unassigned host or non-collaborator account", async () => {
    queryMock.mockResolvedValue({ rowCount: 0 });
    const { assertCodexPaymentSourceCaller } = await import("./system");

    await expect(
      assertCodexPaymentSourceCaller({ account_id, project_id, host_id }),
    ).rejects.toThrow(
      "project host is not authorized for this account payment source",
    );
  });

  it("requires hosts to bind the lookup to a project", async () => {
    const { assertCodexPaymentSourceCaller } = await import("./system");

    await expect(
      assertCodexPaymentSourceCaller({ account_id, host_id }),
    ).rejects.toThrow("project_id is required");
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe("Codex payment source account-home usage", () => {
  const account_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    resolveAccountHomeBayMock.mockReset();
    getAccountUsageOverviewMock.mockReset();
    getAIUsageStatusMock.mockReset();
  });

  it("uses local AI usage on the account home bay", async () => {
    const status = { units_per_dollar: 1, windows: [] };
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-local" });
    getAIUsageStatusMock.mockResolvedValue(status);
    const { getAIUsageStatusForAccountHome } = await import("./system");

    await expect(getAIUsageStatusForAccountHome(account_id)).resolves.toBe(
      status,
    );
    expect(getAIUsageStatusMock).toHaveBeenCalledWith({ account_id });
    expect(getAccountUsageOverviewMock).not.toHaveBeenCalled();
  });

  it("reads AI usage meters from the remote account home bay", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-remote" });
    getAccountUsageOverviewMock.mockResolvedValue({
      meters: [
        {
          source: "ai_usage_status",
          window: "5h",
          used: 12,
          limit: 20,
          remaining: 8,
          reset_at: "2026-09-20T12:00:00.000Z",
        },
        {
          source: "ai_usage_status",
          window: "7d",
          used: 40,
          limit: 100,
          remaining: 60,
        },
      ],
    });
    const { getAIUsageStatusForAccountHome } = await import("./system");

    const status = await getAIUsageStatusForAccountHome(account_id);
    expect(getAIUsageStatusMock).not.toHaveBeenCalled();
    expect(getAccountUsageOverviewMock).toHaveBeenCalledWith({ account_id });
    expect(status.windows).toEqual([
      expect.objectContaining({
        window: "5h",
        used: 12,
        limit: 20,
        remaining: 8,
        reset_at: new Date("2026-09-20T12:00:00.000Z"),
      }),
      expect.objectContaining({
        window: "7d",
        used: 40,
        limit: 100,
        remaining: 60,
      }),
    ]);
  });
});
