/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const queryMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({
    query: queryMock,
  })),
}));

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const OP_ID = "22222222-2222-4222-8222-222222222222";

describe("hard-delete state", () => {
  beforeEach(() => {
    queryMock.mockReset();
  });

  it("accepts hard delete for legacy soft-deleted project rows", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { markProjectHardDeleteAccepted } =
      await import("./hard-delete-state");
    await expect(
      markProjectHardDeleteAccepted({
        project_id: PROJECT_ID,
        op_id: OP_ID,
      }),
    ).resolves.toBe(true);

    const [sql] = queryMock.mock.calls[0];
    expect(`${sql}`).not.toContain("deleted IS NOT TRUE");
  });

  it("can mark accepted legacy soft-deleted project rows as failed", async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    const { markProjectHardDeleteFailed } = await import("./hard-delete-state");
    await expect(
      markProjectHardDeleteFailed({
        project_id: PROJECT_ID,
        op_id: OP_ID,
        error: "boom",
      }),
    ).resolves.toBe(true);

    const [sql] = queryMock.mock.calls[0];
    expect(`${sql}`).not.toContain("deleted IS NOT TRUE");
  });
});
