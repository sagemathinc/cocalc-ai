/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

let queryMock: jest.Mock;
let mockGetBlob: jest.Mock;
let mockSha1: jest.Mock;
let mockAssertCollab: jest.Mock;

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({
    query: queryMock,
  }),
}));

jest.mock("@cocalc/database", () => ({
  db: () => ({
    get_blob: mockGetBlob,
    sha1: mockSha1,
  }),
}));

jest.mock("./util", () => ({
  assertCollab: (...args: any[]) => mockAssertCollab(...args),
}));

describe("conat db api", () => {
  beforeEach(() => {
    queryMock = jest.fn(async () => ({ rows: [] }));
    mockGetBlob = jest.fn(({ cb }) => cb(undefined, Buffer.from("patches")));
    mockSha1 = jest.fn(() => "syncstring-id");
    mockAssertCollab = jest.fn(async () => {});
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

  it("requires project collaborator access for archived time-travel blobs", async () => {
    const { getLegacyTimeTravelPatches } = await import("./db");
    const uuid = "11111111-1111-4111-8111-111111111111";
    const account_id = "22222222-2222-4222-8222-222222222222";
    const project_id = "33333333-3333-4333-8333-333333333333";
    queryMock.mockResolvedValueOnce({ rows: [{ project_id }] });

    await expect(
      getLegacyTimeTravelPatches({ account_id, uuid }),
    ).resolves.toBe("patches");

    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining("blobs"), [
      uuid,
    ]);
    expect(mockAssertCollab).toHaveBeenCalledWith({ account_id, project_id });
    expect(mockGetBlob).toHaveBeenCalledWith(expect.objectContaining({ uuid }));
  });

  it("does not require project collaborator access for unassociated blobs", async () => {
    const { getLegacyTimeTravelPatches } = await import("./db");
    const uuid = "11111111-1111-4111-8111-111111111111";
    queryMock.mockResolvedValueOnce({ rows: [{ project_id: null }] });

    await expect(
      getLegacyTimeTravelPatches({
        account_id: "22222222-2222-4222-8222-222222222222",
        uuid,
      }),
    ).resolves.toBe("patches");

    expect(mockAssertCollab).not.toHaveBeenCalled();
  });
});
