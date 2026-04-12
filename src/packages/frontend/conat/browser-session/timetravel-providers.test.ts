jest.mock("@cocalc/frontend/lite", () => ({
  lite: false,
}));

import { getBrowserTimeTravelProviders } from "./timetravel-providers";

describe("getBrowserTimeTravelProviders", () => {
  it("disables backups in lite mode even when hub stubs exist", async () => {
    jest.resetModules();
    jest.doMock("@cocalc/frontend/lite", () => ({
      lite: true,
    }));
    const { getBrowserTimeTravelProviders } =
      await import("./timetravel-providers");

    expect(getBrowserTimeTravelProviders()).toEqual({
      patchflow: true,
      snapshots: true,
      backups: false,
      git: true,
    });
  });

  it("enables backups outside lite mode when both backup APIs exist", () => {
    expect(getBrowserTimeTravelProviders()).toEqual({
      patchflow: true,
      snapshots: true,
      backups: true,
      git: true,
    });
  });
});
