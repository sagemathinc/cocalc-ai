import { assertFundingAccountCanRehome } from "./authority";

describe("funding account portability fence", () => {
  const original = process.env.COCALC_BILLING_AUTHORITY_ENABLED;

  afterEach(() => {
    if (original == null) delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    else process.env.COCALC_BILLING_AUTHORITY_ENABLED = original;
  });

  it("leaves seed-global financial records in place during account rehome", async () => {
    process.env.COCALC_BILLING_AUTHORITY_ENABLED = "1";
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(
      assertFundingAccountCanRehome({ query }, "payer"),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it("retains the legacy payer-home portability fence while disabled", async () => {
    delete process.env.COCALC_BILLING_AUTHORITY_ENABLED;
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rows: [{ table_name: "purchases" }] })
      .mockResolvedValueOnce({ rows: [{ exists: 1 }] });
    await expect(
      assertFundingAccountCanRehome({ query }, "payer"),
    ).rejects.toThrow("cannot be rehomed");
    expect(query).toHaveBeenCalledTimes(2);
  });
});
