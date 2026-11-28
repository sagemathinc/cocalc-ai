import {
  completeScan,
  isSideContainerName,
  serialRunner,
  pastaBinaries,
  stopLeftoverSideContainers,
} from "./runtime-uid-monitor";

const P = "11111111-2222-4333-8444-555555555555";

describe("side containers left from an earlier mode", () => {
  it("names every side launcher's containers, and never a project's", () => {
    for (const name of [
      `acp-${P}-x`,
      `claude-controller-${P}-x`,
      `codex-${P}-abc`,
      `sandbox-${P}-1-ab`,
      "cocalc-rootfs-scan-1",
      `cocalc-browser-${P}`,
    ])
      expect([name, isSideContainerName(name)]).toEqual([name, true]);
    for (const name of [`project-${P}`, "something-else", ""])
      expect([name, isSideContainerName(name)]).toEqual([name, false]);
  });

  it("removes the side containers only, and carries on past a failure", async () => {
    const removed: string[] = [];
    const stopped = await stopLeftoverSideContainers({
      list: async () =>
        [`project-${P}`, `codex-${P}-a`, `acp-${P}-b`, "other"].join("\n"),
      remove: async (name) => {
        if (name.startsWith("codex-")) throw Error("busy");
        removed.push(name);
      },
    });
    expect(removed).toEqual([`acp-${P}-b`]);
    expect(stopped).toEqual([`acp-${P}-b`]);
  });
});

describe("pasta's binaries", () => {
  it("trusts pasta and passt, each build, in the runtime bundle only", () => {
    expect(pastaBinaries("/r")).toEqual([
      "/r/bin/passt",
      "/r/bin/passt.avx2",
      "/r/bin/passt.avx512",
      "/r/bin/pasta",
      "/r/bin/pasta.avx2",
      "/r/bin/pasta.avx512",
    ]);
    expect(pastaBinaries("")).toEqual([]);
  });
});

describe("serialRunner (the monitor's scans)", () => {
  it("never overlaps runs, and a request during a run gets one run after it", async () => {
    const order: string[] = [];
    let active = 0;
    let n = 0;
    const releases: (() => void)[] = [];
    const run = serialRunner(async () => {
      const id = ++n;
      active++;
      expect(active).toBe(1);
      order.push(`start ${id}`);
      await new Promise<void>((resolve) => releases.push(resolve));
      order.push(`end ${id}`);
      active--;
    });
    const first = run();
    const second = run();
    const third = run(); // coalesced with the second
    expect(second).toBe(third);
    await Promise.resolve();
    releases.shift()!();
    await first;
    await new Promise((r) => setImmediate(r));
    releases.shift()!();
    await second;
    expect(order).toEqual(["start 1", "end 1", "start 2", "end 2"]);
    expect(n).toBe(2);
  });

  it("an older scan can't finish after a newer one", async () => {
    // results land in the order the runs started, one at a time
    const results: number[] = [];
    let n = 0;
    const delays = [30, 1];
    const run = serialRunner(async () => {
      const id = n++;
      await new Promise((r) => setTimeout(r, delays[id] ?? 0));
      results.push(id);
    });
    await Promise.all([run(), run()]);
    expect(results).toEqual([0, 1]);
  });
});

describe("completeScan", () => {
  const scanOf = (
    results: { violations: number | null; unknown: number }[],
  ) => {
    let i = 0;
    return jest.fn(async () => ({
      invariant: "x",
      partial: 0,
      old_mode_containers: 0,
      checked_at: `t${i}`,
      ...results[Math.min(i++, results.length - 1)],
    }));
  };
  it("rescans while processes vanished mid-scan, up to a limit", async () => {
    const scan = scanOf([
      { violations: 0, unknown: 2 },
      { violations: 0, unknown: 0 },
    ]);
    expect(await completeScan(scan, { pauseMs: 0 })).toMatchObject({
      unknown: 0,
      scans: 2,
      unknown_before: [2],
    });
    expect(scan).toHaveBeenCalledTimes(2);
    const stuck = scanOf([{ violations: 0, unknown: 1 }]);
    expect(await completeScan(stuck, { pauseMs: 0 })).toMatchObject({
      unknown: 1,
    });
    expect(stuck).toHaveBeenCalledTimes(3);
  });
  it("reports violations at once, never retrying them away", async () => {
    const scan = scanOf([
      { violations: 1, unknown: 1 },
      { violations: 0, unknown: 0 },
    ]);
    expect(await completeScan(scan, { pauseMs: 0 })).toMatchObject({
      violations: 1,
      scans: 1,
    });
    expect(scan).toHaveBeenCalledTimes(1);
  });
});
