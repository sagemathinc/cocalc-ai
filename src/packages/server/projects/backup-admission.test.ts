import {
  computeHostAvailableBackupSlots,
  selectBackupClaimCandidateIds,
} from "./backup-admission";

describe("backup admission helpers", () => {
  it("uses the larger of host-visible and hub-visible load per host", () => {
    const available = computeHostAvailableBackupSlots({
      hostStatuses: [
        {
          host_id: "host-a",
          max_parallel: 10,
          in_flight: 3,
          queued: 2,
          project_lock_count: 4,
        },
        {
          host_id: "host-b",
          max_parallel: 4,
          in_flight: 1,
          queued: 0,
          project_lock_count: 1,
        },
      ],
      freshRunningCounts: new Map([
        ["host-a", 4],
        ["host-b", 3],
      ]),
    });

    expect(available.get("host-a")).toBe(5);
    expect(available.get("host-b")).toBe(1);
  });

  it("falls back to configured host limits when host-local status is unavailable", () => {
    const available = computeHostAvailableBackupSlots({
      hostStatuses: [
        {
          host_id: "host-a",
          max_parallel: 10,
          in_flight: 3,
          queued: 0,
          project_lock_count: 2,
        },
      ],
      freshRunningCounts: new Map([
        ["host-a", 4],
        ["host-b", 2],
      ]),
      fallbackMaxParallelByHost: new Map([["host-b", 6]]),
    });

    expect(available.get("host-a")).toBe(6);
    expect(available.get("host-b")).toBe(4);
  });

  it("selects queued candidates without oversubscribing any host", () => {
    const selected = selectBackupClaimCandidateIds({
      candidates: [
        { op_id: "op-1", host_id: "host-a" },
        { op_id: "op-2", host_id: "host-a" },
        { op_id: "op-3", host_id: "host-b" },
        { op_id: "op-4", host_id: "host-b" },
        { op_id: "op-5", host_id: null },
      ],
      availableByHost: new Map([
        ["host-a", 1],
        ["host-b", 2],
      ]),
      limit: 4,
    });

    expect(selected).toEqual(["op-1", "op-3", "op-4"]);
  });
});
