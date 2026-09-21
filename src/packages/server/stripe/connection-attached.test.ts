/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

jest.mock("@cocalc/server/cluster-config", () => ({
  getConfiguredClusterRole: () => "attached",
}));
jest.mock("@cocalc/database/settings", () => ({
  getServerSettings: jest.fn(async () => ({
    stripe_publishable_key: "pk_test_should_not_be_read",
    stripe_secret_key: "sk_test_should_not_be_read",
  })),
}));

import { getServerSettings } from "@cocalc/database/settings";
import getConn from "./connection";

describe("Stripe connection on an attached bay", () => {
  it("fails before reading or reusing provider credentials", async () => {
    await expect(getConn()).rejects.toMatchObject({ code: 503, status: 503 });
    expect(getServerSettings).not.toHaveBeenCalled();
  });
});
