import { formatHostUpgradeFailureMessage } from "./host-upgrade-errors";

describe("formatHostUpgradeFailureMessage", () => {
  it("includes the host name when available", () => {
    expect(
      formatHostUpgradeFailureMessage({
        hostName: "gpu-a100",
        err: new Error("permission denied"),
      }),
    ).toBe('Unable to upgrade software on host "gpu-a100": permission denied');
  });

  it("falls back to a generic prefix without a host name", () => {
    expect(
      formatHostUpgradeFailureMessage({
        err: "request timed out",
      }),
    ).toBe("Unable to upgrade host software: request timed out");
  });
});
