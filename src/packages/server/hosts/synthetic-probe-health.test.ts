const mockQuery = jest.fn();

jest.mock("@cocalc/database/pool", () => ({
  __esModule: true,
  default: () => ({ query: (...args: any[]) => mockQuery(...args) }),
}));
jest.mock("@cocalc/server/bay-config", () => ({
  getConfiguredBayId: () => "bay-0",
}));
jest.mock("./runtime-maintenance", () => ({
  syntheticProbeOverdueAfterMs: () => 45 * 60_000,
}));

import {
  listHostSyntheticProbes,
  syntheticSmokeHealth,
} from "./synthetic-probe-health";

const now = Date.parse("2026-10-29T19:00:00Z");
const minutesAgo = (m: number) => new Date(now - m * 60_000).toISOString();

function host(name: string, probe: Record<string, any> | undefined) {
  return {
    id: `00000000-0000-4000-8000-${name.length.toString().padStart(12, "0")}`,
    name,
    metadata: { runtime_synthetic_probe: probe },
  };
}
const passed = (m: number) => ({ status: "passed", checked_at: minutesAgo(m) });

function adminSmoke(status: "succeeded" | "failed", finishedMinutesAgo: number) {
  return {
    id: "smoke-1",
    project_id: "00000000-0000-4000-8000-000000000001",
    status,
    started_at: minutesAgo(finishedMinutesAgo + 1),
    finished_at: minutesAgo(finishedMinutesAgo),
    duration_ms: 42_000,
    steps: [
      {
        label: "start",
        status: "succeeded",
        duration_ms: 5_000,
        summary: "project started",
      },
    ],
    error: null,
  } as any;
}

describe("syntheticSmokeHealth", () => {
  it("is healthy when every running host's probe passed recently, even with an old admin smoke", () => {
    const health = syntheticSmokeHealth({
      smoke: adminSmoke("succeeded", 22 * 24 * 60),
      hosts: [host("asia-1", passed(20)), host("montreal-2", passed(14))],
      now,
    });
    expect(health.level).toBe("healthy");
    expect(health.summary).toContain("Host probes: 2/2 passing.");
    expect(health.summary).toContain("older than 1 hour");
  });

  it("counts a probe that is running now as current", () => {
    expect(
      syntheticSmokeHealth({
        hosts: [
          host("oceania-1", { status: "running", claimed_at: minutesAgo(3) }),
        ],
        now,
      }).level,
    ).toBe("healthy");
  });

  it("is healthy with a recent admin smoke and keeps its steps", () => {
    const health = syntheticSmokeHealth({
      smoke: adminSmoke("succeeded", 10),
      hosts: [],
      now,
    });
    expect(health.level).toBe("healthy");
    expect(health.details).toContain(
      "Admin smoke start: succeeded in 5.0s (project started)",
    );
  });

  it("is critical when a host's probe fails, naming the host", () => {
    const health = syntheticSmokeHealth({
      smoke: adminSmoke("succeeded", 10),
      hosts: [
        host("asia-1", passed(5)),
        host("los-angeles-1", {
          status: "failed",
          checked_at: minutesAgo(2),
          consecutive_failures: 3,
          quarantined: true,
          error: "project did not start",
        }),
      ],
      now,
    });
    expect(health.level).toBe("critical");
    expect(health.summary).toContain("1/2 passing, 1 failing");
    expect(health.details[0]).toMatch(
      /^Host probe failing: los-angeles-1 \(.+\): failed 3 times in a row, quarantined from placement: project did not start$/,
    );
  });

  it("warns about overdue host probes when no admin smoke is current", () => {
    const health = syntheticSmokeHealth({
      smoke: adminSmoke("succeeded", 22 * 24 * 60),
      hosts: [
        host("asia-1", passed(5)),
        host("asia-3", passed(50)),
        host("new-host", undefined),
        host("stuck", { status: "running", claimed_at: minutesAgo(60) }),
      ],
      now,
    });
    expect(health.level).toBe("warning");
    expect(health.summary).toContain(
      "1/4 passing, 3 overdue (none within 45 min)",
    );
    expect(health.details).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Host probe overdue: asia-3 .*last passed 50 min ago$/),
        expect.stringMatching(/^Host probe overdue: new-host .*no synthetic probe result yet$/),
        expect.stringMatching(/^Host probe overdue: stuck .*running for 60 min$/),
      ]),
    );
  });

  it("is healthy with a current admin smoke even if some host probes are overdue", () => {
    expect(
      syntheticSmokeHealth({
        smoke: adminSmoke("succeeded", 10),
        hosts: [host("asia-3", passed(50))],
        now,
      }).level,
    ).toBe("healthy");
  });

  it("is critical after a recent failed admin smoke", () => {
    expect(
      syntheticSmokeHealth({
        smoke: adminSmoke("failed", 10),
        hosts: [host("asia-1", passed(5))],
        now,
      }).level,
    ).toBe("critical");
  });

  it("is unknown with no admin smoke and no probing hosts, critical when nothing can be read", () => {
    expect(syntheticSmokeHealth({ smoke: null, hosts: [], now }).level).toBe(
      "unknown",
    );
    expect(
      syntheticSmokeHealth({
        smokeError: new Error("db down"),
        hostsError: new Error("db down"),
        now,
      }).level,
    ).toBe("critical");
  });
});

describe("listHostSyntheticProbes", () => {
  it("reads running, non-deleted hosts of this bay that run probes", async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await listHostSyntheticProbes();
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain("deleted IS NULL");
    expect(sql).toContain("status='running'");
    expect(sql).toContain("synthetic_probe_supported");
    expect(params).toEqual(["bay-0"]);
  });
});
