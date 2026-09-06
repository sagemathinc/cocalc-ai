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
- Core `f45990d` adds metadata-only admission (unsorted source traversal) and
  inclusive optional limits for file/aggregate logical bytes, entries, path
  depth, node metadata, elapsed time and worst-case content references. These
  reject the job, never silently filter files. Streams/partial scans fail closed.
- Native tests: 185 core unit tests and 62 integration tests pass, including
  rejection before any pack or snapshot write. Strict Clippy passes.
- The isolated Btrfs benchmark passed 1 TiB all-hole and 100 GiB sparse backup,
  unchanged/small-edit reuse, fresh restore, existing-content repair, and data
  integrity checking. See `experiments/native-sparse/README.md` for measurements
  and explicit evidence limits. It is not a quota-enforced staging test.
- The optimized, strict-mode benchmark also passes. Bounded compatibility tests
  pass for old 0.11.1 backups with the new reader and new backups with old Rustic
  and independent Restic 0.18.0, including hashes, symlinks and hardlinks.
- CLI `0ef705a` passed Linux/Btrfs qualification on native amd64 and arm64 in
  GitHub Actions run `34001212323`. It proves a 4 GiB qgroup rejects dense 5 GiB
  allocation, then restores a 10 GiB sparse fixture in 12 KiB. Mixed 16 MiB
  files restore in 1 MiB, with correct bytes/hardlinks. Actual read-only snapshot
  backups reuse unchanged files; an mtime-reset edit reprocesses only that file.
- CLI `737ba53` exposes `backup-inventory`, backup admission flags and profile-
  independent `version --json` capabilities. All ordinary CLI tests and strict
  Clippy pass locally. Its follow-up qualification run `34002157054` is pending.
- A root-owned transient-service supervision helper is implemented and installed
  by the bootstrap template, but not yet called by the storage wrapper. It
  requires an explicit root-owned policy, checks cgroup controls, watches a
  caller pipe lease and PID/start-time identities, and holds repository/host-slot/
  cache locks inherited by Rustic. The `wait` barrier is intended for snapshot
  cleanup. Eight new unit/OS-lock tests and all 92 existing bootstrap tests pass.
  Real systemd timeout/worker-death/descendant tests and caller wiring remain
  mandatory; installation alone is not a production containment claim.

## Working Repositories

- CLI: `/home/user/upstream/cocalc-rustic`, branch `cocalc/sparse-backups`.
  Fork base `d58099c`, upstream CLI `143d073` merged in `0ef705a`; `737ba53`
  adds admission/capability commands. Both are pushed to the fork topic branch.
  Existing fork hardlink changes are already represented upstream.
- Core commits `33fdd63`, `5b6146b`, and `f45990d` were pushed to
  `sagemathinc/rustic_core:cocalc/sparse-backups`. CLI dependencies now pin
  `f45990db6609ee89b7a8b78e717d5833baa31543`; lockfile resolution succeeded.
  CLI unit config snapshots gained only strict/admission fields.
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
  snapshot recurring tests and adversarial measurements. Native quota/snapshot
  round trips pass, but CoCalc's actual end-to-end lifecycle still needs them.
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
