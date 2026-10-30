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
    apply,
  }: {
    inputs?: () => Omit<BeesGateInputs, "lifecycle_active" | "worst_commit_ms">;
    commits?: () => string;
    lifecycle?: () => boolean;
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
      sampleMs: 3_600_000,
    });
    return { g, advance: (ms: number) => (now += ms) };
  }
  const recorder = () => {
    const actions: string[] = [];
    return {
      actions,
      apply: async (action: string) => {
        actions.push(action);
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
        actions.push(action);
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
});
