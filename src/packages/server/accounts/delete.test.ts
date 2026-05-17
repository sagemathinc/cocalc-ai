/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const poolQueryMock = jest.fn();
const disposeOwnedProjectsForAccountDeletionMock = jest.fn();
const deleteRootfsImagesForAccountDeletionMock = jest.fn();
const deleteAllRememberMeMock = jest.fn();
const deleteBlobsForAccountDeletionMock = jest.fn();
const revokeAllAuthSessionsMock = jest.fn();
const recordAccountRevocationMock = jest.fn();
const withAccountRehomeWriteFenceMock = jest.fn();
const cancelEverythingMock = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: jest.fn(() => ({ query: poolQueryMock })),
}));

jest.mock("@cocalc/server/projects/ownership", () => ({
  __esModule: true,
  disposeOwnedProjectsForAccountDeletion: (...args: any[]) =>
    disposeOwnedProjectsForAccountDeletionMock(...args),
}));

jest.mock("@cocalc/server/rootfs/catalog", () => ({
  __esModule: true,
  deleteRootfsImagesForAccountDeletion: (...args: any[]) =>
    deleteRootfsImagesForAccountDeletionMock(...args),
}));

jest.mock("@cocalc/server/auth/remember-me", () => ({
  __esModule: true,
  deleteAllRememberMe: (...args: any[]) => deleteAllRememberMeMock(...args),
}));

jest.mock("@cocalc/server/membership/blob-limits", () => ({
  __esModule: true,
  deleteBlobsForAccountDeletion: (...args: any[]) =>
    deleteBlobsForAccountDeletionMock(...args),
}));

jest.mock("@cocalc/server/auth/auth-sessions", () => ({
  __esModule: true,
  revokeAllAuthSessions: (...args: any[]) => revokeAllAuthSessionsMock(...args),
}));

jest.mock("@cocalc/server/accounts/revocation", () => ({
  __esModule: true,
  recordAccountRevocation: (...args: any[]) =>
    recordAccountRevocationMock(...args),
}));

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  __esModule: true,
  withAccountRehomeWriteFence: (...args: any[]) =>
    withAccountRehomeWriteFenceMock(...args),
}));

jest.mock("@cocalc/server/stripe/client", () => ({
  __esModule: true,
  StripeClient: jest.fn(() => ({
    cancelEverything: cancelEverythingMock,
  })),
}));

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("delete account", () => {
  beforeEach(() => {
    jest.resetModules();
    poolQueryMock.mockReset();
    disposeOwnedProjectsForAccountDeletionMock.mockReset();
    deleteRootfsImagesForAccountDeletionMock.mockReset();
    deleteAllRememberMeMock.mockReset();
    deleteBlobsForAccountDeletionMock.mockReset();
    revokeAllAuthSessionsMock.mockReset();
    recordAccountRevocationMock.mockReset();
    withAccountRehomeWriteFenceMock.mockReset();
    cancelEverythingMock.mockReset();
    cancelEverythingMock.mockResolvedValue(undefined);
    deleteAllRememberMeMock.mockResolvedValue(undefined);
    revokeAllAuthSessionsMock.mockResolvedValue(undefined);
    recordAccountRevocationMock.mockResolvedValue(undefined);
    disposeOwnedProjectsForAccountDeletionMock.mockResolvedValue([]);
    deleteRootfsImagesForAccountDeletionMock.mockResolvedValue([]);
    deleteBlobsForAccountDeletionMock.mockResolvedValue({
      deleted_count: 0,
      deleted_bytes: 0,
    });
    poolQueryMock.mockResolvedValue({
      rows: [{ email_address: "user@example.com" }],
    });
    withAccountRehomeWriteFenceMock.mockImplementation(async ({ fn }) => {
      await fn({
        query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
      });
    });
  });

  it("disposes owned projects before marking the account deleted", async () => {
    const calls: string[] = [];
    disposeOwnedProjectsForAccountDeletionMock.mockImplementation(async () => {
      calls.push("dispose-projects");
    });
    deleteRootfsImagesForAccountDeletionMock.mockImplementation(async () => {
      calls.push("delete-rootfs-images");
    });
    deleteBlobsForAccountDeletionMock.mockImplementation(async () => {
      calls.push("delete-blobs");
    });
    withAccountRehomeWriteFenceMock.mockImplementation(async ({ fn }) => {
      calls.push("mark-deleted");
      await fn({
        query: jest.fn(async () => ({ rows: [], rowCount: 1 })),
      });
    });

    const { default: deleteAccount } = await import("./delete");
    await deleteAccount(ACCOUNT_ID);

    expect(disposeOwnedProjectsForAccountDeletionMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
    );
    expect(deleteRootfsImagesForAccountDeletionMock).toHaveBeenCalledWith(
      ACCOUNT_ID,
    );
    expect(deleteBlobsForAccountDeletionMock).toHaveBeenCalledWith({
      account_id: ACCOUNT_ID,
    });
    expect(calls).toEqual([
      "dispose-projects",
      "delete-rootfs-images",
      "delete-blobs",
      "mark-deleted",
    ]);
  });
});
