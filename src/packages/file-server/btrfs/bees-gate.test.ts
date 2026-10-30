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
  function gate(
    inputs: () => Omit<BeesGateInputs, "lifecycle_active">,
    apply: (action: string) => Promise<void>,
  ) {
    let now = 0;
    const g = new BeesGate({
      mount: "/mnt/cocalc",
      lifecycleActive: () => false,
      now: () => now,
      readInputs: async () => inputs(),
      apply: apply as any,
      intervalMs: 3_600_000,
    });
    return { g, advance: (ms: number) => (now += ms) };
  }

  it("freezes at start unless BEES may run, then thaws and freezes as conditions change", async () => {
    const actions: string[] = [];
    let current: Omit<BeesGateInputs, "lifecycle_active"> = {
      ...calm,
      free_fraction: 0.5,
    };
    const { g, advance } = gate(
      () => current,
      async (action) => {
        actions.push(action);
      },
    );
    await g.start();
    expect(actions).toEqual(["freeze"]);
    current = calm;
    advance(5 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    advance(5 * MIN);
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw"]);
    current = { ...calm, worst_commit_ms: 9_000 };
    await g.tick();
    expect(actions).toEqual(["freeze", "thaw", "freeze"]);
    expect(g.getStatus()).toMatchObject({
      frozen: true,
      reason: "slow_commit",
    });
    g.stop();
  });

  it("runs BEES ungated when the root helper does not know the gate", async () => {
    const { g } = gate(
      () => ({ ...calm, free_fraction: 0.5 }),
      async () => {
        throw Error("SECURITY_DENY code=unsupported-command detail=bees-gate");
      },
    );
    await g.start();
    expect(g.getStatus().enabled).toBe(false);
  });

  it("retries an action that failed for another reason", async () => {
    let fail = true;
    const actions: string[] = [];
    const { g } = gate(
      () => ({ ...calm, free_fraction: 0.5 }),
      async (action) => {
        if (fail) throw Error("timeout");
        actions.push(action);
      },
    );
    await g.start();
    expect(g.getStatus()).toMatchObject({ enabled: true, frozen: false });
    fail = false;
    await g.tick();
    expect(actions).toEqual(["freeze"]);
    expect(g.getStatus().frozen).toBe(true);
    g.stop();
  });
});
