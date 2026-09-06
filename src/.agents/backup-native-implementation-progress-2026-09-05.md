# Native Backup Implementation Progress

The active goal is full implementation of
`backup-apparent-file-size-policy-2026-09-05.md`. This is a progress ledger,
not a completion claim or deployment approval. Production remains unchanged.

## Implemented And Locally Tested

- CoCalc `2f5dc89302`: sandbox execution escalates using actual exit state,
  supports opted-in process groups, and rejects truncated/unknown-status output.
  Backend build and 19 focused tests passed. This does not yet provide full
  root-owned cgroup supervision across sudo, worker death, and service replacement.
- Core fork branch `cocalc/sparse-backups`, worktree
  `/home/user/upstream/cocalc-rustic-core`, upstream base `e97a7dc`:
  `33fdd63` implements mixed/existing sparse restore, required sparse mode,
  native hole-aware chunking, existing-file hole-aware verification, and hardlink
  replacement. `5b6146b` adds strict backup/restore completion semantics.
- Native tests: 180 core unit tests and 59 integration tests passed before the
  strict additions; two new strict fault tests and four restore tests passed.
  Strict Clippy passes. Re-run the entire suite after subsequent edits.
- The isolated Btrfs benchmark passed 1 TiB all-hole and 100 GiB sparse backup,
  unchanged/small-edit reuse, fresh restore, existing-content repair, and data
  integrity checking. See `experiments/native-sparse/README.md` for measurements
  and explicit evidence limits. It is not a quota-enforced staging test.
- The optimized, strict-mode benchmark also passes. Bounded compatibility tests
  pass for old 0.11.1 backups with the new reader and new backups with old Rustic
  and independent Restic 0.18.0, including hashes, symlinks and hardlinks.

## Working Repositories

- CLI: `/home/user/upstream/cocalc-rustic`, branch `cocalc/sparse-backups`.
  Fork base `d58099c`, upstream CLI `143d073` merged with `--no-commit`.
  Merge still needs final validation/commit. Existing fork hardlink changes are
  already represented upstream; preserve custom distribution configuration.
- Core commits `33fdd63` and `5b6146b` were pushed to
  `sagemathinc/rustic_core:cocalc/sparse-backups`. CLI dependencies now pin
  `5b6146b67c277e83b66b5595325e539dcf86db19`; lockfile resolution succeeded.
  CLI unit config snapshots gained only the intended `strict = false` field.
- Rust 1.94.0 is installed at `/home/user/.cargo/bin`, without modifying shell
  PATH or the older system toolchain. Use the explicit cargo path.
- Existing original upstream checkouts are not the development worktrees.

## Still Required

- Complete root-owned job supervision, cancellation/lifetime locks, CPU/memory/I/O
  budgets, bounded immutable-source preflight, and durable retry/backoff handling.
- Add one shared bounded inventory and exclusion manifest used by backup and
  every copy transport; account for chunk-reference and metadata expansion, not
  just compressed repository bytes or physical source allocation.
- Finish fork pinning, reproducible builds/provenance, independent-reader/old-
  snapshot tests, adversarial measurements, and quota-enforced Btrfs snapshot
  round trips. Verify that strict flags reach the CLI, not only the core API.
- Integrate explicit sparse-required/strict capability admission in every restore
  path, protected quota-enforced staging, and safe sparse publication.
- Carry complete/partial/failed evidence through status, scheduling, lifecycle,
  copies, and backup freshness before enabling exclusions.
- Add early move/archive admission and final source/version/quota fences, so a
  known rejection never stops the project or changes placement first.
- Add per-user/version warning acknowledgements and authorized exclusion reports.
- Add default-false explicit copy exclusions across local/tar/Rustic, queues,
  RPCs, CLI and UI, preserving existing destinations at excluded paths.
- Derive and test numeric candidates from worst-case references, tree/index
  expansion, entries, metadata, concurrency and actual staging usage. No final
  production limits have been selected or enabled.
- Preserve all separate deployment, automatic-loss, notice/grace and production
  rollout approval gates in the plan. Do not automatically delete user data.
