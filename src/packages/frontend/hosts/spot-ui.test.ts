import { hostMachineFallback, hostMachineFallbackLabel } from "./spot-ui";

describe("hostMachineFallback", () => {
  const spotHost = (state: Record<string, any>, extra = {}) => ({
    desired_pricing_model: "spot",
    effective_pricing_model: "spot",
    machine: { machine_type: "t2d-standard-16" },
    spot_recovery_state: { phase: "idle", ...state },
    ...extra,
  });

  it("shows a Spot alternate even though recovery is idle", () => {
    const fallback = hostMachineFallback(
      spotHost({
        active_machine_type: "n2d-custom-32-65536",
        machine_type_attempt_started_at: "2026-11-12T03:00:00.000Z",
        fallback_started_at: "2026-11-01T00:00:00.000Z",
      }),
    );
    expect(fallback).toEqual({
      kind: "spot_alternate",
      desired_machine_type: "t2d-standard-16",
      active_machine_type: "n2d-custom-32-65536",
      since: "2026-11-12T03:00:00.000Z",
    });
    expect(hostMachineFallbackLabel(fallback!)).toMatch(
      /^Running n2d-custom-32-65536 instead of t2d-standard-16 on Spot \(spot fallback since .+\)$/,
    );
  });

  it("shows Standard fallback, on the desired or another type", () => {
    const standard = spotHost(
      {
        phase: "running_standard_fallback",
        fallback_started_at: "2026-11-12T03:00:00.000Z",
      },
      { effective_pricing_model: "on_demand" },
    );
    expect(hostMachineFallback(standard)).toEqual({
      kind: "standard_fallback",
      desired_machine_type: "t2d-standard-16",
      active_machine_type: "t2d-standard-16",
      since: "2026-11-12T03:00:00.000Z",
    });
    expect(hostMachineFallbackLabel(hostMachineFallback(standard)!)).toMatch(
      /^Running t2d-standard-16 on Standard pricing \(spot fallback since .+\)$/,
    );
    const other = spotHost(
      {
        phase: "running_standard_fallback",
        active_machine_type: "c2d-highcpu-32",
      },
      { effective_pricing_model: "on_demand" },
    );
    expect(hostMachineFallbackLabel(hostMachineFallback(other)!)).toBe(
      "Running c2d-highcpu-32 instead of t2d-standard-16 on Standard pricing (spot fallback)",
    );
  });

  it("shows nothing on the desired Spot type or for non-Spot hosts", () => {
    expect(hostMachineFallback(spotHost({}))).toBeUndefined();
    expect(
      hostMachineFallback(spotHost({ active_machine_type: "t2d-standard-16" })),
    ).toBeUndefined();
    expect(
      hostMachineFallback({
        pricing_model: "on_demand",
        machine: { machine_type: "t2d-standard-16" },
        spot_recovery_state: {
          phase: "idle",
          active_machine_type: "n2-standard-32",
        },
      }),
    ).toBeUndefined();
    expect(hostMachineFallback(undefined)).toBeUndefined();
  });
});
