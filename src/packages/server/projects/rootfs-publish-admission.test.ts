import {
  computeAvailableRootfsPublishHostSlots,
  selectRootfsPublishClaimCandidates,
} from "./rootfs-publish-admission";

describe("rootfs publish admission", () => {
  it("computes host-local available slots", () => {
    expect(
      computeAvailableRootfsPublishHostSlots({
        runningCounts: new Map([
          ["host-a", 1],
          ["host-b", 3],
        ]),
        limitByHost: new Map([
          ["host-a", 2],
          ["host-b", 2],
          ["host-c", 1],
        ]),
      }),
    ).toEqual(
      new Map([
        ["host-a", 1],
        ["host-b", 0],
        ["host-c", 1],
      ]),
    );
  });

  it("selects candidates without exceeding host-local slots", () => {
    expect(
      selectRootfsPublishClaimCandidates({
        candidates: [
          { op_id: "op-a", project_host_id: "host-a" },
          { op_id: "op-b", project_host_id: "host-a" },
          { op_id: "op-c", project_host_id: "host-b" },
          { op_id: "op-d", project_host_id: null },
        ],
        availableByHost: new Map([
          ["host-a", 1],
          ["host-b", 2],
        ]),
        limit: 3,
      }),
    ).toEqual([
      { op_id: "op-a", project_host_id: "host-a" },
      { op_id: "op-c", project_host_id: "host-b" },
    ]);
  });
});
