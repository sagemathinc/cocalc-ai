/** @jest-environment jsdom */

import {
  CODEX_MODEL_CATALOG_TTL_MS,
  clearCachedCodexModelCatalog,
  getCodexSubscriptionConnection,
  readCachedCodexModelCatalog,
  writeCachedCodexModelCatalog,
} from "./codex-usage";

describe("getCodexSubscriptionConnection", () => {
  it("uses an explicit backend authentication result", () => {
    expect(
      getCodexSubscriptionConnection({
        available: false,
        checkedAt: new Date().toISOString(),
        paymentSource: { source: "subscription" } as any,
        authentication: {
          status: "needs-sign-in",
          reason: "Sign in again.",
        },
      }),
    ).toEqual({ status: "needs-sign-in", reason: "Sign in again." });
  });

  it("treats a verified account as connected when usage is unavailable", () => {
    expect(
      getCodexSubscriptionConnection({
        available: false,
        checkedAt: new Date().toISOString(),
        paymentSource: { source: "subscription" } as any,
        account: {
          account: {
            type: "chatgpt",
            email: "user@example.com",
          },
        },
        errors: { rateLimits: "rate limit service unavailable" },
      }),
    ).toEqual({ status: "connected" });
  });

  it("recognizes auth failures returned by older project hosts", () => {
    expect(
      getCodexSubscriptionConnection({
        available: false,
        checkedAt: new Date().toISOString(),
        paymentSource: { source: "subscription" } as any,
        reason: "codex account authentication required to read rate limits",
      }).status,
    ).toBe("needs-sign-in");
  });
});

describe("Codex model catalog cache", () => {
  const models = [
    {
      model: "gpt-daybreak-blue-latest",
      displayName: "Daybreak Blue",
      description: "Defensive cybersecurity model",
      specialty: "cyber",
      reasoning: [],
      serviceTiers: [],
    },
  ];

  beforeEach(() => window.localStorage.clear());

  it("keeps account catalogs for 30 minutes", () => {
    writeCachedCodexModelCatalog({
      accountId: "account-1",
      models,
      cachedAt: 1_000,
    });
    expect(
      readCachedCodexModelCatalog({
        accountId: "account-1",
        now: 1_000 + CODEX_MODEL_CATALOG_TTL_MS - 1,
      }),
    ).toEqual({ cachedAt: 1_000, models });
    expect(
      readCachedCodexModelCatalog({
        accountId: "account-1",
        now: 1_000 + CODEX_MODEL_CATALOG_TTL_MS,
      }),
    ).toBeUndefined();
  });

  it("separates and explicitly clears account catalogs", () => {
    writeCachedCodexModelCatalog({ accountId: "account-1", models });
    writeCachedCodexModelCatalog({ accountId: "account-2", models });
    clearCachedCodexModelCatalog({ accountId: "account-1" });
    expect(
      readCachedCodexModelCatalog({ accountId: "account-1" }),
    ).toBeUndefined();
    expect(
      readCachedCodexModelCatalog({ accountId: "account-2" })?.models,
    ).toEqual(models);
  });
});
