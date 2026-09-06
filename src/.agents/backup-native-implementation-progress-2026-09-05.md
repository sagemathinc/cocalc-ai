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
  Clippy pass locally. Follow-up qualification run `34002157054` passes on both
  native amd64 and arm64 for the currently pinned core `f45990d`.
- A root-owned transient-service supervision helper is implemented and installed
  by the bootstrap template. The explicit supervised project commands call it
  behind `COCALC_MANAGED_RUSTIC_SUPERVISION=1`; no host has been enabled. It
  requires an explicit root-owned policy, checks cgroup controls, watches a
  caller pipe lease and PID/start-time identities, and holds repository/host-slot/
  cache locks inherited by Rustic. Persistent unit records also guard retries,
  slots and cleanup when descendants close inherited file descriptors.
- CoCalc `510424d51a` connects project backup/restore calls to a root cleanup
  barrier. Uncertain termination preserves backup/migration staging and prevents
  a deterministic migration staging path from being overwritten on retry.
  File-server/project-host builds and 20 focused Jest tests pass. RootFS and
  unprivileged managed restore/copy entry points still require integration.
- CoCalc `463427d0a2` supports a native section in the root-owned job policy:
  exact binary SHA-256 plus every positive admission budget. The worker hashes
  and executes the same opened inode, checks bounded typed capabilities, passes
  strict/admission backup flags and strict sparse-required restore flags.
  This does not install a policy or select production numeric values.
- `Backup Supervision` CI run `34004370788` passes on disposable Ubuntu/systemd
  and a disposable Btrfs loop filesystem. Sixteen fault/normal cases include actual wrapper/sudo caller death, forced
  descendants, timeout, worker death, OOM, slots, native flags and wrong binaries.
  CoCalc `3472559a63` verifies the read-only Btrfs source flag before native
  project backups and freezes sanitized migration staging before backup.
  `fc22f5f80f` additionally reserves capacity before asking systemd to create a
  service; follow-up CI `34004557783` passes. Sixteen helper unit/OS tests and all
  92 bootstrap tests pass. Earlier clean-CI
  runs exposed two unmocked legacy host writes, fixed in `d1a70225c9`.
  Current supervision is still a gated component, not a completed fleet rollout.
- Bounded admission/metadata probes pass with the current optimized binary:
  a 70 TiB all-hole source is rejected by a reference budget in 0.32 seconds,
  before repository writes. Its JSON reference bound alone is 9,835,642,880
  bytes. Five thousand empty/xattr-heavy files produced a 16.28 MB raw tree
  but only 50.7 kB compressed. Entry/metadata rejections write no artifacts;
  unchanged backups reuse all files. The repeated probe with explicit reuse
  assertions also passes (`/tmp/cocalc-native-admission-asserted-report-2026-09-05.json`).
  Local qualified development binary SHA-256:
  `ba614f0d1f2d96277fc8aeab66a542a5dca8a75500623f1ef78f34375bdade95`.
  See the native experiment README/report; this is not a published fleet artifact.
- `27d2801632` closes the separate maintenance-budget gap: supervised services
  and legacy maintenance scopes share `cocalcmaintenance.slice`. It retains the
  existing aggregate CPU/memory/swap/task limits and applies the approved
  device-specific maintenance I/O policy via systemd. Jobs verify actual parent
  controls, reject observational/disabled policy, and require the old group to
  drain before activation. No manual children are created in systemd's tree.
  Disposable systemd/Btrfs CI `34005196142` passes all 18 cases, including a
  legacy-wrapper scope under that same parent. Twenty helper tests and 92
  bootstrap tests pass. This still does not enable any production host.
- `b7b8c7b2a5` routes the RootFS backup/restore callers through the shared gated
  managed runner, adds root barriers and retains uncertain staging/mounts.
  It fixes the old RootFS restore milliseconds-as-seconds timeout (30 minutes
  had effectively become about 20 days). Native RootFS sources now require a
  read-only Btrfs subvolume too. Mutable overlay publication deliberately fails
  admission until its immutable materialization is implemented. The old
  timestamp-only RootFS temp sweep is disabled under the supervision gate;
  durable source-to-job reconciliation/GC fencing must replace it.
  Project-host typecheck and 21 project/RootFS runner tests pass; 92 bootstrap
  and 20 helper tests pass. Disposable CI `34005567806` passes 20 cases including
  native RootFS flags and cleanup barriers.
- `66313e8458` adds an explicitly configured root-owned retry journal outside
  `/run`, atomic durable outcomes, finite exponential backoff, and a persistent
  operator-review threshold. A launcher crash counts conservatively as an
  interrupted attempt once its process tree is proven gone. Backup and restore
  histories are separate; new staging paths/tags cannot clear failures. Root-only
  status/reset commands serialize with launches and reject reset of active jobs.
  Disposable systemd/Btrfs CI `34007063803` passes all 24 cases. Follow-up hardening
  also fsyncs first creation of the persistent directory. This is host-local
  containment, not yet bay-level reporting or cross-host retry history.
- CLI `89d907e` produces candidate recovery bundles with pinned source/toolchain,
  dependency inventory/lockfile, binary-bound qualification reports and signed
  GitHub provenance. Native amd64/arm64 CI `34006659613` passes, including actual
  Btrfs quota and unchanged/edit reuse. Downloaded bundles were independently
  verified with GitHub CLI 2.100.0 against repository, workflow, exact source
  commit and hosted-runner identity; a wrong source digest was rejected.
  `8e8e801` adds that positive/negative verification to subsequent CI runs;
  follow-up run `34007280494` passes both architectures and verification.
  These GNU builds require GLIBC symbols through 2.39; this is not a universal
  Linux/musl artifact. Binary reproducibility and a full SBOM remain unfinished.
  No release tag, installer pin, or fleet deployment has changed.
- `2afc703091` passes follow-up systemd/Btrfs CI `34007379326`: 25 helper
  unit/OS tests, 92 bootstrap tests and all 24 systemd qualification cases.
- `1a025051ed` shares the supervision gate with the sandbox runner and rejects
  legacy backup/restore fallback before repository initialization or path lookup.
  This covers otherwise unconverted ordinary-file/preview/copy callers when the
  gate is enabled; it does not implement their protected staging yet. Backend
  and project-host builds pass, with 19 backend and 21 project/RootFS tests.
  Gate-disabled installations and browsing behavior are unchanged.

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

- Complete supervision across RootFS/fallback/copy paths, production policy
  installation/capability admission, and central retry/reporting integration.
  The root helper now supports durable per-repository/per-operation retries;
  activation must require an approved retry policy alongside native admission.
  Aggregate maintenance I/O integration now passes disposable qualification;
  activation must still drain old wrapper/maintenance work and qualify the
  actual host policy and disk topology. Extend immutable-source admission
  beyond the now-checked project/sanitized migration snapshots to every other
  managed backup/copy path, not merely flag propagation.
  RootFS callers now use supervision, but still need immutable overlay
  materialization, durable staging reconciliation and active-source GC fencing.
  Qualify policy device coverage for cache/root and data volumes, not just the
  presence of finite limits on whichever devices were configured.
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
