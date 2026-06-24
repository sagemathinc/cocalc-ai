/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const mockGetConn = jest.fn();
const mockGetPool = jest.fn();
const mockGetTransactionClient = jest.fn();

jest.mock("@cocalc/server/stripe/connection", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetConn(...args),
}));

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: (...args: any[]) => mockGetPool(...args),
  getTransactionClient: (...args: any[]) => mockGetTransactionClient(...args),
}));

jest.mock("@cocalc/database/settings/server-settings", () => ({
  getServerSettings: jest.fn(async () => ({ dns: "cocalc.ai" })),
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
  const client = {
    query: jest.fn(),
    release: jest.fn(),
  };
  const pool = {
    query: jest.fn(),
    connect: jest.fn(),
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
    mockGetTransactionClient.mockResolvedValue(client);
    mockGetConn.mockResolvedValue(stripe);
    pool.query.mockResolvedValue({ rows: [{}] });
    pool.connect.mockResolvedValue(client);
    client.query.mockImplementation(async (query: string) => {
      if (query.startsWith("SELECT email_address")) {
        return {
          rows: [
            {
              email_address: "account-1@example.com",
              first_name: "Ada",
              last_name: "Lovelace",
            },
          ],
        };
      }
      return { rows: [] };
    });
    client.release.mockResolvedValue(undefined);
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
    expect(client.query).toHaveBeenCalledWith(
      "UPDATE accounts SET stripe_customer_id=$2::TEXT WHERE account_id=$1",
      ["account-1", "cus_existing"],
    );
    expect(stripe.customers.create).not.toHaveBeenCalled();
  });

  it("uses a row lock and Stripe idempotency key when creating a customer", async () => {
    stripe.customers.search.mockResolvedValue({ data: [] });

    await expect(
      getStripeCustomerId({ account_id: "account-1", create: true }),
    ).resolves.toBe("cus_created");

    expect(client.query).toHaveBeenCalledWith(
      "SELECT email_address, first_name, last_name, stripe_customer_id FROM accounts WHERE account_id=$1 FOR UPDATE",
      ["account-1"],
    );
    expect(stripe.customers.create).toHaveBeenCalledWith(
      {
        description: "Ada Lovelace",
        name: "Ada Lovelace",
        email: "account-1@example.com",
        metadata: {
          account_id: "account-1",
          cocalc_site: "cocalc.ai",
        },
      },
      {
        idempotencyKey: "cocalc-stripe-customer:account-1",
      },
    );
    expect(mockGetTransactionClient).toHaveBeenCalledWith();
    expect(client.query).toHaveBeenCalledWith("COMMIT");
    expect(client.release).toHaveBeenCalled();
  });
});
