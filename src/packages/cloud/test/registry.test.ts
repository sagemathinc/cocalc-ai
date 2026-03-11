import { PROVIDERS } from "../registry";

describe("cloud registry", () => {
  it("advertises Hyperstack stop support", () => {
    expect(PROVIDERS.hyperstack?.capabilities.supportsStop).toBe(true);
  });
});
