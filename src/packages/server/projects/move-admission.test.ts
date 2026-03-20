import {
  computeAvailableMoveHostSlots,
  selectMoveClaimCandidates,
} from "./move-admission";

describe("move admission helpers", () => {
  it("computes available source or destination slots from running load", () => {
    const available = computeAvailableMoveHostSlots({
      runningCounts: new Map([
        ["host-a", 1],
        ["host-b", 3],
      ]),
      limitByHost: new Map([
        ["host-a", 2],
        ["host-b", 3],
        ["host-c", 1],
      ]),
    });

    expect(available).toEqual(
      new Map([
        ["host-a", 1],
        ["host-b", 0],
        ["host-c", 1],
      ]),
    );
  });

  it("selects only candidates that fit both source and destination caps", () => {
    const selected = selectMoveClaimCandidates({
      candidates: [
        {
          op_id: "op-1",
          source_host_id: "host-a",
          dest_host_id: "host-b",
          project_region: "us-west-1",
        },
        {
          op_id: "op-2",
          source_host_id: "host-a",
          dest_host_id: "host-c",
          project_region: "us-west-1",
        },
        {
          op_id: "op-3",
          source_host_id: "host-d",
          dest_host_id: "host-c",
          project_region: "us-west-1",
        },
      ],
      sourceAvailableByHost: new Map([
        ["host-a", 1],
        ["host-d", 1],
      ]),
      destAvailableByHost: new Map([
        ["host-b", 1],
        ["host-c", 1],
      ]),
      activeDestinationHosts: [],
      limit: 3,
    });

    expect(selected).toEqual([
      {
        op_id: "op-1",
        source_host_id: "host-a",
        dest_host_id: "host-b",
      },
      {
        op_id: "op-3",
        source_host_id: "host-d",
        dest_host_id: "host-c",
      },
    ]);
  });

  it("assigns an available destination host when the move did not specify one", () => {
    const selected = selectMoveClaimCandidates({
      candidates: [
        {
          op_id: "op-1",
          source_host_id: "host-a",
          dest_host_id: null,
          project_region: "us-west-1",
        },
        {
          op_id: "op-2",
          source_host_id: "host-b",
          dest_host_id: null,
          project_region: "eu-central-1",
        },
      ],
      sourceAvailableByHost: new Map([
        ["host-a", 1],
        ["host-b", 1],
      ]),
      destAvailableByHost: new Map([
        ["host-c", 2],
        ["host-d", 1],
      ]),
      activeDestinationHosts: [
        { host_id: "host-a", project_region: "us-west-1" },
        { host_id: "host-c", project_region: "us-west-1" },
        { host_id: "host-d", project_region: "eu-central-1" },
      ],
      limit: 2,
    });

    expect(selected).toEqual([
      {
        op_id: "op-1",
        source_host_id: "host-a",
        dest_host_id: "host-c",
      },
      {
        op_id: "op-2",
        source_host_id: "host-b",
        dest_host_id: "host-d",
      },
    ]);
  });
});
