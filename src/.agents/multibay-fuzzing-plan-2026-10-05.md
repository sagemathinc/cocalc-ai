# Multibay fuzzing plan (2026-10-05)

## Why

The realtime-collaboration fuzzers (`jupyter/redux/__test__/collab-fuzz`,
`frontend/editors/slate/__test__/collab-fuzz`, tasks, whiteboard) found and
fixed a series of merge bugs. Each one was an interleaving that nobody had
written down as a scenario. Multibay has the same shape of problem.

Every multibay bug found on Oct 5 was such an interleaving:

| Bug                                                                     | PR   |
| ----------------------------------------------------------------------- | ---- |
| Fabric sockets never reconnecting after an eviction                     | #897 |
| Foreign keys rejecting collaborators homed on another bay               | #907 |
| Committed changes answered with 408 while a peer bay was frozen         | #909 |
| A rehome race in admin authority (found by security review, by reading) | #904 |
| A two-query race in the local-first account lookup (security review)    | #912 |

Hand-written scenarios in `src/scripts/multibay/multibay.test.mjs` find a bug
only after someone has imagined it. A generator of operations and faults,
checked against invariants, finds them mechanically.

## What made the RTC fuzzers work

1. **A cheap, reproducible world.** The fuzzers run the real code for several
   clients in one process, over a seeded simulated network. A failure prints
   its seed and replays with `FUZZ_SEED=<n> FUZZ_RUNS=1`.
2. **A sharp oracle.** All clients converge, with no ghost or duplicated cells
   and nothing half-done. Fixed seeds become regression cases.

Multibay needs both. The oracle is the larger part of the work.

## The oracle

A small reference model holds:

- accounts and their home bays;
- projects: owning bay, title, members and their groups.

It is updated only by operations that succeeded, and asserts permission rules
only where they are unambiguous (see the table below). After faults heal and
the cluster goes quiet, the checker compares the cluster with the model:

| Invariant                   | Meaning                                                                                                                                                                                                                 |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1 one owner**            | Exactly one bay claims each project (`projects.owning_bay_id` = that bay). It is the bay the model expects.                                                                                                             |
| **I2 owner state**          | The owning bay's row matches the model: title, members and groups.                                                                                                                                                      |
| **I3 projections converge** | Each account's project list, read through the public API on its home bay, shows exactly the projects it is a member of, with the right title and its own group. "Eventually" means within a bounded time after healing. |
| **I4 one home**             | Exactly one bay has an active `accounts` row naming itself as the account's home, and it is the model's home bay.                                                                                                       |
| **I5 permissions**          | Operations the model calls forbidden fail. Operations it calls allowed succeed when no fault is active.                                                                                                                 |
| **I6 honest errors**        | An operation that failed has no effect afterwards (the "408 but committed" class). Checked for renames in v1.                                                                                                           |
| **I7 liveness** (later)     | With a bay frozen or partitioned, operations that do not involve it finish within a bound. v1 only reports slow operations.                                                                                             |

Planned invariants for when the matching operations exist: collaborator index
rows match membership; each notification is delivered once; money is conserved
across rehomes and credit transfers.

## Layer 1: chaos on the real cluster (this PR)

`src/scripts/multibay/fuzz/` drives the real two-bay cluster
(`MultibayCluster`, `AccountClient`) with seeded random operations and faults.

- **Accounts.** Two per bay, created at the start of each run.
- **Operations (v1).** Rules in the table below.
- **Faults (v1).** Freeze a bay (SIGSTOP for 2–8s while operations continue),
  restart the attached bay, lock the seed's bay-credential registry. Each fault
  window is followed by healing and a convergence check. Operations during a
  fault may fail; the model applies them only if they succeeded. A rename that
  failed but became visible anyway is reported (I6).
- **Epochs.** Every few steps: heal, wait until I3 converges (bounded), then
  check I1, I2, I4 and I6.
- **Failure output.** The seed, the full operation log with outcomes and
  durations, the violated invariant and a diff. The cluster directory is kept
  (`MULTIBAY_KEEP`) for the logs.
- **Reproducing.** `FUZZ_SEED=<n> FUZZ_STEPS=<k>` replays the same schedule of
  operations and faults. Timing is not reproducible on a real cluster, so a
  failure that does not replay is still evidence: keep its log.
- **Known findings.** `FUZZ_ALLOW=<invariant,...>` tolerates a class with an
  open fix. For example, `honest-errors` fails on main until #909 merges.
- **CI.** `multibay-fuzz.yml` runs nightly and on demand (seed and step-count
  inputs), and uploads logs on failure. Do not run it on the shared dev host
  beyond short smoke runs.
- **Pure parts.** The model and generator have their own fast unit test
  (`fuzz/model.test.mjs`): determinism, and that the generator only produces
  operations that are well-formed against the model.

| Operation                           | Must succeed                 | Must fail                  | Either (model follows the outcome) |
| ----------------------------------- | ---------------------------- | -------------------------- | ---------------------------------- |
| create project                      | always                       |                            |                                    |
| invite + accept                     | owner inviting a non-member  | non-member inviting        | collaborator inviting              |
| rename                              | owner, collaborator          | viewer, non-member         |                                    |
| change role (collaborator ↔ viewer) | owner, on a non-owner member | non-member                 |                                    |
| remove collaborator                 | owner, on a non-owner member | non-member                 |                                    |
| transfer ownership                  | owner → collaborator         | owner → viewer, non-member |                                    |

The "must succeed" column applies only outside fault windows.

**Next in Layer 1:**

- concurrent actors (two operations in flight);
- asymmetric partitions, through a TCP proxy between each bay and the seed's
  conat server in `cluster.mjs`;
- account and project rehome as operations, interleaved with everything else.
  This is the code with the most races.
- secrets, deletion protection, mentions (notification invariant), access
  requests;
- strict I7 once #909 and #912 land.

## Layer 2: deterministic in-process simulation (later)

Many bays in one process, running the real server code over a simulated conat
fabric with seeded delay, reordering, drops and partitions, at thousands of runs
per minute. This is the RTC model applied to the rehome state machine, the
outboxes, the projections and directory caching.

**Blocker:** server code assumes one bay per process. The pool,
`getConfiguredBayId`, the fabric client and the caches are module singletons.
The `onBay()` helper in the credit-transfer tests only swaps `COCALC_BAY_ID`,
over one shared database.

**Needs:**

- per-bay contexts, each with its own PGlite;
- a simulated fabric behind `createServiceClient` / `createServiceHandler`.

Start after the edge-routing refactor settles. Layer 2 reuses Layer 1's model
and checker.

## Status

- [x] Plan.
- [x] Layer 1 v1: model, generator, executor, checker, fault injection
      (freeze, restart, registry lock), nightly workflow, short run on PRs
      that touch the fuzzer.
- [ ] Next in Layer 1 (see above).

## Findings

| Seed | Finding | Status |
| --- | --- | --- |
| 1, 2 (first local runs, Oct 5) | **honest-errors**: b0 (attached bay) renames their own project while the seed is frozen; the call fails with 408 after 30s, but the rename was applied | Fixed by #909 (not merged). Allowed by default until then |
| every run | Every rename takes about 2s outside faults (create ~40ms, invite ~200ms, remove ~70ms). Cause: `publishProjectDetailInvalidationBestEffort` calls `listLiveBrowserSessionAccountIds`, a scatter-gather `sysApiMany(client, { maxWait: 2_000 }).stats()` over all conat nodes that always waits the full 2s. It is awaited at 29 call sites (metadata, secrets, rootfs state, course info, active operation, turn grants, project control), so each of those changes is about 2s slower than it needs to be, single-bay too | Fixed in #916 (publish in background, share one lookup per 5s): renames now 27ms median on the cluster |
