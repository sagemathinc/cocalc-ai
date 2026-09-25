import { normalizeCreditTransferTerms } from "./credit-transfers";
const terms = {
  currency: "USD",
  amount_usd: "12.34",
  recipient: {
    account_id: "11111111-1111-4111-8111-111111111111",
    authority_epoch: "22222222-2222-4222-8222-222222222222",
    home_bay_id: "a",
    email_address: "person@example.com",
    display_name: "Person",
  },
};
it("normalizes exact whole-cent transfer terms", () => {
  expect(normalizeCreditTransferTerms(terms).amount_usd).toBe("12.3400000000");
});
it.each([12.34, "0", "-1", "1.001", "1000.01", "Infinity", "1e2"])(
  "rejects invalid amount %s",
  (amount_usd) => {
    expect(() =>
      normalizeCreditTransferTerms({ ...terms, amount_usd }),
    ).toThrow();
  },
);
it("rejects currency, absent identity and unbounded recipient metadata", () => {
  expect(() =>
    normalizeCreditTransferTerms({ ...terms, currency: "EUR" }),
  ).toThrow();
  expect(() =>
    normalizeCreditTransferTerms({
      ...terms,
      recipient: { ...terms.recipient, account_id: "email@example.com" },
    }),
  ).toThrow();
  expect(() =>
    normalizeCreditTransferTerms({
      ...terms,
      recipient: { ...terms.recipient, display_name: "x".repeat(257) },
    }),
  ).toThrow();
});
