/** @jest-environment jsdom */

import { getProjectDefaultsItems } from "../membership-status";

describe("membership status project defaults", () => {
  it("shows only cocalc-ai project runtime defaults", () => {
    expect(
      getProjectDefaultsItems({
        memory: 8000,
        memory_request: 4000,
        disk_quota: 10000,
        cores: 2,
        cpu_shares: 0,
        network: 1,
        member_host: 1,
      }),
    ).toEqual([
      {
        key: "memory",
        label: "Project RAM",
        value: "8 GB",
      },
      {
        key: "memory_request",
        label: "Project requested RAM",
        value: "4 GB",
      },
      {
        key: "disk_quota",
        label: "Per-project disk quota",
        value: "10 GB",
      },
    ]);
  });
});
