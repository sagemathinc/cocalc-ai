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
        },
      ],
    }));
    listProjectedProjectsForAccountMock = jest.fn(async () => []);
  });

  it("uses the legacy projects table by default", async () => {
    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({
        account_id: ACCOUNT_ID,
        limit: 5,
        offset: 2,
        hidden: true,
        search: "legacy",
      }),
    ).resolves.toEqual([
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Legacy Project",
        description: "legacy",
      },
    ]);
    expect(listProjectedProjectsForAccountMock).not.toHaveBeenCalled();
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(`${queryMock.mock.calls[0]?.[0] ?? ""}`).toContain(
      "IN ('owner', 'collaborator', 'viewer')",
    );
    expect(queryMock.mock.calls[0]?.[1]).toEqual([
      ACCOUNT_ID,
      5,
      true,
      "%legacy%",
      2,
    ]);
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
      offset: 0,
      include_hidden: false,
      search: undefined,
      sort: "last_edited",
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("passes backend window options through to projection reads", async () => {
    process.env.COCALC_ACCOUNT_PROJECT_INDEX_PROJECT_LIST_READS = "only";
    listProjectedProjectsForAccountMock = jest.fn(async () => [
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        title: "Projected Project",
        description: "projected",
        host_id: null,
        owning_bay_id: "bay-0",
        is_hidden: true,
        state_summary: { state: "running" },
        users_summary: {},
        last_activity_at: null,
        last_edited: null,
        last_backup: null,
        sort_key: null,
        updated_at: null,
      },
    ]);

    const getProjects = (await import("./get")).default;
    await expect(
      getProjects({
        account_id: ACCOUNT_ID,
        limit: 25,
        offset: 50,
        hidden: true,
        search: "geometry",
        sort: "title",
      }),
    ).resolves.toEqual([
      {
        project_id: "33333333-3333-4333-8333-333333333333",
        title: "Projected Project",
        description: "projected",
      },
    ]);
    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      limit: 25,
      offset: 50,
      include_hidden: true,
      search: "geometry",
      sort: "title",
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
