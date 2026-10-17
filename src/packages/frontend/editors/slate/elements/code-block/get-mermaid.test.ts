const initialize = jest.fn();
jest.mock("mermaid", () => ({
  __esModule: true,
  default: { initialize },
}));

import getMermaid from "./get-mermaid";

describe("getMermaid", () => {
  it("initializes mermaid once, in strict mode that diagrams cannot override", async () => {
    await getMermaid();
    await getMermaid();
    expect(initialize).toHaveBeenCalledTimes(1);
    const config = initialize.mock.calls[0][0];
    expect(config.securityLevel).toBe("strict");
    expect(config.secure).toEqual(
      expect.arrayContaining(["secure", "securityLevel"]),
    );
  });
});
