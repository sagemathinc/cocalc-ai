export {};

describe("purchases.maintenance capability gating", () => {
  it("runs only statement maintenance when Stripe is not configured", async () => {
    const { getEnabledMaintenanceDescriptions } = await import("./maintenance");
    expect(
      getEnabledMaintenanceDescriptions({
        stripe_publishable_key: "",
        stripe_secret_key: "",
      } as any),
    ).toEqual(["maintain statements", "maintain membership analytics"]);
  });

  it("does not enable Stripe-backed tasks with only one Stripe key", async () => {
    const { getEnabledMaintenanceDescriptions } = await import("./maintenance");
    expect(
      getEnabledMaintenanceDescriptions({
        stripe_publishable_key: "pk_test_123",
        stripe_secret_key: "",
      } as any),
    ).toEqual(["maintain statements", "maintain membership analytics"]);
    expect(
      getEnabledMaintenanceDescriptions({
        stripe_publishable_key: "",
        stripe_secret_key: "sk_test_456",
      } as any),
    ).toEqual(["maintain statements", "maintain membership analytics"]);
  });

  it("enables Stripe-backed tasks when both Stripe keys are configured", async () => {
    const { getEnabledMaintenanceDescriptions } = await import("./maintenance");
    expect(
      getEnabledMaintenanceDescriptions({
        stripe_publishable_key: "pk_test_123",
        stripe_secret_key: "sk_test_456",
      } as any),
    ).toEqual([
      "maintain subscriptions",
      "maintain team licenses",
      "maintain statements",
      "processing any outstanding payment intents",
      "maintain automatic payments",
      "maintain auto balance",
      "maintain membership analytics",
    ]);
  });
});
