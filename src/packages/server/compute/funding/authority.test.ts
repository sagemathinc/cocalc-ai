import { assertFundingAccountCanRehome } from "./authority";

describe("funding account portability fence", () => {
  it("leaves seed-global financial records in place during account rehome", async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    await expect(
      assertFundingAccountCanRehome({ query }, "payer"),
    ).resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
