/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();
const mockGetPool = jest.fn();
const mockSetStripeCustomerId = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetPool(...args),
}));

jest.mock("@cocalc/database/postgres/stripe", () => ({
  setStripeCustomerId: (...args: any[]) => mockSetStripeCustomerId(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => ({})),
}));

jest.mock("@cocalc/server/accounts/is-valid-account", () => ({
  __esModule: true,
  default: jest.fn(async () => true),
}));

jest.mock("@cocalc/server/messages/send", () => ({
  url: jest.fn(async () => "https://cocalc.example"),
}));

import { getStripeCustomerId } from "./util";

describe("getStripeCustomerId", () => {
  const pool = {
    query: jest.fn(),
  };
  const stripe = {
    customers: {
      create: jest.fn(),
      search: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetPool.mockReturnValue(pool);
    mockGetConn.mockResolvedValue(stripe);
    pool.query.mockResolvedValue({ rows: [{}] });
    mockSetStripeCustomerId.mockResolvedValue(undefined);
    stripe.customers.create.mockResolvedValue({ id: "cus_created" });
    stripe.customers.search.mockResolvedValue({
      data: [{ id: "cus_existing", deleted: false }],
    });
  });

  it("recovers an existing Stripe customer by account metadata before creating one", async () => {
    await expect(
      getStripeCustomerId({ account_id: "account-1", create: true }),
    ).resolves.toBe("cus_existing");

    expect(stripe.customers.search).toHaveBeenCalledWith({
      query: "metadata['account_id']:'account-1'",
      limit: 1,
    });
    expect(mockSetStripeCustomerId).toHaveBeenCalledWith(
      "account-1",
      "cus_existing",
    );
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });
});
