import {
  maxStandardRuntimeMs,
  normalizeSpotRecoveryPolicy,
  normalizeSpotRecoveryState,
  rapidPreemptionStandardHoldMs,
  rapidPreemptionWindowMs,
  recordProviderSpotPreemption,
  shouldAutoRestoreInterruptedSpotHost,
  standardFallbackProbeNotBeforeMs,
} from "./spot-restore";

describe("spot recovery metadata", () => {
  it("bounds fallback runtime to 24 hours by default", () => {
    expect(maxStandardRuntimeMs({})).toBe(24 * 60 * 60 * 1000);
  });

  it("holds standard capacity for 24 hours after two preemptions within four hours", () => {
    expect(rapidPreemptionWindowMs({})).toBe(4 * 60 * 60 * 1000);
    expect(rapidPreemptionStandardHoldMs({})).toBe(24 * 60 * 60 * 1000);

    const now = new Date("2026-07-28T14:34:17.613Z");
    const result = recordProviderSpotPreemption({
      state: {
        phase: "idle",
        last_preempted_at: "2026-07-28T12:41:00.000Z",
      },
      policy: {},
      now,
    });

    expect(result.circuit_breaker_triggered).toBe(true);
    expect(result.recorded).toBe(true);
    expect(result.state).toMatchObject({
      last_preempted_at: now.toISOString(),
      standard_hold_until: "2026-07-29T14:34:17.613Z",
    });
    expect(
      standardFallbackProbeNotBeforeMs({
        state: {
          ...result.state,
          fallback_started_at: now.toISOString(),
        },
        policy: {},
        now,
      }),
    ).toBe(new Date("2026-07-29T14:34:17.613Z").getTime());
  });

  it("does not open the circuit breaker after an isolated preemption", () => {
    const result = recordProviderSpotPreemption({
      state: {
        phase: "idle",
        last_preempted_at: "2026-07-28T09:00:00.000Z",
      },
      policy: {},
      now: new Date("2026-07-28T14:34:17.613Z"),
    });

    expect(result.circuit_breaker_triggered).toBe(false);
    expect(result.recorded).toBe(true);
    expect(result.state.standard_hold_until).toBeUndefined();
  });

  it("starts each new outage with a fresh retry budget", () => {
    // Seen on prod: attempt 12 survived from an earlier recovery, so the next
    // preemption skipped Spot entirely as "retry-window-exhausted".
    const result = recordProviderSpotPreemption({
      state: {
        phase: "idle",
        attempt: 12,
        outage_started_at: "2026-10-03T02:33:00.000Z",
        last_recovered_at: "2026-10-03T03:02:00.000Z",
        machine_type_attempt_started_at: "2026-10-03T02:59:00.000Z",
        spot_machine_types_tried: ["t2d-standard-16"],
        fallback_started_at: "2026-10-03T02:33:00.000Z",
        active_machine_type: "t2d-standard-16",
        last_preempted_at: "2026-10-03T02:32:00.000Z",
        last_probe_result: "success",
      },
      policy: {},
      now: new Date("2026-10-08T12:53:51.985Z"),
    });

    expect(result.recorded).toBe(true);
    expect(result.state).toEqual({
      phase: "idle",
      active_machine_type: "t2d-standard-16",
      last_preempted_at: "2026-10-08T12:53:51.985Z",
      last_probe_result: "success",
    });
  });

  it("does not count the same active outage twice", () => {
    const state = {
      phase: "retrying_spot" as const,
      last_preempted_at: "2026-07-28T14:34:17.613Z",
    };
    const result = recordProviderSpotPreemption({
      state,
      policy: {},
      now: new Date("2026-07-28T14:35:00.000Z"),
    });

    expect(result).toEqual({
      state,
      recorded: false,
      circuit_breaker_triggered: false,
    });
  });

  it("advances from a repeatedly interrupted Spot machine type by default", () => {
    expect(
      normalizeSpotRecoveryPolicy({})?.max_restore_attempts_before_fallback,
    ).toBe(2);
  });

  it("normalizes configured alternate machine types", () => {
    expect(
      normalizeSpotRecoveryPolicy({
        alternate_spot_machine_types: [
          " n2d-standard-16 ",
          "n2d-standard-16",
          "",
        ],
      })?.alternate_spot_machine_types,
    ).toEqual(["n2d-standard-16"]);
  });

  it("preserves the active machine type and attempted candidates", () => {
    expect(
      normalizeSpotRecoveryState({
        phase: "retrying_spot",
        active_machine_type: "n2d-standard-16",
        machine_type_attempt_started_at: "2026-07-15T19:00:00.000Z",
        last_preempted_at: "2026-07-15T18:59:00.000Z",
        standard_hold_until: "2026-07-16T18:59:00.000Z",
        spot_machine_types_tried: [
          "t2d-standard-16",
          "n2d-standard-16",
          "n2d-standard-16",
        ],
      }),
    ).toMatchObject({
      active_machine_type: "n2d-standard-16",
      machine_type_attempt_started_at: "2026-07-15T19:00:00.000Z",
      last_preempted_at: "2026-07-15T18:59:00.000Z",
      standard_hold_until: "2026-07-16T18:59:00.000Z",
      spot_machine_types_tried: ["t2d-standard-16", "n2d-standard-16"],
    });
  });
});

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
