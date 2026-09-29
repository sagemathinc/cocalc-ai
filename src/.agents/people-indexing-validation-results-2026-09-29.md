# People Indexing: Initial Execution Results

Date: 2026-09-29. This is an initial gate report, not a completed scaling rollout.

## Implemented

- Added Prometheus counters for memberships enumerated, projection claims,
  access claims, and access-batch attempts in the existing maintenance workers.
- Added projection outcome counts, serialized page bytes, and fetch/apply latency.
  Labels contain only fixed work/outcome categories, not account IDs, project
  IDs, paths, or error text. These are logical work counts, not network RPC or
  SQL statement counts. An empty result can still contain control metadata.
- Added a reproducible PostgreSQL characterization fixture using the existing
  isolated owner/two-home/host harness. It does not connect to the live database.
- Added an opt-in real-btrfs probe with a small read-only ioctl helper. It creates
  and removes only its own temporary fixture; it never freezes a volume, changes
  mount flags, forces a filesystem-wide sync, or creates/deletes snapshots.

Production scheduling, access leases, notification delivery, and scan policy are
unchanged. No demand or Scan mutation API has been enabled.

## Measured Results

The initial PostgreSQL fixture passed: 1,000 synthetic dormant memberships plus
one harness account were enumerated as 1,001 rows on each of two complete seed
rounds. All 1,001 acquired scheduling records without a user opening People.
This demonstrates the recurring enumeration problem; it is not a capacity test
or a measurement of daily active users. The initial test took 48.8 seconds,
including isolated PostgreSQL and four-process startup/cleanup, so that duration
must not be interpreted as seed-query latency.

The expanded baseline suite also passed (two tests): forcing the next due pass
for an unchanged view caused another actual owner `projectPage` call, and the
worker's empty-page metrics reflected both passes. The harness advances due
timestamps for determinism; this does not measure real-time refresh frequency.

The btrfs probe observed generation `1300140` before and after each of:

1. Creating a file, writing bytes, and fsyncing the file.
2. Overwriting bytes and fsyncing the file.
3. Truncating the file and fsyncing the file.
4. Renaming the file.
5. Unlinking the file.

The volume identity remained the same. This is a counterexample to treating
equality of live `BTRFS_IOC_GET_SUBVOL_INFO` generations as proof of unchanged
source bytes. It does not disprove a stronger storage-layer marker sampled under
appropriate barriers, nor compare immutable snapshots. A run in which the
generation changes would also not establish safety: this probe reports such a
result as inconclusive, not a passed no-change contract.

## Gate Decision

Do not enable a raw-generation scan shortcut. Identify and validate the stronger
storage-layer observation contract first, or use conservative dirty/census
reconciliation without advertising provable unchanged coverage. In particular,
do not record a live traversal as a stable snapshot merely because its starting
and ending generation samples match.

No stronger marker has been identified. Continue the demand/offline-delivery
prototype with conservative census as its discovery adapter; the failed proof
blocks the generation shortcut, not that independent work. A future marker must
pass the same adversarial write cases before replacing this adapter.

Do not stop dormant-account projection/access work yet. Offline notification
consumption still depends on that state. The next integrated prototype must
demonstrate independent offline delivery before changing this policy.

Gate 1 is partially implemented, not closed: full table-by-table retention
inventory, query/WAL instrumentation, and load/freshness curves remain. Gate 2
has identified a failed candidate proof. Gates 3-7 are not implemented: integrated
demand/offline delivery prototype, bounded Scan RPC/CLI/UI, recovery/rehome,
100,000-DAU load testing, and the 24-hour soak remain outstanding. No capacity or
merge-readiness claim follows from these small tests.

## Reproduction

From `src/packages/server`, with workspace outputs built:

```sh
pnpm exec tsc --build
COCALC_COLLABORATORS_ACCEPTANCE=1 pnpm exec jest --runInBand --runTestsByPath collaborators/indexing-baseline.acceptance.test.ts
COCALC_BTRFS_PROBE_ROOT=/path/on/btrfs pnpm exec jest --runInBand --runTestsByPath collaborators/btrfs-generation.acceptance.test.ts
```

The PostgreSQL fixture requires PostgreSQL binaries available through `pg_config`.
The btrfs fixture requires a C compiler and Linux btrfs headers. It fails rather
than silently passing on an unsupported filesystem or denied ioctl. Its
structured stdout contains observations and an explicit conclusion. Neither
fixture runs without its explicit opt-in environment variable.

Validation for this change-set: server `tsc --build` passed; two new PostgreSQL
baseline tests passed; the btrfs observation test passed and reported an unsafe
generation-equality candidate; all six existing multibay/historical acceptance
tests passed. Formatting and `git diff --check` passed. No full development build,
browser test, large-scale load test, or soak was run.
