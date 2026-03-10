/** @jest-environment jsdom */

describe("codex default session mode", () => {
  afterEach(() => {
    jest.resetModules();
    jest.dontMock("@cocalc/frontend/lite");
    jest.dontMock("@cocalc/frontend/app-framework");
  });

  it("defaults new non-lite launchpad threads to full-access", () => {
    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: false,
    }));
    jest.doMock("@cocalc/frontend/app-framework", () => ({
      redux: {
        getStore: (name: string) =>
          name === "customize"
            ? {
                get: (key: string) =>
                  key === "is_launchpad" ? true : undefined,
              }
            : undefined,
      },
    }));

    const { getDefaultCodexSessionMode } = require("../codex-defaults");

    expect(getDefaultCodexSessionMode()).toBe("full-access");
  });
});
