/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const apiMock = jest.fn();
const notifyAllMock = jest.fn();

jest.mock("./api", () => ({
  __esModule: true,
  default: (...args: any[]) => apiMock(...args),
}));
jest.mock("@cocalc/frontend/project/content-link-revocations", () => ({
  notifyAllContentLinksRevoked: () => notifyAllMock(),
}));
jest.mock("./client", () => ({}));

import { AccountClient } from "./account";

beforeEach(() => {
  apiMock.mockReset();
  notifyAllMock.mockReset();
});

it("re-issues open previews' content links after a password change", async () => {
  apiMock.mockResolvedValue({});
  await new AccountClient({} as any).change_password("old", "new");
  expect(apiMock).toHaveBeenCalledWith("/accounts/set-password", {
    currentPassword: "old",
    newPassword: "new",
  });
  expect(notifyAllMock).toHaveBeenCalledTimes(1);
});

it("doesn't when the change failed", async () => {
  apiMock.mockRejectedValue(new Error("Current password is incorrect."));
  await expect(
    new AccountClient({} as any).change_password("bad", "new"),
  ).rejects.toThrow("incorrect");
  expect(notifyAllMock).not.toHaveBeenCalled();
});
