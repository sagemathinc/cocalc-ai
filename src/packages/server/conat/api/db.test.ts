/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: queryMock,
  }),
}));

describe("conat db api", () => {
  beforeEach(() => {
    queryMock = jest.fn(async () => ({ rows: [] }));
  });

  it("only removes blob TTLs for blobs owned by the caller account", async () => {
    const { removeBlobTtls } = await import("./db");
    const uuid = "11111111-1111-4111-8111-111111111111";

    await removeBlobTtls({
      account_id: "22222222-2222-4222-8222-222222222222",
      uuids: [uuid, "not-a-uuid"],
    });

    expect(queryMock).toHaveBeenCalledWith(
      "UPDATE blobs SET expire=NULL WHERE id::UUID=ANY($1::UUID[]) AND account_id=$2",
      [[uuid], "22222222-2222-4222-8222-222222222222"],
    );
  });

  it("requires the auth transform to inject an account id before removing blob TTLs", async () => {
    const { removeBlobTtls } = await import("./db");

    await expect(
      removeBlobTtls({
        uuids: ["11111111-1111-4111-8111-111111111111"],
      }),
    ).rejects.toThrow("account_id must be set");
    expect(queryMock).not.toHaveBeenCalled();
  });
});
