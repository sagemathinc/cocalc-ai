/** @jest-environment jsdom */

jest.mock("@cocalc/frontend/lite", () => ({ lite: false }));

import {
  getCodexPaymentSourceOptions,
  getCodexPaymentSourceShortLabel,
  getCodexPaymentSourceTooltip,
} from "../use-codex-payment-source";

describe("Codex payment source choices", () => {
  const available = {
    source: "subscription" as const,
    preference: "auto" as const,
    hasSubscription: true,
    hasProjectApiKey: false,
    hasAccountApiKey: false,
    hasSiteApiKey: true,
    siteAiUsageLimitPositive: true,
    siteFundedCodex: { enabled: true },
    sharedHomeMode: "disabled" as const,
  };

  it("offers membership usage even when a ChatGPT credential takes precedence", () => {
    const options = getCodexPaymentSourceOptions(available);
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "auto" }),
        expect.objectContaining({
          value: "site-api-key",
          disabled: false,
        }),
        expect.objectContaining({ value: "subscription" }),
      ]),
    );
  });

  it("offers replacement subscriptions when the selected credential was deleted", () => {
    const options = getCodexPaymentSourceOptions({
      ...available,
      source: "none",
      preference: "subscription",
      hasSubscription: false,
      credentialId: undefined,
      subscriptions: [
        {
          id: "replacement-credential",
          email: "replacement@example.com",
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    expect(options).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "subscription" }),
      ]),
    );
  });

  it("disables membership usage when the site-funded policy is unavailable", () => {
    const options = getCodexPaymentSourceOptions({
      ...available,
      siteFundedCodex: { enabled: false },
    });
    expect(options.find(({ value }) => value === "site-api-key")).toEqual(
      expect.objectContaining({ disabled: true }),
    );
  });

  it("only describes precedence for automatic selection", () => {
    expect(getCodexPaymentSourceTooltip(available)).toContain(
      "Automatic order",
    );
    expect(
      getCodexPaymentSourceTooltip({
        ...available,
        source: "site-api-key",
        preference: "site-api-key",
      }),
    ).not.toContain("Automatic order");
  });

  it("uses a compact label for membership usage", () => {
    expect(getCodexPaymentSourceShortLabel("site-api-key")).toBe("Membership");
  });

  it("keeps membership tooltip copy concise when ChatGPT is connected", () => {
    const tooltip = getCodexPaymentSourceTooltip({
      ...available,
      source: "site-api-key",
      preference: "site-api-key",
    });
    expect(tooltip).toBe("Source for the next turn: your CoCalc Membership.");
  });

  it("suggests personal credentials only when none are connected", () => {
    const tooltip = getCodexPaymentSourceTooltip({
      ...available,
      source: "site-api-key",
      preference: "site-api-key",
      hasSubscription: false,
    });
    expect(tooltip).toContain(
      "Connect a personal ChatGPT plan or API key to choose other settings.",
    );
  });
});
