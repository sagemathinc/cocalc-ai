/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Multibay fuzzer, Layer 1: seeded random operations and faults against a
// real two-bay cluster, checked against a reference model after every fault
// and every FUZZ_CHECK_EVERY steps. See
// src/.agents/multibay-fuzzing-plan-2026-10-05.md.
//
//   node --test --test-reporter=spec src/scripts/multibay/fuzz/cluster-fuzz.test.mjs
//
// FUZZ_SEED (default 1) and FUZZ_RUNS (default 1) select the seeds; each seed
// gets fresh accounts on the same cluster. FUZZ_STEPS (default 24),
// FUZZ_FAULT_RATE (default 0.15), FUZZ_CHECK_EVERY (default 8).
// FUZZ_ALLOW=<invariant,...> reports those invariants as warnings (a known
// finding with an open fix). A failure prints its seed; replay it with
// FUZZ_SEED=<seed> FUZZ_RUNS=1. The full log of each seed is written to
// $MULTIBAY_DIR (or the cluster directory) as fuzz-seed-<n>.json.
//
// This boots a real cluster and runs for minutes: use CI
// (.github/workflows/multibay-fuzz.yml) rather than a shared dev host.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { MultibayCluster } from "../cluster.mjs";
import { FuzzRun, INVARIANTS } from "./runner.mjs";

const FIRST_SEED = Number(process.env.FUZZ_SEED ?? 1);
const RUNS = Number(process.env.FUZZ_RUNS ?? 1);
const STEPS = Number(process.env.FUZZ_STEPS ?? 24);
const FAULT_RATE = Number(process.env.FUZZ_FAULT_RATE ?? 0.15);
const CHECK_EVERY = Number(process.env.FUZZ_CHECK_EVERY ?? 8);
const ALLOW = `${process.env.FUZZ_ALLOW ?? ""}`
  .split(",")
  .map((s) => s.trim())
  .filter((s) => s && s !== "none");
for (const name of ALLOW) {
  if (!INVARIANTS.includes(name)) {
    throw new Error(
      `FUZZ_ALLOW: unknown invariant ${name}; known: ${INVARIANTS}`,
    );
  }
}

// Seeds that once failed, with the step count that reproduced it. Add one
// for every bug the fuzzer finds, next to the fix.
const REGRESSION_SEEDS = [
  // A collaborator's project list missed a change: a forward to the other
  // bay timed out and was dropped (now retried from the outbox).
  { seed: 1102, steps: 30 },
  // A collaborator's rename was refused just after accepting an invite: the
  // owning bay's membership check served a 30 s cached "not a member" from
  // a failed call before the invite.
  { seed: 21, steps: 20 },
];

const cluster = new MultibayCluster({ bayIds: ["bay-0", "bay-1"] });

before(async () => {
  await cluster.init();
  await cluster.start();
});

after(async () => {
  await cluster.stop();
});

describe("multibay fuzz", () => {
  const seeds = [
    ...REGRESSION_SEEDS,
    ...Array.from({ length: RUNS }, (_, i) => ({
      seed: FIRST_SEED + i,
      steps: STEPS,
    })),
  ];
  for (const { seed, steps } of seeds) {
    it(`seed ${seed} (${steps} steps)`, async () => {
      const run = new FuzzRun(cluster, {
        seed,
        steps,
        faultRate: FAULT_RATE,
        checkEvery: CHECK_EVERY,
        allow: ALLOW,
        outDir: process.env.MULTIBAY_DIR ?? cluster.dir,
      });
      const { violations, warnings, timings } = await run.run();
      console.log(
        `seed ${seed} timings outside faults: ${JSON.stringify(timings)}`,
      );
      for (const w of warnings) {
        console.log(
          `seed ${seed} allowed ${w.invariant} (step ${w.step}): ${w.detail}`,
        );
      }
      assert.equal(violations.length, 0, run.report());
    });
  }
});
