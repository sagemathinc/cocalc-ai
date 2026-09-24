# Staging2 project recovery validation

Date: 2026-09-23 UTC

Status: staged reliability changes and restore drills validated; implementation and production gates remain open.

This report tracks implementation of
[the project snapshot and backup reliability plan](project-snapshot-backup-reliability-plan-2026-09-23.md).
Production was not changed.

## Code and deployment

- Main implementation: `fa2d371aae6956fc9dec36509a656c42dba15ed1`.
- Retention regression tests: `fc9f62dd05608bae22ff9e0f91029014513f042e`.
- Live staging regression fix for the initial project inventory cursor:
  `426994ccbe57dafbba757321e26e1941a16b97d0`.
- Home-only snapshot restore fix: `3964a200b267`.
- Staging2 project-host artifact:
  `20260923T195943Z-fa2d371a-snapshot-reliability-fa2d371-20260923-dirty`.
  Durable canary-first rollout `01289c4a-4c75-449c-9f5c-b52d11b61fdf`
  completed on both online hosts.
- Staging2 static artifact:
  `20260923T200334Z-fa2d371a-snapshot-reliability-fa2d371-20260923-dirty`.
- Staging2 hub artifact with cursor fix:
  `20260923T203254Z-426994cc-20260923T203200Z-426994cc-maintenance-cursor-dirty`.
  Deployment `20260923T203435Z-20260923T203254Z-426994cc-20260923T203200Z-426994cc-maintenance-cursor-dirty`
  passed hub health and seven smoke checks.
- Updated staging2 project-host artifact:
  `20260923T205416Z-3964a200-20260923T205600Z-3964a200-home-restore-dirty`.
  Canary-first rollout `78c90a1e-8103-4811-9a86-fcf7331d885a` completed
  successfully on both online hosts.
- Snapshot confirmation and unchanged-content reconciliation:
  `290b79cd24d8`. Staging2 hub artifact
  `20260923T212017Z-290b79cd-snapshot-confirmed-20260923-dirty`, project-host
  artifact `20260923T212251Z-290b79cd-snapshot-confirmed-20260923-dirty`, and
  static artifact `20260923T212701Z-290b79cd-snapshot-confirmed-20260923-dirty`
  deployed in that order. Hub and static smoke checks passed; both online hosts
  passed the canary-first rollout `292ca41e-f0bb-4513-a004-f5608fe6e6cb` and
  host smoke checks.
- Unknown-host overdue status follow-up: `12360e885ba4`. The staging2 static
  artifact `20260923T213343Z-12360e88-recovery-unknown-debt-20260923-dirty`
  passed static smoke. The project UI now shows a known missed due time even
  while host or report freshness is unknown.
- Empty-inventory bay reconciliation: `674689d344e2`. Hub artifact
  `20260923T213641Z-674689d3-snapshot-inventory-20260923-dirty` deployed
  and passed hub smoke. A confirmed empty host inventory now clears a stale
  latest-snapshot value from the bay projection.
- Change-triggered and due-time dispatch: `8f47da2d6789`. Hub artifact
  `20260923T215211Z-8f47da2d-event-recovery-20260923-dirty` passed smoke.
  Project-host artifact
  `20260923T215441Z-8f47da2d-event-recovery-20260923-dirty` passed the
  canary-first rollout `85cbd49e-b0e3-4f15-af60-690f4c5df725` and smoke on
  both online hosts. Confirmed host change events now fetch bounded project
  batches; the host also arms a timer for known due and retry times.
- Mutation-boundary ownership and lifecycle checks: `f8977eae9bc2`. Staging2
  hub artifact
  `20260923T221822Z-f8977eae-recovery-assignment-f8977eae-20260923-dirty`
  passed smoke. Project-host artifact
  `20260923T222051Z-f8977eae-recovery-assignment-f8977eae-20260923-dirty`
  completed canary-first rollout `dafb16aa-7b52-4fe8-bae0-36e5a66d6183`
  on both online hosts; both project-host smoke checks passed. Before and after
  scheduled work, the host checks current assignment, schedule revision, and
  confirmed change timestamp on the owning bay. Scheduled snapshots now hold
  the local project volume lifecycle lock during mutation.
- Typed backup deferrals and plain-language UI reasons: `dceeed405ad9`.
  Staging2 static artifact
  `20260923T223905Z-dceeed40-recovery-deferrals-dceeed40-20260923-dirty`
  passed smoke. Project-host artifact
  `20260923T224017Z-dceeed40-recovery-deferrals-dceeed40-20260923-dirty`
  completed canary-first rollout `9804207e-3266-43df-a3e7-4f2b61f68fc7`
  on both hosts, with both host smoke checks passing.
- Durable short ownership lease: `0dad928602f0`. Project-host artifact
  `20260923T225546Z-0dad9286-recovery-lease-0dad9286-20260923-dirty`
  completed canary-first rollout `dcef4bde-b2f9-48f5-85b6-7e8c8aea58a1`
  and both host smoke checks. A versioned SQLite schedule cache can authorize
  already-validated work for at most 10 minutes during a bay outage; a
  confirmed move or schedule mismatch invalidates the cache.
- Stage timing, Rustic byte accounting, and strict remote backup confirmation:
  `7f18fd01ed56`. Hub artifact
  `20260923T231242Z-7f18fd01-20260923T2313Z-7f18fd01-recovery-metrics-dirty`
  passed hub smoke. Project-host artifact
  `20260923T231500Z-7f18fd01-20260923T2315Z-7f18fd01-recovery-metrics-dirty`
  completed canary-first rollout `bdf5e789-d4aa-476e-b8a8-9e502ca4df8c`
  on both online hosts, with both host smoke checks passing. Each maintenance
  report now carries bounded stage timings and available Rustic byte totals;
  a newly uploaded backup is reported as successful only after all new IDs
  can be read back from the remote repository with valid timestamps.
- Durable host attempt history: `2e41684c8108`. Project-host artifact
  `20260923T232541Z-2e41684c-20260923T2327Z-2e41684c-maintenance-ledger-dirty`
  completed canary-first rollout `7920b5dd-e701-45c3-a07a-d9616efb6145`
  on both hosts, with both smoke checks passing. The host stores each attempt
  in versioned SQLite, replays pending reports across restarts, and bounds
  delivered history to 128 attempts per project and operation for 30 days.
- Bay attempt history and operator health: `155c3230cd47`. Hub artifact
  `20260923T233914Z-155c3230-20260923T2340Z-155c3230-recovery-attempts-dirty`
  passed hub smoke. Project-host artifact
  `20260923T234142Z-155c3230-20260923T2342Z-155c3230-recovery-attempts-dirty`
  completed canary-first rollout `c6f3b0d0-f66c-4f39-be82-9742a140c27c`
  and smoke on both hosts. The owning bay now retains bounded attempt history
  and exposes 24-hour outcome counts, per-stage p95/p99 timing, and
  due-to-success percentiles in operator health.
- One-project operator diagnostic: `cf4480d672b9`. Focused CLI tests (58)
  and server/conat typechecks passed. The staging hub artifact
  `20260923T235617Z-20260923T235452Z-cf4480d6-20260923T2357Z-cf4480d6-recovery-diagnostic-dirty`
  passed smoke. The installed project CLI is older than this source command,
  so its live invocation still needs an installed CLI update; audited raw SQL
  remains pending fresh operator authorization.
- Critical health classification: `aad8e5c00bb3`. Staging hub artifact
  `20260924T0005Z-aad8e5c0-recovery-health` passed smoke. Overdue projects
  without a confirmed funding class and paying projects with at least three
  consecutive failures now trigger critical health instead of appearing
  healthy.
- Bounded deferral-reason health summary: `5f7f16af27a8`. Staging hub
  artifact `20260924T0013Z-5f7f16af-recovery-reasons` passed smoke. The
  24-hour operator view groups host, class, operation, outcome, and fixed
  reason code without project IDs in metric labels.
- Exact snapshot due boundary: `95c1631292`. Project-host artifact
  `20260924T001337Z-95c16312-20260924T0022Z-95c16312-snapshot-due-boundary-dirty`
  completed canary-first rollout `d9dddb37-f6da-4bd3-80c7-0648cd031c21`
  on both online hosts; both host smoke checks passed. The rolling creator
  treats equality with the configured interval as due. A focused regression
  test covers the 15-minute boundary.
- Pressure deferral accounting: `b0df490b60b1`. The staging hub artifact
  `20260924T002130Z-b0df490b-20260924T0025Z-b0df490b-pressure-deferrals-dirty`
  passed hub smoke. Project-host artifact
  `20260924T002350Z-b0df490b-20260924T0026Z-b0df490b-pressure-deferrals-dirty`
  completed canary-first rollout `2a0822a8-a035-4327-9096-bc9a56e2c8d0`
  on both online hosts; both host smoke checks passed. Due work now reaches
  operation-level admission and records its deferral reason and retry instead
  of disappearing behind a sweep-wide pressure check. The operator summary
  groups `io_pressure_*` reasons under a bounded code.
- Local snapshot reconciliation after deferral: `624642abdd11`. Hub artifact
  `20260924T002952Z-624642ab-20260924T0032Z-624642ab-snapshot-reconcile-dirty`
  passed smoke. Project-host artifact
  `20260924T003210Z-624642ab-20260924T0033Z-624642ab-snapshot-reconcile-dirty`
  completed canary-first rollout `e6808764-3150-42b1-b808-1ffdd4cca0d5`
  on both online hosts, and both host smoke checks passed. When the host
  verifies a recent local snapshot but a newer edit must wait for the
  interval, its deferred report now updates the bay's latest local snapshot
  time. A focused worker test checks the resulting next due time.

The `-dirty` artifact suffix came from unrelated, pre-existing untracked files;
the source commits above identify the tracked code used for the builds.

## Validation

| Check                                                                     | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused package tests, typechecks, `build:dev`, frontend lint, formatting | Passed before deployment; the cursor fix passed its focused test and server typecheck.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Project-host, hub, and static staging2 smoke checks                       | Passed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| First production-timed scheduler sweep                                    | Found an empty-string UUID cursor error. Fixed in `426994cc`, deployed to staging2, and verified on the next normal sweep.                                                                                                                                                                                                                                                                                                                                                                      |
| Scheduled backup on a newly provisioned project                           | Rustic backup `e034db1fa34b9994f20eecf606de470f003965bf70b8d4a2078f352bf21de4b9` created at 20:43:24 UTC; `projects.last_backup` advanced to 20:43:24.645 UTC.                                                                                                                                                                                                                                                                                                                                  |
| Scheduled backup restore                                                  | Restored `recovery-canary/marker.txt` to a second file and read back `new scheduled worker 2026-09-23`.                                                                                                                                                                                                                                                                                                                                                                                         |
| Bay backup file index                                                     | The Rustic catalog and file restore worked, but admin `backup-health` still reports `latest_index_backup_at: null` for this backup.                                                                                                                                                                                                                                                                                                                                                             |
| Independent snapshot lane                                                 | Local snapshot `2026-09-23T20:45:17.464Z` created after the backup completed, with the host still responsive to project commands.                                                                                                                                                                                                                                                                                                                                                               |
| Manual backup and restore                                                 | Passed on a separate disposable project after the new project-host deployment.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Full Btrfs snapshot restore                                               | `mode=both` restored a marker to its pre-mutation value and restarted the project successfully.                                                                                                                                                                                                                                                                                                                                                                                                 |
| Home-only Btrfs snapshot restore                                          | `mode=home` restored `historical-home-marker` while preserving a `preserve-current-rootfs` sentinel added after the snapshot. The project restarted successfully.                                                                                                                                                                                                                                                                                                                               |
| Recovery health visibility                                                | After the first successful sweep, unknown snapshot and backup status counts both fell from 12 to 0.                                                                                                                                                                                                                                                                                                                                                                                             |
| Confirmed snapshot outcome and unchanged-content reconciliation           | Focused tests passed across file-server, project-host, server, and frontend. A snapshot success now requires a confirmed recovery point; unchanged content records a schedule-aware reconciliation marker.                                                                                                                                                                                                                                                                                      |
| Recovery health after new changes                                         | Staging2 operator health at 21:28 UTC reported 0 unknown snapshot and backup statuses. The health query now recomputes due times in bounded pages, so a later project edit cannot be hidden by an earlier unchanged-content report.                                                                                                                                                                                                                                                             |
| First normal scheduler cycle after host rollout                           | At 21:41:39 UTC, the scheduled host worker created Btrfs snapshot `2026-09-23T21:41:39.414Z` for project `1b461cb0-47c3-4d58-bdc0-3bdd4af2e139`. Project recovery health then reported healthy, 0 snapshot delay, and 0 unknown statuses.                                                                                                                                                                                                                                                       |
| Event dispatch after a canary file edit                                   | A file edit at 21:58 UTC reached the bay change timestamp at 22:02:12.811 UTC. The host created snapshot `2026-09-23T22:03:49.447Z`, about 97 seconds after bay confirmation and before its first 15-minute full sweep. Host smoke checks remained healthy.                                                                                                                                                                                                                                     |
| Assignment-fenced worker on a fresh canary project                        | Project `c90c2e7e-9a1f-46da-bd7f-9d5222fd1c34` started on the canary host with an empty snapshot inventory. After a marker edit, the deployed worker created Btrfs snapshot `2026-09-23T22:26:13.716Z` and Rustic backup `29b24f0abfed31c5ab87d586b48495e4c669573437c19b932e8a0ac81c1785fd` at 22:26:23 UTC.                                                                                                                                                                                    |
| New worker backup restore                                                 | Restored the canary marker from that Rustic backup to a separate path; the restored bytes matched `assignment-fence fresh project 2026-09-23T22:25Z`.                                                                                                                                                                                                                                                                                                                                           |
| New worker snapshot restore                                               | Changed the canary marker after the snapshot, restored its home from `2026-09-23T22:26:13.716Z`, and read back the original marker. The restore operation succeeded.                                                                                                                                                                                                                                                                                                                            |
| Recovery health after the assignment-fenced rollout                       | At 22:26:36 UTC, project recovery was healthy with 0 unknown statuses and 0 recorded overdue delay. Both project-host smoke checks passed on the deployed artifact.                                                                                                                                                                                                                                                                                                                             |
| Typed-deferral follow-up recovery                                         | Fresh project `fec4a0da-99f7-44c3-8f16-283735073469` produced snapshot `2026-09-23T22:45:42.329Z` and Rustic backup `cf84a869403966082974f1bc85692a970f11411991e77218a5da204f70460dc8`; restoring its marker from that backup succeeded and returned the original bytes.                                                                                                                                                                                                                        |
| Lease-cache worker and restore                                            | Fresh project `47db6b2a-9675-4ae2-834c-3923ba0ed935` produced snapshot `2026-09-23T22:59:55.646Z` and Rustic backup `65fa0f1aa72c18049e9f468d0dd5c8ce45b225b4e5dea3ea58243a36ddffccc8`. Restoring its marker succeeded and returned the original bytes. Project recovery health was healthy at 23:01 UTC, with 0 unknown statuses and 0 recorded overdue delay.                                                                                                                                 |
| Stage-metrics worker and remote confirmation                              | Fresh project `9d1000b8-7f9e-4fc5-be53-0156c3047c94` on the canary host produced snapshot `2026-09-23T23:19:06.028Z` and remote backup `03a02eef9bfc40daaed0afc4c8f87534876cb970affabf3d9a578d96b8ee50b0` at 23:19:09 UTC. Restoring its marker from that backup succeeded; byte comparison matched `metrics-canary-2026-09-23T23:19Z`. Both hosts passed smoke. Live SQL inspection of individual stage fields remains pending fresh operator authorization.                                   |
| Durable host-ledger worker and restore                                    | Fresh project `ac76eb98-13fc-43f5-b207-30c70313b5e8` on the shared host produced snapshot `2026-09-23T23:31:02.893Z` and backup `3e575fd771127b3e233c408d30d4663a11a2a68efc54f3edf1d12cba2d7ab67d` at 23:30:46 UTC. Restoring its marker succeeded and matched `ledger-canary-2026-09-23T23:29Z`. Both hosts passed smoke.                                                                                                                                                                      |
| Bay attempt history and due-to-success health                             | Fresh project `b528cb8d-797c-464c-8f60-1508789595c2` on the canary host produced snapshot `2026-09-23T23:47:34.523Z` and backup `2bf97db0e64c0f0627bcc24221dee6676a961865c5c9a7f90ac27c56f6493064` at 23:47:38 UTC. Restoring its marker succeeded and matched `attempt-health-canary-2026-09-23T23:46Z`. At 23:48 UTC operator health reported 5 successful attempts in 24 hours, 0 failed/deferred attempts, 0 unknown statuses, and 23-second backup p95 due-to-success from one completion. |

The scheduled-path project is
`1b461cb0-47c3-4d58-bdc0-3bdd4af2e139`. The separate restore-test project is
`c33fbadb-38b4-487d-b8be-6ac2dff58143`. A pre-rollout canary project is
`4cf27fc8-0d44-4138-a39c-87643694074f`. The assignment-fenced canary is
`c90c2e7e-9a1f-46da-bd7f-9d5222fd1c34`. The deferral and lease canaries are
`fec4a0da-99f7-44c3-8f16-283735073469` and
`47db6b2a-9675-4ae2-834c-3923ba0ed935`. The stage-metrics canary is
`9d1000b8-7f9e-4fc5-be53-0156c3047c94`; the host-ledger and bay-history
canaries are `ac76eb98-13fc-43f5-b207-30c70313b5e8` and
`b528cb8d-797c-464c-8f60-1508789595c2`. The stage-metrics canary was
stopped after its restore drill to free a staging runtime sponsor slot; all
disposable projects remain on
staging2 for inspection.

The automated pagination test walks 1,003 projects across five pages. Live
staging2 validation used its existing small host inventory plus the disposable
projects; it did not create hundreds of live projects.

At 00:14 UTC on September 24, staging2 operator health showed 35 successful,
37 deferred, and 0 failed project-maintenance attempts in the previous 24
hours. Of the deferrals, 33 were `snapshot_not_created`. The measured snapshot
stage p95 values were about 5.8 seconds for inventory, 6.7 seconds for prune,
and 0.14 seconds for create, which confirms that discovery and retention work
dominate local snapshot time on these hosts. The strict interval comparison
was one plausible cause of the boundary deferrals; the 24-hour cumulative
counter alone cannot prove their root cause.

After the exact-boundary rollout, I wrote a new marker in canary project
`b528cb8d-797c-464c-8f60-1508789595c2` at 00:17:37 UTC. Its last prior
snapshot was at 00:02:49.859 UTC. The scheduled worker created snapshot
`2026-09-24T00:17:50.827Z`, and reading the marker through that snapshot
returned `2026-09-24T00:17:37Z`. At 00:18:25 UTC, health showed 37 successes,
38 deferrals, and 0 failures; the canary host's `snapshot_not_created` count
remained at 13. The shared host's count rose from 20 to 21 during its rollout
window. A longer post-rollout observation is still needed to establish the
deferral rate.

The same canary received another edit at 00:30:28 UTC. Scheduled snapshot
`2026-09-24T00:32:52.151Z` includes that marker and readback returned the
original timestamp. An explicit CLI snapshot made during this check was named
`manual-2026-09-24T00:30:16.230Z` by the server; manual snapshots are
intentionally excluded from rolling interval calculations, so it did not
exercise the new bay reconciliation branch. That branch has focused worker
coverage, but its exact stale-bay scenario remains unverified live. At
00:36 UTC, operator project recovery health was healthy: 54 successful, 39
deferred, and 0 failed attempts in 24 hours, with zero unknown statuses.

## Open findings and release gates

1. Browser UI testing is pending the staging2 CLI fresh-auth approval. Frontend
   automated checks and static smoke passed, but the actual project status UI
   has not yet been exercised in a browser.
2. The bay backup file index was not produced by the scheduled path. The
   recoverable Rustic snapshot and `last_backup` report were confirmed, but
   any release criterion requiring a bay file index for each backup remains
   open until its indexing policy and writer are confirmed and tested.
3. The plan's full observability and scheduler contract remains broader than
   the current code: pressure-time and capacity reports, operator drill
   reporting, and gated automatic rollout are not yet present. A versioned
   schedule cache with a 10-minute ownership lease, event-triggered due work,
   mutation-boundary assignment checks, bounded host/bay attempt history, and
   24-hour timing/byte metrics are now deployed; the full inventory still
   reconciles on a 15-minute timer. Individual SQL rows have not been inspected
   live because audited SQL requires fresh operator auth, but the aggregated
   operator health query returned new completions and due-to-success metrics.
4. The requested seven-day canary, 30-day due-to-success objectives, paid/free
   production distributions, interactive latency comparison, and restore
   drills across repository shards require observation after code review and
   coordinated rollout. None is established by this single-day staging test.
5. Staging2's overall health has a separate pre-existing bay-backup restore
   warning. Project snapshot/backup health must be judged separately.
6. The host scheduler still uses a 15-minute initial delay and full
   reconciliation sweep. The canary event path completed in about 97 seconds
   after bay confirmation, but due timers, retry recovery, and responsiveness
   under large live inventories remain to be validated. The host's generation
   check cached this project's prior observation for about five minutes, so
   the edit-to-bay change detection interval was longer than dispatch itself.
7. The staging account hit its 16 active runtime sponsor-slot limit while
   creating the bay-history canary. `project create --start` returned a project
   ID and `started: true`, but the project remained `opened` and an immediate
   `project exec` timed out. A subsequent `project start --wait` identified the
   sponsor-slot denial. Stopping the already-verified stage-metrics canary
   released a slot; starting and testing the new project then succeeded. This
   is a staging test-capacity constraint and a CLI status issue, not evidence
   that the snapshot/backup worker failed.
8. The 24-hour deferral counter is cumulative, so the two fixes for
   `snapshot_not_created` need a longer post-rollout observation. The exact
   stale-bay/local-snapshot case has an automated test but could not be
   reproduced through the public snapshot CLI because it labels explicit
   snapshots as manual. Live normal scheduled snapshots and marker readback
   succeeded on the new host artifact.

Do not promote this change to production until the open code and UI findings
are reviewed and the operational gates are planned with the maintainer.
