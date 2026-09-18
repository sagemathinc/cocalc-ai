/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: (...args: any[]) => queryMock(...args) })),
}));

jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: jest.fn(() => "bay-0"),
}));

jest.mock("@cocalc/server/accounts/is-admin", () => ({
  __esModule: true,
  default: jest.fn(async () => false),
}));

describe("loadProjectRuntimeSponsor", () => {
  beforeEach(() => {
    jest.resetModules();
  });

  it("loads course metadata and attributes a student project to its student", async () => {
    queryMock = jest.fn(async () => ({
      rows: [
        {
          runtime_sponsor_account_id: null,
          usage_account_id: null,
          course: { type: "student", account_id: "student" },
          users: {
            instructor: { group: "owner" },
            student: { group: "collaborator" },
          },
          owning_bay_id: "bay-0",
          host_id: "host-1",
          runtime_authority_revision: "7",
        },
      ],
    }));
    const { loadProjectRuntimeSponsor } = await import("./runtime-sponsor-db");

    await expect(loadProjectRuntimeSponsor("project-1")).resolves.toMatchObject(
      {
        sponsor_account_id: "student",
        owning_bay_id: "bay-0",
        host_id: "host-1",
        runtime_authority_revision: "7",
      },
    );
    expect(queryMock).toHaveBeenCalledWith(
      expect.stringMatching(
        /SELECT runtime_sponsor_account_id, usage_account_id, course/,
      ),
      ["project-1"],
    );
  });
});

export {};
