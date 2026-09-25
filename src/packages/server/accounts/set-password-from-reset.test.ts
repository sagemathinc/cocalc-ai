/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const query = jest.fn();

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  withAccountRehomeWriteFence: async ({ fn }: { fn: Function }) =>
    await fn({ query }),
}));

jest.mock("@cocalc/backend/auth/password-hash", () => ({
  __esModule: true,
  default: () => "hashed-password",
}));

import setPasswordFromReset from "./set-password-from-reset";

beforeEach(() => {
  query.mockReset();
});

it("updates only when the reset email is still current", async () => {
  query.mockResolvedValue({ rowCount: 1 });

  await setPasswordFromReset({
    account_id: "00000000-0000-4000-8000-000000000001",
    email_address: "User@Example.COM",
    password: "not-used-by-mock",
  });

  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("lower(email_address)=$3"),
    [
      "hashed-password",
      "00000000-0000-4000-8000-000000000001",
      "user@example.com",
    ],
  );
});

it("rejects a reset after the account email changes", async () => {
  query.mockResolvedValue({ rowCount: 0 });

  await expect(
    setPasswordFromReset({
      account_id: "00000000-0000-4000-8000-000000000001",
      email_address: "old@example.com",
      password: "not-used-by-mock",
    }),
  ).rejects.toThrow("Password reset no longer valid");
});
