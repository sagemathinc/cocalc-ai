import {
  choosePlacementHostRow,
  hostPlacementPressureRank,
  immediateStartReplacementReason,
  shouldSkipStartForSnapshot,
} from "./control";
import { hostIoPlacementConformant } from "./placement";

describe("shouldSkipStartForSnapshot", () => {
  const nowMs = Date.UTC(2026, 2, 19, 12, 0, 0);

  it("skips while a start lro is active", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        timeMs: nowMs - 60_000,
        hasActiveStartLro: true,
        nowMs,
      }),
    ).toEqual({
      skip: true,
      reason: "active-start-lro",
    });
  });

  it("skips for a recent starting state", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        timeMs: nowMs - 60_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: true,
      reason: "recent-starting-state",
    });
  });

  it("does not skip a stale starting state without an active lro", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        timeMs: nowMs - 10 * 60_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: false,
    });
  });

  it("does not skip a starting state with no timestamp and no active lro", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "starting",
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: false,
    });
  });

  it("skips a recent running state", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "running",
        timeMs: nowMs - 30_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: true,
      reason: "recent-running-state",
    });
  });

  it("does not skip a stale running state", () => {
    expect(
      shouldSkipStartForSnapshot({
        state: "running",
        timeMs: nowMs - 5 * 60_000,
        hasActiveStartLro: false,
        nowMs,
      }),
    ).toEqual({
      skip: false,
    });
  });
});

describe("immediateStartReplacementReason", () => {
  it("lets a tracked user start supersede untracked restart recovery", () => {
    expect(
      immediateStartReplacementReason({ requested_op_id: "user-op" }),
    ).toBe("untracked-start");
  });

  it("supersedes recovery from a replaced project-host process", () => {
    expect(
      immediateStartReplacementReason({
        existing_host_session_id: "old-session",
        requested_host_session_id: "new-session",
      }),
    ).toBe("host-session-changed");
  });

  it("continues sharing a start within one project-host session", () => {
    expect(
      immediateStartReplacementReason({
        existing_host_session_id: "same-session",
        requested_host_session_id: "same-session",
      }),
    ).toBeUndefined();
  });
});

describe("host placement pressure helpers", () => {
  it("only requires validated I/O containment after enforcement is explicit", () => {
    expect(hostIoPlacementConformant({ id: "old-host" })).toBe(true);
    expect(
      hostIoPlacementConformant({
        id: "observe-host",
        metadata: {
          metrics: {
            current: {
              io_containment: {
                policy_mode: "observe",
                capability: "unsupported",
              },
            },
          },
        },
      }),
    ).toBe(true);
    expect(
      hostIoPlacementConformant({
        id: "broken-enforce-host",
        metadata: {
          metrics: {
            current: {
              io_containment: {
                policy_mode: "enforce",
                capability: "unsupported",
              },
            },
          },
        },
      }),
    ).toBe(false);
    expect(
      hostIoPlacementConformant({
        id: "validated-enforce-host",
        metadata: {
          metrics: {
            current: {
              io_containment: {
                policy_mode: "enforce",
                capability: "validated",
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("ranks calmer pressure zones ahead of stressed ones", () => {
    expect(hostPlacementPressureRank("normal")).toBeLessThan(
      hostPlacementPressureRank("observe"),
    );
    expect(hostPlacementPressureRank("observe")).toBeLessThan(
      hostPlacementPressureRank("pressure"),
    );
    expect(hostPlacementPressureRank("pressure")).toBeLessThan(
      hostPlacementPressureRank("emergency"),
    );
  });

  it("chooses a normal host before pressured hosts", () => {
    const selected = choosePlacementHostRow(
      [
        {
          id: "host-pressure",
          metadata: { pressure: { zone: "pressure" } },
        },
        {
          id: "host-normal",
          metadata: { pressure: { zone: "normal" } },
        },
        {
          id: "host-observe",
          metadata: { pressure: { zone: "observe" } },
        },
      ],
      () => 0,
    );
    expect(selected?.id).toBe("host-normal");
  });

  it("prefers a host that already cached the requested RootFS", () => {
    const observed_at = new Date().toISOString();
    const selected = choosePlacementHostRow(
      [
        {
          id: "host-cache-miss",
          metadata: {
            pressure: { zone: "normal" },
            placement: {
              observed_at,
              cached_rootfs_images: ["cocalc.local/rootfs/other"],
            },
          },
        },
        {
          id: "host-cache-hit",
          metadata: {
            pressure: { zone: "normal" },
            placement: {
              observed_at,
              cached_rootfs_images: ["cocalc.local/rootfs/python"],
            },
          },
        },
      ],
      () => 0,
      undefined,
      "cocalc.local/rootfs/python",
    );
    expect(selected?.id).toBe("host-cache-hit");
  });

  it("does not send a project to a cache hit with a backed-up start queue", () => {
    const observed_at = new Date().toISOString();
    const selected = choosePlacementHostRow(
      [
        {
          id: "host-busy-cache-hit",
          metadata: {
            pressure: { zone: "normal" },
            metrics: { current: { starting_project_count: 3 } },
            placement: {
              observed_at,
              cached_rootfs_images: ["cocalc.local/rootfs/python"],
            },
          },
        },
        {
          id: "host-idle-cache-miss",
          metadata: {
            pressure: { zone: "normal" },
            metrics: { current: { starting_project_count: 0 } },
            placement: {
              observed_at,
              cached_rootfs_images: [],
            },
          },
        },
      ],
      () => 0,
      undefined,
      "cocalc.local/rootfs/python",
    );
    expect(selected?.id).toBe("host-idle-cache-miss");
  });

  it("falls back to the least stressed remaining host class", () => {
    const selected = choosePlacementHostRow(
      [
        {
          id: "host-emergency",
          metadata: { pressure: { zone: "emergency" } },
        },
        {
          id: "host-observe",
          metadata: { pressure: { zone: "observe" } },
        },
        {
          id: "host-pressure",
          metadata: { pressure: { zone: "pressure" } },
        },
      ],
      () => 0,
    );
    expect(selected?.id).toBe("host-observe");
  });

  it("never chooses hosts quarantined by runtime or public-route probes", () => {
    const selected = choosePlacementHostRow(
      [
        {
          id: "runtime-quarantined",
          metadata: {
            pressure: { zone: "normal" },
            runtime_synthetic_probe: { quarantined: true },
          },
        },
        {
          id: "route-quarantined",
          metadata: {
            pressure: { zone: "normal" },
            public_route_probe: { quarantined: true },
          },
        },
        {
          id: "healthy",
          metadata: { pressure: { zone: "observe" } },
        },
      ],
      () => 0,
    );
    expect(selected?.id).toBe("healthy");
  });

  it("never chooses a host with unvalidated explicit I/O enforcement", () => {
    const selected = choosePlacementHostRow(
      [
        {
          id: "broken-enforce-host",
          metadata: {
            metrics: {
              current: {
                io_containment: {
                  policy_mode: "enforce",
                  capability: "unsupported",
                },
              },
            },
          },
        },
        {
          id: "healthy-host",
          metadata: { pressure: { zone: "observe" } },
        },
      ],
      () => 0,
    );
    expect(selected?.id).toBe("healthy-host");
  });

  it("returns no placement when every candidate is quarantined", () => {
    expect(
      choosePlacementHostRow(
        [
          {
            id: "route-quarantined",
            metadata: { public_route_probe: { quarantined: true } },
          },
        ],
        () => 0,
      ),
    ).toBeUndefined();
  });

  it("filters placement candidates to the project's region before ranking by pressure", () => {
    const selected = choosePlacementHostRow(
      [
        {
          id: "host-wrong-region",
          region: "europe-west12",
          metadata: { pressure: { zone: "normal" } },
        },
        {
          id: "host-right-region",
          region: "us-west3",
          metadata: { pressure: { zone: "observe" } },
        },
      ],
      () => 0,
      "wnam",
    );
    expect(selected?.id).toBe("host-right-region");
  });
});
