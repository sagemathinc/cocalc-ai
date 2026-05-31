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

  beforeEach(() => {
    process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = "observe";
    recordManagedProjectCpuUsageMock.mockReset();
    recordManagedProjectCpuUsageMock.mockResolvedValue({ recorded: true });
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-05-30T10:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    process.env.COCALC_PROJECT_HOST_CPU_USAGE_MODE = originalMode;
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

  it("collects CPU samples from running project containers", async () => {
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
      readFileFn: jest.fn().mockImplementation(async (path: string) => {
        if (path === "/proc/1234/cgroup") {
          return "0::/machine.slice/libpod-ctr-1.scope\n";
        }
        if (
          path === "/sys/fs/cgroup/machine.slice/libpod-ctr-1.scope/cpu.stat"
        ) {
          return "usage_usec 2000000\n";
        }
        throw new Error(`unexpected path: ${path}`);
      }),
    });

    expect(sample).toEqual([
      {
        project_id: "11111111-1111-4111-8111-111111111111",
        container_id: "ctr-1",
        pid: 1234,
        runtime_key: "ctr-1:v2:/machine.slice/libpod-ctr-1.scope",
        cgroup_version: "v2",
        cgroup_path: "/machine.slice/libpod-ctr-1.scope",
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
