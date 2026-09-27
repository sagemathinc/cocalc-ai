/** @jest-environment jsdom */

describe("lite codex payment source labels", () => {
  it("offers explicit remaining subscriptions and local API keys after default revocation", () => {
    jest.resetModules();
    jest.doMock("@cocalc/frontend/lite", () => ({ lite: true }));
    const {
      getCodexPaymentSourceOptions,
    } = require("../use-codex-payment-source");
    const options = getCodexPaymentSourceOptions({
      source: "none",
      hasSubscription: false,
      subscriptions: [{ id: "remaining", isDefault: false }],
      hasSiteApiKey: true,
      hasAccountApiKey: true,
      hasProjectApiKey: true,
      sharedHomeMode: "fallback",
    });
    expect(options.map(({ value }) => value)).toEqual(
      expect.arrayContaining([
        "auto",
        "subscription",
        "site-api-key",
        "account-api-key",
        "project-api-key",
        "shared-home",
      ]),
    );
    expect(options.find(({ value }) => value === "site-api-key")).toMatchObject(
      { label: "Site OpenAI API key" },
    );
    expect(options.some(({ label }) => label === "CoCalc Membership")).toBe(
      false,
    );
  });

  it("does not show shared-home auth as unconfigured", () => {
    jest.resetModules();
    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: true,
    }));

    const {
      getCodexPaymentSourceShortLabel,
      getCodexPaymentSourceLongLabel,
      getCodexPaymentSourceTooltip,
    } = require("../use-codex-payment-source");

    expect(getCodexPaymentSourceShortLabel(undefined)).toBe("Unknown");
    expect(getCodexPaymentSourceLongLabel(undefined)).toBe("Unknown source");

    expect(getCodexPaymentSourceShortLabel("shared-home")).toBe(
      "Local Codex auth",
    );
    expect(getCodexPaymentSourceLongLabel("shared-home")).toBe(
      "Local Codex auth",
    );
    expect(
      getCodexPaymentSourceTooltip({
        source: "shared-home",
      }),
    ).toContain("local auth from ~/.codex");
  });
});
