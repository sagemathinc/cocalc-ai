import { getLegacyCommerceTargetPath } from "./legacy-commerce";

describe("routing/legacy-commerce", () => {
  it("maps legacy billing paths to canonical settings pages", () => {
    expect(getLegacyCommerceTargetPath("billing")).toBe("settings/membership");
    expect(getLegacyCommerceTargetPath("/billing/cards")).toBe(
      "settings/payment-methods",
    );
    expect(getLegacyCommerceTargetPath("/billing/payment-methods")).toBe(
      "settings/payment-methods",
    );
    expect(getLegacyCommerceTargetPath("/billing/subscriptions/history")).toBe(
      "settings/membership",
    );
    expect(getLegacyCommerceTargetPath("/billing/invoices-and-receipts")).toBe(
      "settings/statements",
    );
  });

  it("maps supported legacy store paths to replacement settings pages", () => {
    expect(getLegacyCommerceTargetPath("store")).toBe("settings/membership");
    expect(getLegacyCommerceTargetPath("/store/membership")).toBe(
      "settings/membership",
    );
    expect(getLegacyCommerceTargetPath("/store/checkout")).toBe(
      "settings/membership",
    );
  });

  it("ignores unrelated paths", () => {
    expect(getLegacyCommerceTargetPath("/pricing")).toBeUndefined();
    expect(getLegacyCommerceTargetPath("/settings/store")).toBeUndefined();
    expect(
      getLegacyCommerceTargetPath("/store/vouchers?id=123"),
    ).toBeUndefined();
  });
});
