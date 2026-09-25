/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

export {};

const accountId = "11111111-1111-4111-8111-111111111111";
const resolveAccountHomeBayMock = jest.fn();
const listLocalMock = jest.fn();
const listRemoteMock = jest.fn();

jest.mock("@cocalc/server/bay-config", () => ({
  ...jest.requireActual("@cocalc/server/bay-config"),
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("@cocalc/server/bay-directory", () => ({
  ...jest.requireActual("@cocalc/server/bay-directory"),
  resolveAccountHomeBay: (...args: any[]) => resolveAccountHomeBayMock(...args),
}));
jest.mock("@cocalc/server/projects/list-account-window", () => ({
  listProjectSummaries: (...args: any[]) => listLocalMock(...args),
}));
jest.mock("@cocalc/server/inter-bay/fabric", () => ({
  ...jest.requireActual("@cocalc/server/inter-bay/fabric"),
  getInterBayFabricClient: () => "fabric-client",
}));
jest.mock("@cocalc/conat/inter-bay/api", () => ({
  ...jest.requireActual("@cocalc/conat/inter-bay/api"),
  createInterBayAccountLocalClient: jest.fn(({ dest_bay }) => {
    if (dest_bay !== "bay-1") throw Error("wrong account home");
    return { listProjectSummaries: listRemoteMock };
  }),
}));

describe("API-key project summaries route to account home", () => {
  const request = { account_id: accountId, limit: 5, search: "Sage" };
  const page = { projects: [], next_offset: null };

  beforeEach(() => {
    resolveAccountHomeBayMock.mockReset();
    listLocalMock.mockReset();
    listRemoteMock.mockReset();
    listLocalMock.mockResolvedValue(page);
    listRemoteMock.mockResolvedValue(page);
  });

  it("reads the home-bay index locally", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-0" });
    const { listProjectSummaries } = await import("./projects");
    await expect(listProjectSummaries(request)).resolves.toBe(page);
    expect(listLocalMock).toHaveBeenCalledWith({
      ...request,
      project_id: undefined,
      offset: undefined,
    });
    expect(listRemoteMock).not.toHaveBeenCalled();
  });

  it("routes an attached-bay read to the current account home", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-1" });
    const { listProjectSummaries } = await import("./projects");
    await expect(listProjectSummaries(request)).resolves.toBe(page);
    expect(listRemoteMock).toHaveBeenCalledWith({
      ...request,
      project_id: undefined,
      offset: undefined,
    });
    expect(listLocalMock).not.toHaveBeenCalled();
  });

  it("does not fall back to a stale local index when home is unavailable", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-1" });
    listRemoteMock.mockRejectedValue(Error("home unavailable"));
    const { listProjectSummaries } = await import("./projects");
    await expect(listProjectSummaries(request)).rejects.toThrow(
      "home unavailable",
    );
    expect(listLocalMock).not.toHaveBeenCalled();
  });
});
