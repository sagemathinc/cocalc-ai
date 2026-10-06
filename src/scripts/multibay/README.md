# Multibay cluster tests

End-to-end checks against a real multibay cluster: a seed bay and an attached
bay, each a full hub process with its own embedded PostgreSQL, joined by the
real inter-bay fabric. CI runs them in the `multibay` job of
`.github/workflows/make-and-test.yml`.

```sh
pnpm -C src build            # the hubs run from the built tree
node --test --test-reporter=spec src/scripts/multibay/multibay.test.mjs
```

PostgreSQL server binaries (`initdb`, `postgres`) must be on `PATH` or found
through `pg_config`. Each run uses a fresh temporary directory and free ports,
so it does not touch a running dev hub. Set `MULTIBAY_KEEP=1` to keep the
directory (hub logs, `debug.log`, databases) and `MULTIBAY_DIR` to choose its
parent.

- `cluster.mjs`: boots and controls the cluster (start, restart, signal a bay,
  stop), reusing `scripts/dev/hub-cluster.js` for the cluster configuration.
  Projects use the workspace runtime, so no project hosts are needed.
- `harness.mjs`: browser-like signed-in sessions (`AccountClient`, connected to
  the account's home bay with a freshly authenticated session), account
  creation on a chosen home bay, `runInBay` for server-side setup in a bay's
  own environment, and `eventually` for asynchronous convergence.
- `multibay.test.mjs`: the scenarios.
- `fuzz/`: the fuzzer (Layer 1 of
  `src/.agents/multibay-fuzzing-plan-2026-10-05.md`). Seeded random
  operations and faults on the same cluster, checked against a reference
  model after every fault. `fuzz/model.test.mjs` tests the model alone (no
  cluster, milliseconds). `fuzz/cluster-fuzz.test.mjs` runs it for real; it
  takes minutes per seed, so it runs nightly in
  `.github/workflows/multibay-fuzz.yml` and on demand there:

  ```sh
  FUZZ_SEED=7 FUZZ_RUNS=1 FUZZ_STEPS=30 \
    node --test --test-reporter=spec src/scripts/multibay/fuzz/cluster-fuzz.test.mjs
  ```

  A failure prints its seed and the invariant it broke; the full log of each
  seed is `fuzz-seed-<n>.json` in the cluster directory. Add the seed to
  `REGRESSION_SEEDS` next to the fix.

When adding a scenario, act through the public API as real accounts, put the
participants on different bays, and assert the outcome every participant
observes, not just that a call returned. Fault scenarios should first prove
the fault happened (for example, by checking the seed's log), then that the
cluster heals without a restart.
