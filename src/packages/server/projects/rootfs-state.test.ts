/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export {};

let poolQueryMock: jest.Mock;
let transactionQueryMock: jest.Mock;
let transactionReleaseMock: jest.Mock;
let getTransactionClientMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: (...args: any[]) => poolQueryMock(...args),
  })),
  getTransactionClient: (...args: any[]) => getTransactionClientMock(...args),
}));

jest.mock("@cocalc/database/postgres/project-events-outbox", () => ({
  appendProjectOutboxEventForProject: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/accounts/get-name", () => ({
  getNames: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/account/project-feed", () => ({
  publishProjectAccountFeedEventsBestEffort: jest.fn(async () => undefined),
}));

jest.mock("@cocalc/server/account/project-detail-feed", () => ({
  publishProjectDetailInvalidationBestEffort: jest.fn(async () => undefined),
}));

describe("project RootFS state transaction affinity", () => {
  const project_id = "11111111-1111-4111-8111-111111111111";

  beforeEach(() => {
    jest.resetModules();
    poolQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_rootfs_states")) {
        return { rows: [] };
      }
      if (sql.includes("FROM projects")) {
        return { rows: [] };
      }
      throw new Error(`unexpected pooled query: ${sql}`);
    });
    transactionQueryMock = jest.fn(async () => ({ rows: [] }));
    transactionReleaseMock = jest.fn();
    getTransactionClientMock = jest.fn(async () => ({
      query: (...args: any[]) => transactionQueryMock(...args),
      release: transactionReleaseMock,
    }));
  });

  it("runs all state replacement writes and commit on one transaction client", async () => {
    const { replaceProjectRootfsStates } = await import("./rootfs-state");

    await replaceProjectRootfsStates({ project_id });

    expect(getTransactionClientMock).toHaveBeenCalledTimes(1);
    expect(transactionQueryMock).toHaveBeenNthCalledWith(
      1,
      "DELETE FROM project_rootfs_states WHERE project_id=$1",
      [project_id],
    );
    expect(transactionQueryMock).toHaveBeenNthCalledWith(2, "COMMIT");
    expect(transactionReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back and releases the same client when a state write fails", async () => {
    const failure = new Error("write failed");
    transactionQueryMock.mockRejectedValueOnce(failure);
    const { replaceProjectRootfsStates } = await import("./rootfs-state");

    await expect(replaceProjectRootfsStates({ project_id })).rejects.toBe(
      failure,
    );

    expect(transactionQueryMock).toHaveBeenNthCalledWith(2, "ROLLBACK");
    expect(transactionReleaseMock).toHaveBeenCalledTimes(1);
  });

  it("adds the legacy current image without changing a shared cached result", async () => {
    // As a cached result: frozen rows, shared by every caller.
    const stateRows = Object.freeze([]);
    poolQueryMock = jest.fn(async (sql: string) => {
      if (sql.includes("FROM project_rootfs_states"))
        return { rows: stateRows };
      if (sql.includes("FROM projects")) {
        return {
          rows: [
            Object.freeze({
              rootfs_image: "buildpack-deps:26.04",
              rootfs_image_id: "image-1",
            }),
          ],
        };
      }
      if (sql.includes("FROM rootfs_images")) {
        return {
          rows: [
            Object.freeze({
              runtime_image: "buildpack-deps:26.04",
              release_id: "release-1",
            }),
          ],
        };
      }
      throw new Error(`unexpected pooled query: ${sql}`);
    });
    const { getProjectRootfsStates } = await import("./rootfs-state");

    const states = await getProjectRootfsStates({ project_id });

    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ state_role: "current" });
    expect(stateRows).toHaveLength(0);
  });
});
