/** @jest-environment jsdom */

import { getProjectDefaultsItems } from "../membership-status";

describe("membership status project defaults", () => {
  it("hides zero dedicated cpu and member hosting while relabeling shared cpu", () => {
    expect(
      getProjectDefaultsItems({
        cores: 2,
        cpu_shares: 0,
        member_host: 1,
        always_running: 1,
      }),
    ).toEqual([
      {
        key: "cores",
        label: "CPU priority",
        value: "Shared CPU - 2 core",
      },
      {
        key: "always_running",
        label: "Always running",
        value: "Included",
      },
    ]);
  });
});
