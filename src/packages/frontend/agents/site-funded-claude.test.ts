/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  resetSiteFundedClaudeAvailabilityForTests,
  siteFundedClaudeAvailable,
} from "./site-funded-claude";

const mockAvailability = jest.fn();

jest.mock("@cocalc/frontend/webapp-client", () => ({
  webapp_client: {
    account_id: "account-a",
    conat_client: {
      hub: {
        system: {
          getSiteFundedClaudeAvailability: (...args: unknown[]) =>
            mockAvailability(...args),
        },
      },
    },
  },
}));
jest.mock("@cocalc/frontend/app-framework", () => ({
  useTypedRedux: jest.fn(),
}));

beforeEach(() => {
  resetSiteFundedClaudeAvailabilityForTests();
  mockAvailability.mockReset();
  (webapp_client as any).account_id = "account-a";
});

test("asks once per account, never answering for another account", async () => {
  mockAvailability.mockResolvedValueOnce({ available: true });
  expect(await siteFundedClaudeAvailable("account-a")).toBe(true);
  expect(await siteFundedClaudeAvailable("account-a")).toBe(true);
  expect(mockAvailability).toHaveBeenCalledTimes(1);
  // Signed in as another account: asked again, not the cached answer.
  (webapp_client as any).account_id = "account-b";
  mockAvailability.mockResolvedValueOnce({ available: false });
  expect(await siteFundedClaudeAvailable("account-b")).toBe(false);
  expect(mockAvailability).toHaveBeenCalledTimes(2);
  // An account this session does not answer for is never offered it.
  expect(await siteFundedClaudeAvailable("account-a")).toBe(false);
  expect(mockAvailability).toHaveBeenCalledTimes(2);
});

test("is not offered when unknown", async () => {
  mockAvailability.mockRejectedValueOnce(Error("old hub"));
  expect(await siteFundedClaudeAvailable("account-a")).toBe(false);
  expect(await siteFundedClaudeAvailable(undefined)).toBe(false);
});
