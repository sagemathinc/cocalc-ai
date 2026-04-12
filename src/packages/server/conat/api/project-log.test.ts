/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import os from "node:os";

process.env.LOGS = os.tmpdir();

const assertCollabMock = jest.fn();
const getExplicitProjectRoutedClientMock = jest.fn();
const listProjectLogMock = jest.fn();
const appendProjectLogMock = jest.fn();

jest.mock("./util", () => ({
  assertCollab: (...args: any[]) => assertCollabMock(...args),
}));

jest.mock("@cocalc/server/conat/route-client", () => ({
  getExplicitProjectRoutedClient: (...args: any[]) =>
    getExplicitProjectRoutedClientMock(...args),
}));

jest.mock("@cocalc/conat/project/api", () => ({
  projectApiClient: () => ({
    system: {
      listProjectLog: (...args: any[]) => listProjectLogMock(...args),
      appendProjectLog: (...args: any[]) => appendProjectLogMock(...args),
    },
  }),
}));

describe("conat project log api", () => {
  const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";

  beforeEach(() => {
    jest.resetModules();
    assertCollabMock.mockReset();
    getExplicitProjectRoutedClientMock.mockReset();
    listProjectLogMock.mockReset();
    appendProjectLogMock.mockReset();
    getExplicitProjectRoutedClientMock.mockResolvedValue({ id: "client-1" });
  });

  it("routes listProjectLog to the project api", async () => {
    const page = {
      entries: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          project_id: PROJECT_ID,
          account_id: ACCOUNT_ID,
          time: new Date("2026-04-11T20:00:00.000Z"),
          event: { event: "newest" },
        },
      ],
      has_more: false,
    };
    listProjectLogMock.mockResolvedValue(page);
    const { listProjectLog } = await import("./projects");

    await expect(
      listProjectLog({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        limit: 25,
      }),
    ).resolves.toEqual(page);
    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(listProjectLogMock).toHaveBeenCalledWith({
      limit: 25,
      newer_than: undefined,
      older_than: undefined,
    });
  });

  it("routes appendProjectLog to the project api", async () => {
    const row = {
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      project_id: PROJECT_ID,
      account_id: ACCOUNT_ID,
      time: new Date("2026-04-11T20:00:00.000Z"),
      event: { event: "open_project" },
    };
    appendProjectLogMock.mockResolvedValue(row);
    const { appendProjectLog } = await import("./projects");

    await expect(
      appendProjectLog({
        account_id: ACCOUNT_ID,
        project_id: PROJECT_ID,
        id: row.id,
        time: row.time,
        event: row.event,
      }),
    ).resolves.toEqual(row);
    expect(assertCollabMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      project_id: PROJECT_ID,
    });
    expect(appendProjectLogMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
      id: row.id,
      time: row.time,
      event: row.event,
    });
  });
});
