/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let queryMock: jest.Mock;
let listProjectedProjectsForAccountMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => queryMock(...args),
  })),
}));

jest.mock("@cocalc/database/postgres/account-project-index", () => ({
  __esModule: true,
  listProjectedProjectsForAccount: (...args: any[]) =>
    listProjectedProjectsForAccountMock(...args),
}));

describe("server/projects/get", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    delete process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS;
    delete process.env.COCALC_CLUSTER_ROLE;
    queryMock = jest.fn(async () => ({
      rows: [
        {
          project_id: "22222222-2222-4222-8222-222222222222",
          title: "Legacy Project",
          description: "legacy",
          name: "legacy-name",
        },
      ],
    }));
    listProjectedProjectsForAccountMock = jest.fn(async () => []);
  });

  it("uses the legacy projects table by default", async () => {
    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({ account_id: ACCOUNT_ID, limit: 5 }),
    ).resolves.toEqual([
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Legacy Project",
        description: "legacy",
        name: "legacy-name",
      },
    ]);
    expect(listProjectedProjectsForAccountMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("prefers projection rows when enabled", async () => {
    process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
    listProjectedProjectsForAccountMock = jest.fn(async () => [
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        title: "Projected Project",
        description: "projected",
        host_id: null,
        owning_bay_id: "bay-0",
        is_hidden: false,
        sort_key: null,
        updated_at: null,
      },
    ]);

    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({ account_id: ACCOUNT_ID, limit: 5 }),
    ).resolves.toEqual([
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        title: "Projected Project",
        description: "projected",
      },
    ]);
    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      limit: 5,
      include_hidden: false,
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("falls back to the legacy query when prefer mode sees no projection rows", async () => {
    process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "prefer";
    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({ account_id: ACCOUNT_ID, limit: 5 }),
    ).resolves.toEqual([
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Legacy Project",
        description: "legacy",
        name: "legacy-name",
      },
    ]);
    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("does not fall back in only mode", async () => {
    process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "only";
    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({ account_id: ACCOUNT_ID, limit: 5 }),
    ).resolves.toEqual([]);
    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("prefers projection rows automatically in multi-bay mode", async () => {
    process.env.COCALC_CLUSTER_ROLE = "attached";
    listProjectedProjectsForAccountMock = jest.fn(async () => [
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        title: "Projected Project",
        description: "projected",
        host_id: null,
        owning_bay_id: "bay-1",
        is_hidden: false,
        sort_key: null,
        updated_at: null,
      },
    ]);

    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({ account_id: ACCOUNT_ID, limit: 5 }),
    ).resolves.toEqual([
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        title: "Projected Project",
        description: "projected",
      },
    ]);
    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
