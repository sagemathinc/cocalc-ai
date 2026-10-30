/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  BeesGate,
  beesGateEnabled,
  DEFAULT_BEES_GATE_CONFIG,
  decideBeesGate,
  parseCommitStats,
  parseIoSomeAverages,
  type BeesGateInputs,
  type BeesGateState,
} from "./bees-gate";

const MIN = 60_000;

// Inputs under which BEES may run: the disk is getting full and all is calm.
const calm: BeesGateInputs = {
  free_fraction: 0.1,
  io_some_avg10: 1,
  io_some_avg60: 1,
  worst_commit_ms: 200,
  lifecycle_active: false,
};

describe("the BEES gate decision", () => {
  const frozenAt = (since_ms: number): BeesGateState => ({
    frozen: true,
    since_ms,
    reason: "test",
  });
  const thawed: BeesGateState = { frozen: false, since_ms: 0, reason: "test" };

  it("thaws only after the minimum frozen time, and only when every condition holds", () => {
    expect(decideBeesGate(frozenAt(0), calm, 9 * MIN).frozen).toBe(true);
    expect(decideBeesGate(frozenAt(0), calm, 10 * MIN)).toMatchObject({
      frozen: false,
      reason: "low_free_space_and_calm",
    });
    for (const blocker of [
      { free_fraction: 0.3 },
      { free_fraction: undefined },
      { io_some_avg60: 6 },
      { worst_commit_ms: 2_500 },
      { worst_commit_ms: undefined },
      { lifecycle_active: true },
    ]) {
      expect(
        decideBeesGate(frozenAt(0), { ...calm, ...blocker }, 60 * MIN).frozen,
      ).toBe(true);
    }
  });

  it("freezes a running BEES on any trigger, at once", () => {
    expect(decideBeesGate(thawed, calm, MIN).frozen).toBe(false);
    for (const [trigger, reason] of [
      [{ lifecycle_active: true }, "lifecycle_active"],
      [{ io_some_avg10: 11 }, "io_pressure"],
      [{ worst_commit_ms: 5_001 }, "slow_commit"],
      [{ free_fraction: 0.26 }, "enough_free_space"],
    ] as const) {
      expect(decideBeesGate(thawed, { ...calm, ...trigger }, MIN)).toEqual({
        frozen: true,
        since_ms: MIN,
        reason,
      });
    }
  });

  it("keeps a running BEES between the thaw and freeze thresholds (hysteresis)", () => {
    expect(
      decideBeesGate(
        thawed,
        {
          ...calm,
          free_fraction: 0.22,
          io_some_avg10: 8,
          worst_commit_ms: 4_000,
        },
        MIN,
      ).frozen,
    ).toBe(false);
  });

  it("uses the agreed defaults", () => {
    expect(DEFAULT_BEES_GATE_CONFIG).toMatchObject({
      thawBelowFreeFraction: 0.2,
      thawMaxIoSomeAvg60: 5,
      thawMaxCommitMs: 2_000,
      minFrozenMs: 10 * MIN,
    });
  });
});

describe("BEES gate inputs", () => {
  it("parses io pressure and commit stats", () => {
    expect(
      parseIoSomeAverages(
        "some avg10=18.52 avg60=12.84 avg300=14.04 total=1\nfull avg10=1.98 avg60=12.10 avg300=13.12 total=2\n",
      ),
    ).toEqual({ avg10: 18.52, avg60: 12.84 });
    expect(
      parseCommitStats(
        "commits 6638\ncur_commit_ms 0\nlast_commit_ms 70\nmax_commit_ms 93743\ntotal_commit_ms 4913183\n",
      ),
    ).toMatchObject({ commits: 6638, cur_commit_ms: 0, last_commit_ms: 70 });
  });

  it("is on by default and off only when asked", () => {
    const saved = process.env.COCALC_BEES_GATE;
    try {
      delete process.env.COCALC_BEES_GATE;
      expect(beesGateEnabled()).toBe(true);
      process.env.COCALC_BEES_GATE = "off";
      expect(beesGateEnabled()).toBe(false);
    } finally {
      if (saved == null) delete process.env.COCALC_BEES_GATE;
      else process.env.COCALC_BEES_GATE = saved;
    }
  });
});

describe("the BEES gate", () => {
  const quiet = "commits 1\ncur_commit_ms 0\nlast_commit_ms 100\n";
  const { worst_commit_ms: _w, lifecycle_active: _l, ...calmHost } = calm;

  function gate({
    inputs = () => calmHost,
    commits = () => quiet,
    lifecycle = () => false,
    sampleMs = 3_600_000,
    apply,
  }: {
    inputs?: () =>
      | Omit<BeesGateInputs, "lifecycle_active" | "worst_commit_ms">
      | Promise<Omit<BeesGateInputs, "lifecycle_active" | "worst_commit_ms">>;
    commits?: () => string | Promise<string>;
    lifecycle?: () => boolean;
    sampleMs?: number;
    apply: (action: string) => Promise<void>;
  }) {
    let now = 0;
    const g = new BeesGate({
      mount: "/mnt/cocalc",
      lifecycleActive: lifecycle,
      now: () => now,
      readInputs: async () => inputs(),
      readCommitStats: async () => commits(),
      apply: apply as any,
      intervalMs: 3_600_000,
      sampleMs,
    });
    return { g, advance: (ms: number) => (now += ms) };
  }
  // Each decision writes the state again (see syncCgroup), so the tests
  // look at the changes: consecutive repeats are collapsed.
  const pushChange = (actions: string[], action: string) => {
    if (actions[actions.length - 1] !== action) actions.push(action);
  };
  const recorder = () => {
    const actions: string[] = [];
    const calls: string[] = [];
    return {
      actions,
      calls,
      apply: async (action: string) => {
        calls.push(action);
        pushChange(actions, action);
      },
    };
  };

  // Review of #1503: a cgroup left frozen by an earlier daemon must not stay
  // frozen when BEES may run; the gate applies its state on the first tick.
  it("freezes first whatever the cgroup holds, thaws after the frozen period, and freezes again on a slow commit", async () => {
    const { actions, apply } = recorder();
    let commits = quiet;
    const { g, advance } = gate({ apply, commits: () => commits });
    await g.start();
    expect(actions).toEqual(["freeze"]);
    expect(g.getStatus()).toMatchObject({ applied: true, frozen: true });
    advance(5 * MIN);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    advance(5 * MIN);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    // A commit still running after 4.5 s: with the sampling period that is
    // over the 5 s freeze threshold, so BEES freezes at once.
    commits = "commits 2\ncur_commit_ms 4500\nlast_commit_ms 100\n";
    await g.sample();
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    expect(g.getStatus()).toMatchObject({
      frozen: true,
      reason: "slow_commit",
    });
    g.stop();
  });

  it("freezes a running BEES at once when a project starts", async () => {
    const { actions, apply } = recorder();
    let starting = false;
    const { g, advance } = gate({ apply, lifecycle: () => starting });
    await g.start();
    advance(10 * MIN);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    starting = true;
    await g.sample();
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    expect(g.getStatus().reason).toBe("lifecycle_active");
    g.stop();
  });

  it("does not thaw without commit samples", async () => {
    const { actions, apply } = recorder();
    const { g, advance } = gate({ apply });
    await g.start();
    advance(20 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    g.stop();
  });

  // Codex on #1503: the frozen period must start at a successful freeze.
  it("keeps asking to freeze until it succeeds, and starts the frozen period then", async () => {
    let fail = true;
    const actions: string[] = [];
    const { g, advance } = gate({
      apply: async (action) => {
        if (fail) throw Error("timeout");
        pushChange(actions, action);
      },
    });
    await g.start();
    expect(g.getStatus()).toMatchObject({ enabled: true, applied: false });
    advance(20 * MIN);
    await g.sample();
    fail = false;
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    advance(10 * MIN);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    g.stop();
  });

  it("runs BEES ungated only when the root helper does not know the gate", async () => {
    const old = gate({
      apply: async () => {
        throw Error("SECURITY_DENY code=unsupported-command detail=bees-gate");
      },
    });
    await old.g.start();
    expect(old.g.getStatus().enabled).toBe(false);

    // another refusal (e.g. the BEES cgroup policy) is retried
    const other = gate({
      apply: async () => {
        throw Error("SECURITY_DENY code=project-io-policy-invalid detail=bees");
      },
    });
    await other.g.start();
    expect(other.g.getStatus()).toMatchObject({
      enabled: true,
      applied: false,
    });
    other.g.stop();
  });

  // Codex and @review on #1503: monitoring that stops must not count as calm.
  it("treats a failed commit read as a slow commit for the whole window", async () => {
    const { actions, apply } = recorder();
    let fail = false;
    const { g, advance } = gate({
      apply,
      commits: () => {
        if (fail) throw Error("EIO");
        return quiet;
      },
    });
    await g.start();
    advance(10 * MIN);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    fail = true;
    await g.sample();
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    fail = false;
    advance(10 * MIN - 30_000);
    await g.sample();
    await g.tick();
    // the failed read is still within the last minute
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    g.stop();
  });

  // @review on #1503: production timers, with a commit_stats read that hangs
  // under the I/O stall.
  describe("on its own timers", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    function timed(lifecycle: () => boolean) {
      const actions: string[] = [];
      let hang = false;
      let inputsHang = false;
      let reads = 0;
      const pending: Array<(s: string) => void> = [];
      const g = new BeesGate({
        mount: "/mnt/cocalc",
        lifecycleActive: lifecycle,
        readInputs: async () =>
          inputsHang ? await new Promise<never>(() => {}) : calmHost,
        readCommitStats: async () => {
          reads += 1;
          return hang
            ? await new Promise<string>((resolve) => pending.push(resolve))
            : quiet;
        },
        apply: async (action) => {
          pushChange(actions, action);
        },
      });
      return {
        g,
        actions,
        hang: () => (hang = true),
        hangInputs: () => (inputsHang = true),
        reads: () => reads,
        release: () => pending.forEach((resolve) => resolve(quiet)),
      };
    }

    it("freezes within a second when a project starts while a commit read hangs", async () => {
      let starting = false;
      const t = timed(() => starting);
      await t.g.start();
      await jest.advanceTimersByTimeAsync(10 * MIN + 30_000);
      expect(t.actions).toEqual(["freeze", "thaw"]);
      t.hang();
      await jest.advanceTimersByTimeAsync(1_500);
      const reads = t.reads();
      starting = true;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(t.actions).toEqual(["freeze", "thaw", "freeze"]);
      expect(t.g.getStatus().reason).toBe("lifecycle_active");
      // the hung read is not repeated
      expect(t.reads()).toBe(reads);
      t.g.stop();
      t.release();
    });

    // @review on #1503: a decision stuck on its inputs (statfs, io pressure)
    // must not stop the state from being written again.
    it("undoes a late write of a stopped gate while a decision is stuck", async () => {
      const t = timed(() => false);
      await t.g.start();
      t.hangInputs();
      await jest.advanceTimersByTimeAsync(MIN);
      t.actions.push("thaw"); // the old daemon's late thaw
      await jest.advanceTimersByTimeAsync(31_000);
      expect(t.actions.slice(-2)).toEqual(["thaw", "freeze"]);
      expect(t.g.getStatus()).toMatchObject({ applied: true, frozen: true });
      t.g.stop();
    });

    // Codex on #1503: free space and io pressure are unknown while a
    // decision hangs on them.
    it("freezes when decisions stop completing", async () => {
      const t = timed(() => false);
      await t.g.start();
      await jest.advanceTimersByTimeAsync(10 * MIN + 30_000);
      expect(t.actions).toEqual(["freeze", "thaw"]);
      t.hangInputs();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(t.actions).toEqual(["freeze", "thaw"]);
      await jest.advanceTimersByTimeAsync(40_000);
      expect(t.actions).toEqual(["freeze", "thaw", "freeze"]);
      expect(t.g.getStatus().reason).toBe("stale_inputs");
      t.g.stop();
    });

    it("freezes once its commit samples go stale, before the next decision", async () => {
      const t = timed(() => false);
      await t.g.start();
      await jest.advanceTimersByTimeAsync(10 * MIN + 30_000);
      expect(t.actions).toEqual(["freeze", "thaw"]);
      t.hang();
      await jest.advanceTimersByTimeAsync(4_000);
      expect(t.actions).toEqual(["freeze", "thaw"]);
      await jest.advanceTimersByTimeAsync(3_000);
      expect(t.actions).toEqual(["freeze", "thaw", "freeze"]);
      expect(t.g.getStatus().reason).toBe("slow_commit");
      t.g.stop();
      t.release();
    });
  });

  // @review on #1503: a stopped gate (e.g. of the daemon being replaced)
  // must not act on anything it was waiting for.
  it("does nothing after stop, whatever was in flight", async () => {
    const { actions, calls, apply } = recorder();
    let release: (s: string) => void = () => {};
    let hang = false;
    let releaseInputs: () => void = () => {};
    let slowInputs = false;
    const { g, advance } = gate({
      apply,
      commits: () =>
        hang ? new Promise<string>((resolve) => (release = resolve)) : quiet,
      inputs: () =>
        slowInputs
          ? new Promise((resolve) => (releaseInputs = () => resolve(calmHost)))
          : calmHost,
    });
    await g.start();
    advance(10 * MIN);
    await g.sample();
    // a calm decision (would thaw) waiting on its inputs
    slowInputs = true;
    const tick = g.tick();
    // a slow commit waiting on its read
    hang = true;
    const sample = g.sample();
    g.stop();
    const before = calls.length;
    releaseInputs();
    release("commits 2\ncur_commit_ms 9000\nlast_commit_ms 100\n");
    await Promise.all([tick, sample]);
    await g.sample();
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    expect(calls.length).toBe(before);
    expect(g.getStatus()).toMatchObject({ frozen: true, reason: "startup" });
  });

  // @review and Codex on #1503: a write of the previous daemon's gate that
  // lands after this gate's freeze is undone by the next decision.
  it("writes its state again at every decision", async () => {
    let cgroupFrozen: boolean | undefined;
    const { g, advance } = gate({
      apply: async (action) => {
        cgroupFrozen = action === "freeze";
      },
    });
    await g.start();
    expect(cgroupFrozen).toBe(true);
    cgroupFrozen = false; // the old daemon's late thaw
    advance(MIN);
    await g.sample();
    await g.tick();
    expect(cgroupFrozen).toBe(true);
    g.stop();
  });

  it("writes one action at a time, the latest state last", async () => {
    const calls: string[] = [];
    let releaseThaw: () => void = () => {};
    let starting = false;
    const { g, advance } = gate({
      lifecycle: () => starting,
      apply: async (action) => {
        calls.push(action);
        if (action === "thaw") {
          await new Promise<void>((resolve) => (releaseThaw = resolve));
        }
      },
    });
    await g.start();
    advance(10 * MIN);
    await g.sample();
    const tick = g.tick(); // its thaw hangs
    await Promise.resolve();
    starting = true;
    await g.sample(); // can't write while the thaw runs
    expect(calls).toEqual(["freeze", "thaw"]);
    releaseThaw();
    await tick;
    expect(calls).toEqual(["freeze", "thaw", "freeze"]);
    expect(g.getStatus()).toMatchObject({
      applied: true,
      frozen: true,
      reason: "lifecycle_active",
    });
    g.stop();
  });

  it("treats a gap between commit samples, or a failed lifecycle check, as unsafe", async () => {
    const { actions, apply } = recorder();
    let lifecycle: () => boolean = () => false;
    let now = 0;
    const g = new BeesGate({
      mount: "/mnt/cocalc",
      lifecycleActive: () => lifecycle(),
      now: () => now,
      readInputs: async () => calmHost,
      readCommitStats: async () => quiet,
      apply: apply as any,
      intervalMs: 3_600_000,
      sampleMs: 1_000,
    });
    const sampleFor = async (ms: number) => {
      for (let t = 0; t < ms; t += 1_000) {
        now += 1_000;
        await g.sample();
      }
    };
    await g.start();
    await sampleFor(10 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    // 6 s without a sample (e.g. an event loop stall), then a calm one
    now += 6_000;
    await g.sample();
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    expect(g.getStatus().reason).toBe("slow_commit");
    await sampleFor(10 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw", "freeze", "thaw"]);
    lifecycle = () => {
      throw Error("database is locked");
    };
    await sampleFor(1_000);
    expect(actions).toEqual(["freeze", "thaw", "freeze", "thaw", "freeze"]);
    expect(g.getStatus().reason).toBe("lifecycle_active");
    g.stop();
  });

  // Codex on #1503: what the samples cannot vouch for is unsafe.
  it("treats incomplete commit stats, or commits that ended unseen between slow reads, as unsafe", async () => {
    const { actions, apply } = recorder();
    let now = 0;
    let stats = "commits 1\ncur_commit_ms 0\nlast_commit_ms 100\n";
    const g = new BeesGate({
      mount: "/mnt/cocalc",
      lifecycleActive: () => false,
      now: () => now,
      readInputs: async () => calmHost,
      readCommitStats: async () => stats,
      apply: apply as any,
      intervalMs: 3_600_000,
      sampleMs: 1_000,
    });
    const sampleFor = async (ms: number) => {
      for (let t = 0; t < ms; t += 1_000) {
        now += 1_000;
        await g.sample();
      }
    };
    await g.start();
    await sampleFor(10 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    // several commits per second at the normal pace are fine
    stats = "commits 4\ncur_commit_ms 0\nlast_commit_ms 100\n";
    await sampleFor(1_000);
    expect(actions).toEqual(["freeze", "thaw"]);
    stats = "commits 4\n"; // truncated
    await sampleFor(1_000);
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    stats = "commits 4\ncur_commit_ms 0\nlast_commit_ms 100\n";
    await sampleFor(10 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw", "freeze", "thaw"]);
    // 2.5 s between reads (under the staleness bound), and two commits ended
    // in it: one may have taken 2.5 s, over the thaw threshold
    now += 2_500;
    stats = "commits 6\ncur_commit_ms 0\nlast_commit_ms 100\n";
    await g.sample();
    await sampleFor(2_000);
    await g.tick();
    expect(g.getStatus().inputs?.worst_commit_ms).toBe(2_500);
    g.stop();
  });
});
