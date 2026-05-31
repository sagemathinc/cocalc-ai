const recordManagedProjectCpuUsageMock = jest.fn();

jest.mock("@cocalc/lite/hub/api", () => ({
  hubApi: {
    system: {
      recordManagedProjectCpuUsage: (...args: any[]) =>
        recordManagedProjectCpuUsageMock(...args),
    },
  },
}));

import {
  __test__,
  collectRunningProjectCpuSamples,
  startManagedCpuUsageLoop,
} from "./cpu-usage";

describe("project-host CPU usage accounting", () => {
  const originalMode = process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE;
  const originalEnabled = process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED;
  const originalClkTck = process.env.COCALC_PROC_CLK_TCK;

  beforeEach(() => {
    process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = "observe";
    process.env.COCALC_PROC_CLK_TCK = "100";
    recordManagedProjectCpuUsageMock.mockReset();
    recordManagedProjectCpuUsageMock.mockResolvedValue({ recorded: true });
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-05-30T10:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    if (originalMode == null) {
      delete process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE;
    } else {
      process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = originalMode;
    }
    if (originalEnabled == null) {
      delete process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED;
    } else {
      process.env.COCALC_PROJECT_HOST_CPU_USAGE_ENABLED = originalEnabled;
    }
    if (originalClkTck == null) {
      delete process.env.COCALC_PROC_CLK_TCK;
    } else {
      process.env.COCALC_PROC_CLK_TCK = originalClkTck;
    }
  });

  it("parses cgroup v2 CPU usage seconds", () => {
    expect(
      __test__.parseProcCgroup("0::/machine.slice/libpod-abc.scope\n"),
    ).toEqual({
      version: "v2",
      path: "/machine.slice/libpod-abc.scope",
    });
    expect(
      __test__.cgroupFilePath({
        version: "v2",
        path: "/machine.slice/libpod-abc.scope",
      }),
    ).toBe("/sys/fs/cgroup/machine.slice/libpod-abc.scope/cpu.stat");
    expect(
      __test__.parseCpuSeconds({
        version: "v2",
        content: "usage_usec 1234567\nuser_usec 1200000\n",
      }),
    ).toBeCloseTo(1.234567);
  });

  it("parses cgroup v1 CPU usage seconds", () => {
    expect(
      __test__.parseProcCgroup(
        "2:cpu,cpuacct:/libpod_parent/libpod-abc\n1:name=systemd:/\n",
      ),
    ).toEqual({
      version: "v1",
      path: "/libpod_parent/libpod-abc",
    });
    expect(
      __test__.cgroupFilePath({
        version: "v1",
        path: "/libpod_parent/libpod-abc",
      }),
    ).toBe("/sys/fs/cgroup/cpu,cpuacct/libpod_parent/libpod-abc/cpuacct.usage");
    expect(
      __test__.parseCpuSeconds({
        version: "v1",
        content: "2500000000\n",
      }),
    ).toBe(2.5);
  });

  function procStat({
    pid,
    ppid,
    utime,
    stime,
  }: {
    pid: number;
    ppid: number;
    utime: number;
    stime: number;
  }): string {
    return `${pid} (python) S ${ppid} 0 0 0 0 0 0 0 0 0 ${utime} ${stime} 0 0 20 0 1 0 0\n`;
  }

  it("collects CPU samples from running project process trees", async () => {
    const sample = await collectRunningProjectCpuSamples({
      podmanCommand: jest
        .fn()
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Id: "ctr-1",
              Names: ["project-11111111-1111-4111-8111-111111111111"],
            },
          ]),
        })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              Name: "/project-11111111-1111-4111-8111-111111111111",
              State: { Pid: 1234 },
            },
          ]),
        }),
      readdirFn: jest
        .fn()
        .mockResolvedValue(["1", "1234", "1235", "9999", "self"]),
      readFileFn: jest.fn().mockImplementation(async (path: string) => {
        if (path === "/proc/1/stat") {
          return procStat({ pid: 1, ppid: 0, utime: 10, stime: 0 });
        }
        if (path === "/proc/1234/stat") {
          return procStat({ pid: 1234, ppid: 1, utime: 120, stime: 30 });
        }
        if (path === "/proc/1235/stat") {
          return procStat({ pid: 1235, ppid: 1234, utime: 50, stime: 0 });
        }
        if (path === "/proc/9999/stat") {
          return procStat({ pid: 9999, ppid: 1, utime: 10000, stime: 0 });
        }
        throw new Error(`unexpected path: ${path}`);
      }),
    });

    expect(sample).toEqual([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        container_id: "ctr-1",
        pid: 1234,
        runtime_key: "ctr-1:proc-tree:1234",
        source: "proc-tree",
        cpu_seconds_total: 2,
      },
    ]);
  });

  it("treats the first sample as a baseline and ignores counter resets", () => {
    const current = new Map([
      [
        "runtime-1",
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          container_id: "ctr-1",
          pid: 1234,
          runtime_key: "runtime-1",
          source: "proc-tree" as const,
          cgroup_version: "v2" as const,
          cgroup_path: "/cg",
          cpu_seconds_total: 20,
        },
      ],
    ]);

    expect(
      __test__.summarizeManagedCpuUsageDeltas({
        previous: new Map(),
        current,
      }),
    ).toEqual([]);

    expect(
      __test__.summarizeManagedCpuUsageDeltas({
        previous: current,
        current: new Map([
          [
            "runtime-1",
            {
              ...current.get("runtime-1")!,
              cpu_seconds_total: 5,
            },
          ],
        ]),
      }),
    ).toEqual([]);
  });

  it("records positive CPU deltas when tracking is enabled", async () => {
    const sample = jest
      .fn()
      .mockResolvedValueOnce([
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          container_id: "ctr-1",
          pid: 1234,
          runtime_key: "runtime-1",
          source: "proc-tree",
          cgroup_version: "v2",
          cgroup_path: "/cg",
          cpu_seconds_total: 10,
        },
      ])
      .mockResolvedValueOnce([
        {
          project_id: "11111111-1111-4111-8111-111111111111",
          container_id: "ctr-1",
          pid: 1234,
          runtime_key: "runtime-1",
          source: "proc-tree",
          cgroup_version: "v2",
          cgroup_path: "/cg",
          cpu_seconds_total: 16.5,
        },
      ]);

    const stop = startManagedCpuUsageLoop({
      intervalMs: 1000,
      sample: sample as any,
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(recordManagedProjectCpuUsageMock).not.toHaveBeenCalled();

    jest.setSystemTime(new Date("2026-05-30T10:00:01.000Z"));
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    await Promise.resolve();
    stop();

    expect(recordManagedProjectCpuUsageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        project_id: "11111111-1111-4111-8111-111111111111",
        cpu_seconds: 6.5,
        sample_started_at: new Date("2026-05-30T10:00:00.000Z"),
        sample_ended_at: expect.any(Date),
      }),
    );
  });

  it("does not sample when CPU usage tracking is disabled", async () => {
    process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = "off";
    const sample = jest.fn().mockResolvedValue([]);

    const stop = startManagedCpuUsageLoop({
      intervalMs: 1000,
      sample: sample as any,
    });
    await Promise.resolve();
    jest.advanceTimersByTime(1000);
    await Promise.resolve();
    stop();

    expect(sample).not.toHaveBeenCalled();
    expect(recordManagedProjectCpuUsageMock).not.toHaveBeenCalled();
  });
});
