/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let listProjectedProjectsForAccountMock: jest.Mock;

jest.mock("@cocalc/database/postgres/account-project-index", () => ({
  __esModule: true,
  listProjectedProjectsForAccount: (...args: any[]) =>
    listProjectedProjectsForAccountMock(...args),
}));

describe("project account list window API", () => {
  const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    listProjectedProjectsForAccountMock = jest.fn(async () => [
      {
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Projected",
        description: "projected row",
        theme: null,
        host_id: null,
        rootfs_image_id: "official-minimal",
        owning_bay_id: "bay-0",
        is_hidden: false,
        deletion_protection: false,
        state_summary: {},
        users_summary: {},
        last_activity_at: null,
        last_edited: null,
        last_backup: null,
        sort_key: null,
        updated_at: null,
      },
    ]);
  });

  it("reads a bounded account project window from account_project_index", async () => {
    const { listAccountProjectWindow } = await import("./projects");
    await expect(
      listAccountProjectWindow({
        account_id: ACCOUNT_ID,
        limit: 25,
        offset: 50,
        hidden: true,
        search: "geometry",
        sort: "title",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        project_id: "22222222-2222-4222-8222-222222222222",
        title: "Projected",
      }),
    ]);

    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      limit: 25,
      offset: 50,
      include_hidden: true,
      search: "geometry",
      sort: "title",
    });
  });

  it("caps large window requests", async () => {
    const { listAccountProjectWindow } = await import("./projects");
    await listAccountProjectWindow({
      account_id: ACCOUNT_ID,
      limit: 50_000,
    });

    expect(listProjectedProjectsForAccountMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 500,
        offset: 0,
        include_hidden: false,
        sort: "last_edited",
      }),
    );
  });

  it("rejects invalid window options before querying", async () => {
    const { listAccountProjectWindow } = await import("./projects");
    await expect(
      listAccountProjectWindow({
        account_id: ACCOUNT_ID,
        limit: 0,
      }),
    ).rejects.toThrow("limit must be a positive integer");
    await expect(
      listAccountProjectWindow({
        account_id: ACCOUNT_ID,
        offset: -1,
      }),
    ).rejects.toThrow("offset must be a nonnegative integer");
    expect(listProjectedProjectsForAccountMock).not.toHaveBeenCalled();
  });
});
