/*
 * This file is part of CoCalc: Copyright 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

const query = jest.fn();
const updateDirectory = jest.fn();
const publishFeed = jest.fn();

jest.mock("@cocalc/server/accounts/rehome-fence", () => ({
  withAccountRehomeWriteFence: async ({ fn }: { fn: Function }) =>
    await fn({ query }),
}));

jest.mock("@cocalc/server/inter-bay/account-directory-updates", () => ({
  updateClusterAccountEmailAddressVerified: (...args: any[]) =>
    updateDirectory(...args),
}));

jest.mock("@cocalc/server/account/account-row-feed", () => ({
  publishAccountRowFeedEventsBestEffort: (...args: any[]) =>
    publishFeed(...args),
}));

import adminVerifyEmailAddress from "./admin-verify-email-address";

beforeEach(() => {
  jest.clearAllMocks();
});

it("rejects proof for an email that is no longer current", async () => {
  query.mockResolvedValue({
    rows: [
      {
        email_address: "new@example.com",
        email_address_verified: {},
      },
    ],
  });

  await expect(
    adminVerifyEmailAddress({
      account_id: "00000000-0000-4000-8000-000000000001",
      email_address: "old@example.com",
    }),
  ).rejects.toThrow("verified email does not match the account");
  expect(updateDirectory).not.toHaveBeenCalled();
  expect(publishFeed).not.toHaveBeenCalled();
});

it("records verification for the exact current email", async () => {
  query
    .mockResolvedValueOnce({
      rows: [
        {
          email_address: "new@example.com",
          email_address_verified: {},
        },
      ],
    })
    .mockResolvedValueOnce({ rowCount: 1 });

  await expect(
    adminVerifyEmailAddress({
      account_id: "00000000-0000-4000-8000-000000000001",
      email_address: "NEW@EXAMPLE.COM",
    }),
  ).resolves.toMatchObject({ email_address: "new@example.com" });
  expect(updateDirectory).toHaveBeenCalledWith({
    account_id: "00000000-0000-4000-8000-000000000001",
    email_address: "new@example.com",
    email_address_verified: true,
  });
});
