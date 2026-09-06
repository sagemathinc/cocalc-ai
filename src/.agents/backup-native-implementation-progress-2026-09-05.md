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

### Exclusion Protocol and Freshness Follow-up

- Core `8d0a0b150d518b60119445fbf13e71db0599208b` adds the shared
  metadata-only selection inventory with streamed size exclusions. Omitted paths
  still consume traversal/metadata budgets; arithmetic, callback and incomplete
  scan errors fail. CLI `b44b0664fc7a5fc79eff3c09d9d551b076a450e4` pins it
  and emits bounded NDJSON with raw OS-path bytes, decimal counters and a
  completion footer. Core tests and strict Clippy pass; CLI tests pass. Native
  qualification run `34008321429` passes both amd64/arm64 Btrfs quota tests and
  positive/negative build-attestation verification. This is a candidate, not a
  fleet deployment.
- CoCalc `7ded0da903` corrects backup freshness: manual and rolling backups
  report a conservative source time/generation captured BEFORE snapshotting,
  never the live generation after upload. Owning-bay writes are fenced to the
  reporting host and newer capture time, without mixing old/new generations.
  Invalid timestamps or unsafe numeric generations are rejected. File-server,
  project-host and server builds pass; focused tests cover ordering and invalid
  evidence. Existing persisted legacy freshness claims are NOT retroactively
  repaired by this code; native lifecycle admission must require newly bound
  source/backup evidence before destructive finalization.
- CoCalc `8d63fac978` also rejects known stale manual archives BEFORE stopping
  projects or deleting data. Both archive modes compare PostgreSQL BIGINT
  generation strings without Number rounding and reject malformed evidence.
  Server build and 29 focused eligibility/archive tests pass. This preflight
  does not replace final host-side write/placement/quota fences.
- CoCalc `d944286cfc` adds the shared streaming report validator. It requires
  protected expected report/header hashes, consistent bounded counts and record
  order, and root-relative lossless Linux paths. Samples and acknowledgement
  keys are bounded; unknown/overridden ctime cannot suppress warnings. All 35
  unit cases plus an actual native-CLI backup/restore/report interoperability
  test pass. This validator is not yet connected to durable report publication,
  UI acknowledgements or copy/lifecycle admission; inventory is not backup or
  restore-capacity authority.
- Core `916dcb3c7e1886383198bf32d46962d949a9f9e6` fixes another strictness
  gap: local xattr read errors previously became empty metadata before the
  archiver could see them. Strict backup traversal and all inventories now
  propagate those errors; non-strict behavior and explicit no-xattrs scope
  remain unchanged. The existing 190 unit/62 integration cases pass, plus a
  new repository regression proves strict metadata traversal without admission
  cannot publish an incomplete snapshot. Strict Clippy passes. CLI `8e4623b`
  pins this core and passes its full local test suite and strict Clippy; the
  native-report interoperability test also passes against that binary.
  CoCalc `2b5ee2eafd` requires `strict_local_metadata=1` for native jobs and
  parses/hash-checks owned report bytes. All 92 bootstrap and 25 helper tests,
  36 backend report tests (including real CLI), and backend build pass.
  Supervision run `34009631508` exposed an outdated systemd fake binary that
  lacked the new capability. `f3d8c290d8` updates that fixture without weakening
  admission; follow-up run `34009749455` passes. Native run `34009629890` has
  passed Btrfs snapshot/quota qualification on both architectures; packaging and
  provenance verification were still pending at this ledger update.

### Protected Storage, UI, And Staging2 Follow-up

- Native CLI qualification run `34009629890` is now complete and successful,
  including both architectures and packaging/provenance verification.
- CoCalc `6284aee2ce` adds bounded, source-bound R2 exclusion-report storage.
  It verifies private staged input before uploading, reads back and verifies the
  object before returning a receipt, and derives keys from project/backup/source/
  policy/report identity. The distinct prefix is outside browsing-index cleanup.
  R2 downloads and upload responses now support bounded/abortable processing;
  retry sleeps respect cancellation. Seventy report/storage/transport tests and
  backend build pass. This is a storage component, not yet root-producer or
  owning-bay outcome integration. Its receipt never grants deletion authority.
- CoCalc `5a2c955502` adds the shared bounded coverage-view type and frontend
  warning component. Per-file consent, uncertain-identity rejection, quiet
  disclosure, report download, pagination, safe raw-path display, and focus
  restoration have nine focused tests. Frontend lint and frontend/util builds
  pass. The component is deliberately not mounted in the recovery panel before
  live status, acknowledgement and report APIs are connected. Keyboard browser,
  narrow-width and zoom validation remain required.
- The user explicitly expanded completion to include deployment and full
  verification on `https://staging2.cocalc.dev`. Read-only CLI authentication and
  host discovery succeed. Browser-approved fresh-auth elevation has expired;
  renew it through the typed CLI flow when the deployment is ready, not with
  bearer/API credentials. No deployment or policy activation has occurred.
  The currently running bay-0 hosts are `staging2-shared-1`
  (`8cd90870-e58f-4979-b87f-cf85f3622324`) and `staging2-copy-canary`
  (`4a9c7c19-5c5f-45f9-a48b-5f04196666d4`). Revalidate their state before use.

### Protected Producer And Owning-Bay Outcomes

- CoCalc `5d3984fb22` adds opt-in root producer evidence. The helper reads the
  anchored read-only Btrfs snapshot UUID, parent UUID and exact u64 generation,
  captures bounded inventory with the same selection flags as backup, and
  publishes root-owned reports only after successful backup and a final source
  identity check. Repository initialization precedes inventory because inventory
  needs the repository chunker configuration. Thirteen producer regressions,
  25 supervision tests and 92 bootstrap tests pass locally. The new identity
  ioctl still needs real Btrfs qualification through the producer, not only the
  mocked ioctl tests. No root policy has been enabled.
- The host receiver now validates and anchors root-owned reports, uploads and
  reads back full bounded evidence, then awaits a distinct host-authenticated
  `recordProjectBackupOutcome` RPC. The owning bay stores immutable bounded
  receipts with the authoritative storage bucket ID, checks current placement
  under a project-row lock, and never substitutes a local write after remote
  failure. Repeated identical receipts are safe; conflicting receipts fail.
  Snapshot observation time/generation do not advance live-source freshness.
- Manual backups and rolling managed backups are wired to this receipt path.
  A partial backup is recorded but throws before legacy success/freshness or
  destructive callers can consume it. Unhandled producer evidence also fails
  in the generic subvolume path. The explicit caller evidence gate requires
  supervision; with gates disabled, older helpers retain their behavior.
  This is not yet a complete partial-backup user experience or lifecycle gate.
- Current focused checks: 122 backend evidence/store/report/transport/gate
  tests, 127 server outcome/routing tests, 22 project runner tests, and 16
  subvolume backup tests pass. Server and project-host package builds are part
  of the changeset verification. No Staging2 or production deployment occurred.

- Local root report spooling now requires explicit byte/count limits and reserves
  each producer's maximum future report length under a bounded lock. Interrupted
  reservations remain charged rather than being blindly age-deleted. The real
  multi-process test on local Btrfs exposed a stale directory enumeration race;
  reopening the scan directory after acquiring the lock prevents over-admission.
  Reports are hash-sealed by root, then released via a filename/digest-only
  privileged command after remote verification and durable owning-bay acceptance.
  Release failure retains bounded evidence without retrying the completed backup.
  All 18 producer, 26 supervision-policy and 26 project runner tests pass, as
  does the project-host typecheck. Bootstrap regression tests also pass.
  Abandoned reservations still require reconciliation; central spool health and
  evidence-bucket retention fences remain outstanding. This is not deployment.

- A bounded private SQLite report index now supports 50-entry keyset pages,
  exact raw-byte path lookups, source-bound cursors and a read-only lease.
  Full report hash/footer validation precedes exposing any indexed rows; failed
  validation, duplicate paths, index-size overflow and consumer failure remove
  temporary state. SQLite page-count and cache-size limits bound index expansion
  independently of report size. The durable object reader can rebuild this
  disposable index after producer-file loss, then serve repeated pages without
  rescanning/downloading the report. All 117 focused backend evidence/index/store
  tests and the backend typecheck pass. This is the paging engine, not yet the
  authorized project-host API or its aggregate bounded session cache; those and
  account acknowledgements must be connected before mounting the existing UI.

- The host-authenticated `getProjectBackupOutcome` RPC now reads either latest
  or exact historical evidence through the project's owning bay. One SQL snapshot
  checks current placement, non-deletion and ownership while selecting a bounded
  receipt. Reads revalidate the receipt digest and retain the original bucket ID,
  not the current repository assignment. Absent evidence is `null`, never assumed
  complete. Remote failure does not fall back to a non-authoritative local read.
  All 140 focused server routing/outcome tests and the server typecheck pass.
  This is the protected metadata API; scoped historical object access, browsing
  leases and per-account acknowledgement integration remain to be connected.

- Disposable systemd/Btrfs qualification now covers the actual sudo wrapper's
  protected evidence production, snapshot UUID/parent identity, spool permissions
  and sealed release. The first run (`34034266626`) caught a real identity-reader
  bug: GET_SUBVOL_INFO exposes root-item read-only bit 0, not the GETFLAGS/SETFLAGS
  read-only bit 1. CoCalc `1349c4fd16` corrects the check and its misleading mock.
  Follow-up run `34034412517` passes all 27 cases. Native backup work is still
  represented by a deterministic fixture in this supervision suite; full CoCalc
  native backup/restore workflows remain a distinct Staging2 requirement.
- Report/index consumer leases now enforce cancellation even when the consumer
  never reads or settles. Index handles are invalidated and closed before cleanup
  completes, and nested report/index scopes await each other's cleanup. All 120
  focused backend evidence/index/store tests and the backend typecheck pass.
- Staging2 read-only auth validation still succeeds for the saved cookie profile,
  but its fresh-auth elevation has expired. No deployment was attempted; renew
  via the typed browser-approved elevation flow when ready to mutate Staging2.

Next integration work is abandoned-report reconciliation and bucket-retention fencing,
durable failed-attempt status, paginated report access and account-specific UI
acknowledgements, then protected quota-enforced restore staging and early/final
lifecycle gates. Listing/indexing and all destructive consumers must resolve
the new outcomes before exclusions are enabled. Migration/RootFS/copy paths
still need their corresponding evidence and immutable staging integration.
The complete goal remains unfinished; no size-exclusion policy or production
activation has been enabled.

- CLI: `/home/user/upstream/cocalc-rustic`, branch `cocalc/sparse-backups`.
  Fork base `d58099c`, upstream CLI `143d073` merged in `0ef705a`; `737ba53`
  adds admission/capability commands. Both are pushed to the fork topic branch.
  Existing fork hardlink changes are already represented upstream.
- Core commits `33fdd63`, `5b6146b`, `f45990d`, `8d0a0b1` and `916dcb3`
  were pushed to `sagemathinc/rustic_core:cocalc/sparse-backups`. CLI dependencies
  now pin `916dcb3c7e1886383198bf32d46962d949a9f9e6`; lockfile resolution succeeded.
  CLI unit config snapshots gained only strict/admission fields.
- Rust 1.94.0 is installed at `/home/user/.cargo/bin`, without modifying shell
  PATH or the older system toolchain. Use the explicit cargo path.
- Existing original upstream checkouts are not the development worktrees.

## Still Required

### September 6 UI Integration Checkpoint

- `0efc5be17e` connects protected historical outcome reads and exact signed GET
  capabilities to a bounded project-host report cache and direct project archive
  service. Every request rechecks owning-bay placement before cache reuse. Cache
  slots include pending work, reject capacity overflow, expire on fixed leases,
  and remain charged after uncertain cleanup. Crash-leftover disk containment
  remains an activation requirement; this is not solved by process-local counts.
- The recovery settings panel is now mounted and wired to report pages, bounded
  chunk downloads with final browser SHA-256 verification, and durable personal
  acknowledgements. Account-home routing, collaborator authorization, rehome
  write fences and portable acknowledgement state are implemented. Only current
  verified file-version keys count; stale, duplicate or unknown keys cannot
  suppress new warnings. Acknowledgements never authorize omissions.
- Provisional UI safety bounds: at most 10,000 personal acknowledgement keys per
  account, one key per explicit mutation, 50 report entries per page, 64 KiB per
  download response, and 64 MiB accumulated browser download. Host browsing has
  no implicit activation default: `COCALC_BACKUP_REPORT_CACHE_LIMITS` must supply
  qualified report/count/index/lease bounds. These are not production backup
  eligibility parameters, and browser downloads above their limit fail explicitly.
- Focused checks passed: 23 frontend controller/panel/download cases, 53 backend
  report/cache/index cases, 8 project-host coverage/routing cases, and 13 server
  acknowledgement/home-bay/rehome cases. Frontend lint and frontend/server/host
  typechecks pass. Browser keyboard/reflow and live Staging2 workflow validation
  still remain; unit tests are not substitutes for those checks.
- Staging2 browser-approved fresh auth was obtained on September 6 and verified
  through `2026-09-06T21:58:31.281Z`. Both canary and shared hosts are running.
  No Staging2 deployment or native/exclusion gate activation has occurred yet.
- Side question: Alpha's read-only settings inspection confirms email enabled,
  SendGrid configured (secret redacted), `help_email=help@cocalc.com`, and the
  notification email lane inheriting the main backend. AI activity email defaults
  off in account preferences; chat settings separately opt into turn-completion
  notices. Actual user preferences, workers and delivery have not been verified.

### September 6 Additional Integration Checkpoint

- `d87af82ca9` registers the acknowledgement method in the actual Conat runtime
  client/auth map. Tests now exercise generated clients, not only mocked calls.
- `f3e972c56e` rejects known partial backup coverage before move guard acquisition,
  project stop, placement changes, or manual archive job creation. The owning-bay
  query fences expected placement and verifies the protected receipt. All 51
  focused lifecycle/preflight tests and server typecheck pass. This remains an
  early rejection guard, not final source-deletion or restore-capacity authority.
- Native managed-project backup attempts now persist one bounded latest-attempt
  row per project on its owning bay, before starting work. Worker death leaves an
  explicitly unconfirmed attempt; failure reporting cannot overwrite a newer
  attempt or previously accepted partial receipt. Completed status is derived
  from protected receipt metadata, never from a caller's success flag. This is
  observational telemetry, not replacement for the root-owned retry journal or
  central retry enforcement. Failures before entering the managed runner still
  require scheduler/LRO integration.
- Direct project archive-info requests return this bounded status under the
  authenticated subject. Recovery UI displays failed/unconfirmed attempts beside
  historical coverage, including when that historical report was complete.
  Unit tests cover worker failure, reporting failure, absent evidence, host and
  owning-bay routing, real RPC registration, and UI separation. Server, host, and
  frontend typechecks pass; frontend lint passes. Actual Staging2 browser and
  workflow qualification remain required.
- Project-rehome preflight explicitly identifies protected outcome and latest
  attempt history as not yet portable. Personal warning acknowledgements belong
  to account-home state and must not be moved with project ownership.

### Remaining Activation Work

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
- Qualify the now-wired per-user/version warnings and report downloads live;
  integrate failed-attempt status and crash-safe report cache activation.
- Add default-false explicit copy exclusions across local/tar/Rustic, queues,
  RPCs, CLI and UI, preserving existing destinations at excluded paths.
- Derive and test numeric candidates from worst-case references, tree/index
  expansion, entries, metadata, concurrency and actual staging usage. No final
  production limits have been selected or enabled.
- Preserve all separate deployment, automatic-loss, notice/grace and production
  rollout approval gates in the plan. Do not automatically delete user data.
