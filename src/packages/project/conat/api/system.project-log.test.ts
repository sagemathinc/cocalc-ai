/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import os from "node:os";

process.env.LOGS = os.tmpdir();

const dstreamMock = jest.fn();
const getIdentityMock = jest.fn();

jest.mock("@cocalc/backend/conat/sync", () => ({
  dstream: (...args: any[]) => dstreamMock(...args),
}));

jest.mock("@cocalc/project/conat/connection", () => ({
  getIdentity: (...args: any[]) => getIdentityMock(...args),
}));

jest.mock("@cocalc/backend/ssh/ssh-keys", () => ({
  sshPublicKey: jest.fn(async () => ""),
}));

jest.mock("@cocalc/project/conat/authorized-keys", () => ({
  update: jest.fn(async () => ""),
}));

describe("project conat api project log", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";
  const account_id = "22222222-2222-4222-8222-222222222222";
  const client = { id: "client-1" } as any;

  beforeEach(() => {
    jest.resetModules();
    dstreamMock.mockReset();
    getIdentityMock.mockReset();
    getIdentityMock.mockReturnValue({ client, project_id });
  });

  it("appends rows to the project-log dstream", async () => {
    const publish = jest.fn();
    const save = jest.fn(async () => undefined);
    dstreamMock.mockResolvedValue({
      publish,
      save,
    });
    const { appendProjectLog } = await import("./system");
    const row = await appendProjectLog({
      account_id,
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      time: new Date("2026-04-11T20:00:00.000Z"),
      event: { event: "open_project" },
    });
    expect(dstreamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        client,
        project_id,
        name: "project-log",
        noInventory: true,
      }),
    );
    expect(publish).toHaveBeenCalledWith(row);
    expect(save).toHaveBeenCalled();
  });

  it("lists newest, older, and newer pages from the dstream", async () => {
    const rows = [
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
        project_id,
        account_id,
        time: new Date("2026-04-11T18:00:00.000Z"),
        event: { event: "oldest" },
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
        project_id,
        account_id,
        time: new Date("2026-04-11T19:00:00.000Z"),
        event: { event: "middle" },
      },
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        project_id,
        account_id,
        time: new Date("2026-04-11T20:00:00.000Z"),
        event: { event: "newest" },
      },
    ];
    dstreamMock.mockResolvedValue({
      getAll: () => rows,
      time: (index: number) => rows[index]?.time,
    });
    const { listProjectLog } = await import("./system");

    const firstPage = await listProjectLog({ limit: 2 });
    expect(firstPage.entries.map((row) => row.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2",
    ]);
    expect(firstPage.has_more).toBe(true);

    const olderPage = await listProjectLog({
      limit: 2,
      older_than: {
        id: firstPage.entries[1].id,
        time: firstPage.entries[1].time,
      },
    });
    expect(olderPage.entries.map((row) => row.id)).toEqual([
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3",
    ]);
    expect(olderPage.has_more).toBe(false);

    const newerPage = await listProjectLog({
      limit: 10,
      newer_than: {
        id: firstPage.entries[0].id,
        time: firstPage.entries[0].time,
      },
    });
    expect(newerPage.entries).toEqual([]);
    expect(newerPage.has_more).toBe(false);
  });
});
