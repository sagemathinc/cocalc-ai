import { shouldAutoRestoreInterruptedSpotHost } from "./spot-restore";

describe("shouldAutoRestoreInterruptedSpotHost", () => {
  it("returns true for spot hosts with immediate restore", () => {
    expect(
      shouldAutoRestoreInterruptedSpotHost({
        id: "host-1",
        status: "running",
        metadata: {
          pricing_model: "spot",
          interruption_restore_policy: "immediate",
          desired_state: "running",
          last_action: "start",
          last_action_status: "success",
        },
      }),
    ).toBe(true);
  });

  it("returns false for explicitly stopped spot hosts", () => {
    expect(
      shouldAutoRestoreInterruptedSpotHost({
        id: "host-1",
        status: "off",
        metadata: {
          pricing_model: "spot",
          interruption_restore_policy: "immediate",
          desired_state: "stopped",
        },
      }),
    ).toBe(false);
  });

  it("returns false during intentional maintenance", () => {
    expect(
      shouldAutoRestoreInterruptedSpotHost({
        id: "host-1",
        status: "running",
        metadata: {
          pricing_model: "spot",
          interruption_restore_policy: "immediate",
          desired_state: "running",
          last_action: "upgrade_software",
          last_action_status: "pending",
        },
      }),
    ).toBe(false);
  });

  it("returns false when restore policy is disabled", () => {
    expect(
      shouldAutoRestoreInterruptedSpotHost({
        id: "host-1",
        status: "running",
        metadata: {
          pricing_model: "spot",
          interruption_restore_policy: "none",
        },
      }),
    ).toBe(false);
  });
});
