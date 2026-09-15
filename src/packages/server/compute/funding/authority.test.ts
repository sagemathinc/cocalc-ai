import { assertFundingAccountCanRehome } from "./authority";

describe("funding account portability fence", () => {
  it("allows accounts with no funding records, including pre-migration databases", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(
      assertFundingAccountCanRehome({ query }, "payer"),
    ).resolves.toBeUndefined();
    expect(query.mock.calls.map(([, params]) => params[0])).toEqual(
      expect.arrayContaining([
        "public.purchases",
        "public.subscriptions",
        "public.statements",
        "public.subscription_renewal_attempts",
        "public.account_funding_holds",
        "public.compute_funding_pools",
        "public.credit_transfers",
        "public.payment_fulfillments",
        "public.provider_refund_attempts",
      ]),
    );
  });

  it.each([
    "purchases",
    "subscriptions",
    "statements",
    "subscription_renewal_attempts",
    "credit_transfers",
    "account_funding_holds",
    "compute_funding_pools",
    "payment_fulfillments",
    "provider_refund_attempts",
  ])("refuses to abandon %s", async (table) => {
    const query = jest.fn(async (sql: string, params: any[]) => {
      if (sql.includes("to_regclass"))
        return {
          rows: params[0] === `public.${table}` ? [{ table_name: table }] : [],
        };
      return { rows: [{ exists: 1 }] };
    });
    await expect(
      assertFundingAccountCanRehome({ query } as any, "payer"),
    ).rejects.toMatchObject({ code: "funding_unavailable" });
  });
});
