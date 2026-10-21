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

it("re-issues content links and host credentials after a password change", async () => {
  apiMock.mockResolvedValue({});
  const renew = jest.fn(async () => {});
  await new AccountClient({
    conat_client: { renewProjectHostCredentials: renew },
  } as any).change_password("old", "new");
  expect(apiMock).toHaveBeenCalledWith("/accounts/set-password", {
    currentPassword: "old",
    newPassword: "new",
  });
  expect(notifyAllMock).toHaveBeenCalledTimes(1);
  // The hosts refuse this browser's old host credentials too.
  expect(renew).toHaveBeenCalledTimes(1);
});

it("a failed renewal is only logged (the password did change)", async () => {
  apiMock.mockResolvedValue({});
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  await new AccountClient({
    conat_client: {
      renewProjectHostCredentials: async () => {
        throw new Error("offline");
      },
    },
  } as any).change_password("old", "new");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it("doesn't when the change failed", async () => {
  apiMock.mockRejectedValue(new Error("Current password is incorrect."));
  await expect(
    new AccountClient({} as any).change_password("bad", "new"),
  ).rejects.toThrow("incorrect");
  expect(notifyAllMock).not.toHaveBeenCalled();
});
