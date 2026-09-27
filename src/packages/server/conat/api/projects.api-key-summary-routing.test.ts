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
  it("does not expose the authenticated-key helper as a public RPC", async () => {
    const { getHubApiPrincipalPolicy } = await import("@cocalc/conat/hub/api");
    expect(
      getHubApiPrincipalPolicy("projects.listProjectSummariesForApiKey"),
    ).toBeUndefined();
  });
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

  it("public RPC ignores caller-supplied admission identity", async () => {
    resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id: "bay-0" });
    const { listProjectSummaries } = await import("./projects");
    await listProjectSummaries({
      ...request,
      admission_key: { key_id: "victim-key", scope_revision: 1 },
    } as any);
    expect(listLocalMock.mock.calls[0][0]).not.toHaveProperty("admission_key");
  });

  it("rejects missing key identity before routing", async () => {
    const { listProjectSummariesForApiKey } = await import("./projects");
    await expect(
      listProjectSummariesForApiKey(
        { account_id: accountId, capabilities: ["project:list"] } as any,
        {},
      ),
    ).rejects.toThrow("missing authenticated search key identity");
    expect(resolveAccountHomeBayMock).not.toHaveBeenCalled();
  });

  it.each(["bay-0", "bay-1"])(
    "derives key identity and account from the principal on %s",
    async (home_bay_id) => {
      resolveAccountHomeBayMock.mockResolvedValue({ home_bay_id });
      const { listProjectSummariesForApiKey } = await import("./projects");
      await listProjectSummariesForApiKey(
        {
          account_id: accountId,
          key_id: "real-key",
          scope_revision: 3,
          capabilities: ["project:list"],
        } as any,
        {
          account_id: "victim",
          admission_key: { key_id: "victim-key", scope_revision: 1 },
          limit: 5,
        } as any,
      );
      expect(
        home_bay_id === "bay-0" ? listLocalMock : listRemoteMock,
      ).toHaveBeenCalledWith({
        account_id: accountId,
        project_id: undefined,
        limit: 5,
        offset: undefined,
        search: undefined,
        admission_key: { key_id: "real-key", scope_revision: 3 },
      });
    },
  );
});
