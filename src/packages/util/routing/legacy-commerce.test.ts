import { getLegacyCommerceTargetPath } from "./legacy-commerce";

describe("routing/legacy-commerce", () => {
  it("maps legacy billing paths to canonical settings pages", () => {
    expect(getLegacyCommerceTargetPath("billing")).toBe(
      "settings/subscriptions",
    );
    expect(getLegacyCommerceTargetPath("/billing/cards")).toBe(
      "settings/payment-methods",
    );
    expect(getLegacyCommerceTargetPath("/billing/payment-methods")).toBe(
      "settings/payment-methods",
    );
    expect(getLegacyCommerceTargetPath("/billing/subscriptions/history")).toBe(
      "settings/subscriptions",
    );
    expect(getLegacyCommerceTargetPath("/billing/invoices-and-receipts")).toBe(
      "settings/statements",
    );
  });

  it("maps legacy store paths to the new app-native store", () => {
    expect(getLegacyCommerceTargetPath("store")).toBe("settings/store");
    expect(getLegacyCommerceTargetPath("/store/membership")).toBe(
      "settings/store",
    );
    expect(getLegacyCommerceTargetPath("/store/vouchers?id=123")).toBe(
      "settings/store",
    );
    expect(getLegacyCommerceTargetPath("/store/checkout")).toBe(
      "settings/store",
    );
  });

  it("ignores unrelated paths", () => {
    expect(getLegacyCommerceTargetPath("/pricing")).toBeUndefined();
    expect(getLegacyCommerceTargetPath("/settings/store")).toBeUndefined();
  });
});
