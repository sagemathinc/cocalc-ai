/** @jest-environment jsdom */

describe("lite codex payment source labels", () => {
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
