/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

const updateComputeVm = jest.fn(async (_id: string, patch: any) => ({
  ...baseVm,
  ...patch,
}));
const updateComputeInstance = jest.fn(async () => undefined);
const appendComputeEvent = jest.fn(async () => undefined);
const enqueueComputeWork = jest.fn(async () => undefined);

jest.mock("./db", () => ({
  ...jest.requireActual("./db"),
  updateComputeVm: (...args: any[]) => (updateComputeVm as any)(...args),
  updateComputeInstance: (...args: any[]) =>
    (updateComputeInstance as any)(...args),
  appendComputeEvent: (...args: any[]) => (appendComputeEvent as any)(...args),
  enqueueComputeWork: (...args: any[]) => (enqueueComputeWork as any)(...args),
}));

import { stopForNebiusSpotPrice, stopWorkKeepsError } from "./worker";

const baseVm = {
  id: "11111111-1111-4111-8111-111111111111",
  provider: "nebius",
  state: "ready",
  desired_state: "running",
  desired_pricing_model: "spot",
  effective_pricing_model: "spot",
  instance_generation: 3,
  spot_recovery_state: { phase: "idle" },
  error: null,
} as any;

describe("Nebius Spot price stops (#684)", () => {
  beforeEach(() => {
    updateComputeVm.mockClear();
    updateComputeInstance.mockClear();
    appendComputeEvent.mockClear();
    enqueueComputeWork.mockClear();
  });

  it("stops the VM for the user, with the reason, and never restarts it", async () => {
    await stopForNebiusSpotPrice(baseVm, "2.400", { status: "stopped" });
    expect(updateComputeVm).toHaveBeenCalledWith(
      baseVm.id,
      expect.objectContaining({
        desired_state: "stopped",
        state: "stopping",
        public_ip: null,
        spot_recovery_state: { phase: "idle" },
        error: expect.stringContaining("$2.400 per GPU-hour"),
      }),
    );
    expect(updateComputeInstance).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        preempted: true,
        terminal_reason: "provider_spot_price_above_max",
      }),
    );
    expect(appendComputeEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "spot_price_stop",
        details: expect.objectContaining({ max_price_per_gpu_hour: "2.400" }),
      }),
    );
    // only a stop is queued: no start, provision or spot retry
    expect(enqueueComputeWork).toHaveBeenCalledTimes(1);
    const work = (enqueueComputeWork.mock.calls[0] as any)[0];
    expect(work.action).toBe("stop");
    expect(stopWorkKeepsError(work.idempotency_key)).toBe(true);
  });

  it("keeps the error only for a price stop's stop work", () => {
    expect(
      stopWorkKeepsError("spot-price-stop:vm:3:2026-11-05T00:00:00Z"),
    ).toBe(true);
    for (const key of ["billing-stop:vm:x", "course-stop:vm", "", undefined]) {
      expect(stopWorkKeepsError(key)).toBe(false);
    }
  });
});
