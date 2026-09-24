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
- Debt by host and storage funding class: `5a995de11511`. Staging hub
  artifact `20260924T004104Z-5a995de1-20260924T0040Z-5a995de1-recovery-debt-groups-dirty`
  passed smoke. The owning bay aggregates overdue count, oldest delay,
  unknown status, and repeated failures by host, class, and operation. At
  00:43:47 UTC, operator health identified two overdue free snapshot
  obligations on shared host `8cd90870-e58f-4979-b87f-cf85f3622324`,
  oldest three minutes; those obligations were no longer overdue at the
  00:47:58 UTC check.
- Atomic backup success ownership fence: `23a157e59034`. Staging hub
  artifact `20260924T004410Z-23a157e5-20260924T0045Z-23a157e5-backup-assignment-fence-dirty`
  passed smoke. The `last_backup` database update now requires the reporting
  host to remain assigned at write time. A focused test changes assignment
  between preliminary validation and the update. A manual backup on canary
  project `b528cb8d-797c-464c-8f60-1508789595c2` succeeded under this
  build at 00:46:57 UTC: Rustic snapshot
  `87e4d20d64038ec72aab53488e0e3607b6f49a74b8aef8443a022cfba274cbbc`
  was listed from the repository. Restoring
  `recovery-canary/reconcile-latest.txt` to a separate file and comparing
  bytes returned the original `2026-09-24T00:30:28Z` marker.
- Confirmed remote backup identity in the maintenance ledger: `020e90100d`.
  Hub artifact
  `20260924T010422Z-020e9010-backup-identity-020e901-dirty` passed hub
  smoke. Project-host artifact
  `20260924T010640Z-020e9010-backup-identity-020e901-dirty` completed
  canary-first rollout `636cae6a-a7b7-4fea-899e-28a9bd49ac4b` on both
  online hosts, and both host smoke checks passed. Scheduled reports now carry
  the ID confirmed by repository readback into bay status and attempt history.
  Focused tests, package builds, frontend typecheck, and actual PGlite
  execution of the status and attempt insert SQL passed.
- Audited backup-health diagnostic for the current index-less browser:
  `d1ce105b2b`. Hub artifact
  `20260924T012157Z-d1ce105b-backup-catalog-diagnostic-d1ce105-dirty`
  passed smoke. It reports `latest_scheduled_backup_id` and the bay report
  time beside `last_backup`, and labels older SQLite sidecars as legacy index
  data. The installed CLI can invoke this diagnostic without a CLI upgrade.
- Host storage-pressure duration and telemetry coverage: `d80c657f4a`,
  followed by validity and active-project fixes `52f41b8483` and
  `a6f74b90a1`. Final staging hub artifact
  `20260924T014310Z-a6f74b90-recovery-pressure-final-a6f74b9-dirty`
  passed smoke. The owning bay stores bounded pressure-state samples and
  reports 24-hour normal, contended, emergency, recovery, and unavailable
  durations for hosts with provisioned projects. A host without a valid
  pressure reading for five minutes triggers critical recovery health.
  Database integration tests (12), database/server builds, and SQL execution
  against PGlite passed.

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
| Backup catalog and file browsing                                          | New backups intentionally use a bounded Rustic metadata browser instead of SQLite sidecar indexes (commit `fc7c75ebc5`). The fresh canary backup listed `confirmed-id.txt`, restored it byte-for-byte, and reported the same remote ID and timestamp to the owning bay. A null legacy index timestamp is expected.                                                                                                                                                                              |
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
`b528cb8d-797c-464c-8f60-1508789595c2`. The confirmed-ID canary is
`3441c07a-894a-4080-bf8b-acf2bc27d043`. The stage-metrics canary and the
older assignment-fenced canary were stopped after their restore drills to
free staging runtime sponsor slots; all disposable projects remain on
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

At 00:44 UTC, both online hosts reported normal storage admission with no
admission deferrals since their most recent restart. The canary had 5 assigned
projects and 4 running; the shared host had 16 assigned and 13 running. Both
reported healthy disk and Btrfs metadata capacity with no derived host
capacity alerts. These are point-in-time safety checks; staging2's operator
UX-latency check lacked enough samples for a p95 comparison. At 00:47:58 UTC,
project recovery health was healthy again, with 70 successful, 41 deferred,
and 0 failed attempts in the preceding 24 hours, no overdue project, and no
unknown status. The cumulative `snapshot_not_created` counter remained 36;
its post-rollout rate still requires a longer observation window.

At 01:10 UTC on September 24, fresh project
`3441c07a-894a-4080-bf8b-acf2bc27d043` on the canary host contained marker
`confirmed-id-canary-2026-09-24T01:10Z`. The backup catalog listed remote ID
`46b41ca02c9891ff178699fed31876c4c64cdf98c51f05b79d755342ed03eadb`
at 01:10:49 UTC. The project backup file browser listed `confirmed-id.txt`
through Rustic metadata, and the restored file matched the original
byte-for-byte. The audited `backup-health` diagnostic at 01:24 UTC showed
`last_backup` at 01:10:49.374 UTC, `latest_scheduled_backup_id` equal to the
restored ID, and the scheduled bay report observed at 01:10:52.787 UTC. This
verifies the deployed scheduled report end to end. The diagnostic's legacy
index timestamp was null, as expected for the current index-less browser. At
01:15 UTC, project recovery health showed 101 succeeded, 41 deferred, and 0
failed attempts over 24 hours, with zero unknown statuses; at 01:17 UTC it
was healthy with 105 succeeded, 41 deferred, 0 failed, and no overdue or
unknown status.

At 01:45 UTC, the pressure-health rollout covered both online hosts with
projects: `staging2-agent-messaging-canary` and `staging2-shared-1`. The
operator summary reported zero hosts missing recent valid pressure telemetry,
134 successful, 41 deferred, and zero failed maintenance attempts in 24
hours. Each host reported zero minutes of contended, emergency, or recovery
pressure in the sampled period. Earlier metrics rows lacked the new pressure
field, so approximately 1,431 minutes appeared as unavailable; a complete
24-hour pressure baseline begins only after the rollout. Hub smoke passed.

At 01:53 UTC, hub release `20260924015326-hub` from commit `744b5ed1b3`
deployed as artifact
`20260924T015155Z-744b5ed1-20260924T-recovery-load-744b5ed1-dirty`.
The hub route probe and all seven smoke checks passed. Operator recovery
health was healthy with zero unknown statuses, zero paying critical debt,
zero hosts missing recent storage pressure telemetry, 145 successful,
41 deferred, and zero failed attempts in 24 hours. The new observed-load
view counted 116 distinct free snapshot due obligations on the shared host,
with 0.35 execution slot-hours and 0.37 queue-wait hours; the canary host
had 39 distinct free snapshot obligations and 0.07 execution slot-hours.
The local PGlite integration test verified that two attempts for the same
due obligation count once while their execution and wait costs both count.
These are observed costs, not a calibrated safe maintenance budget or proof
of sustainable capacity. The backup and paid-class samples remain too small
for a capacity threshold.

Commit `936b2e3bce` changed the default first host reconciliation from
15 minutes after startup to a stable per-host delay of 60 to 120 seconds;
the explicit initial-delay setting still overrides it. The 29 focused
project-host scheduler tests and package build passed. Project-host artifact
`20260924T015744Z-936b2e3b-20260924T-recovery-startup-936b2e3b-dirty`
completed canary-first rollout `e1b68f1b-2123-4a19-9ec3-9ade08df9f25`
on both online hosts at 02:00:57 UTC. Both project-host smoke checks passed.
The unit test verifies the default bound. During the next rollout, the
shared host logged a memory-pressure skip at 02:07:13 UTC and another at
02:08:13 UTC, exactly one minute apart. The first skip
reported 12.3 GB available memory but 40.19% memory PSI full average over
10 seconds, so the worker correctly preserved host responsiveness. The
logs do not identify whether either call came from the full-sweep timer or
an event batch, which also retries after one minute. The full-sweep retry
was verified by a focused timer test in commit `100deca107`; project-host
artifact `20260924T020415Z-100deca1-20260924T-recovery-retry-100deca1-dirty`
completed canary-first rollout `3ee77df8-1577-42d5-9427-acb6ef6f62a4`
on both hosts at 02:07:13 UTC. Both host smoke checks passed. At 02:10 UTC,
operator recovery health was healthy with 163 succeeded, 41 deferred, and
zero failed attempts in 24 hours, zero unknown statuses, and zero overdue
delay.

Commit `3ce0996dd2` closes a second full-sweep gap: if an event batch owns
one lane, the full sweep processes the free lane but returns incomplete so
the retry revisits the occupied lane. All 30 focused scheduler tests and the
package build passed. Project-host artifact
`20260924T020916Z-3ce0996d-20260924T-recovery-overlap-3ce0996d-dirty`
completed canary-first rollout `cd676d8e-ed88-4ad0-8dec-03c77a27dd20`
on both hosts at 02:12:33 UTC. Both host smoke checks passed; operator
recovery health was healthy with 164 succeeded, 41 deferred, zero failed,
and zero unknown statuses in the 24-hour window.

Commit `a97db13222` added a low-cardinality full-sweep log with trigger,
completion state, and duration. Project-host artifact
`20260924T021459Z-a97db132-20260924T-recovery-sweep-log-a97db132-dirty`
completed canary-first rollout `cb76df50-d4b0-4c62-b647-94749e01b22f`
on both hosts at 02:18:07 UTC; both host smoke checks passed. The canary
host logged `startup, reconciled=true` at 02:17:44 UTC in 48 ms. The shared
host logged `startup, reconciled=false` at 02:18:55 UTC under 55% memory
PSI full average, then `retry, reconciled=true` at 02:20:51 UTC after a
55.9-second full reconciliation. At 02:21 UTC, operator recovery health was
healthy: zero overdue delay, zero unknown statuses, zero hosts missing
recent pressure telemetry, 175 succeeded, 41 deferred, and zero failed
maintenance attempts in 24 hours. The staging account still has no paying
recovery sample, so this does not validate paying priority or objectives.

## September 24 paying warnings, operator debt report, and restore drills

Commit `2fb546cf38` adds a project-level warning for critical local snapshot
or off-host backup delay. The owning bay resolves the current storage payer
when a due time crosses the two-hour snapshot or 12-hour backup incident
threshold. The warning links to the appropriate project recovery view. A
focused server test checks usage-account funding, frontend tests check paid
and free visibility and keyboard navigation, and the server and frontend
builds plus frontend lint passed. Staging2 hub artifact
`20260924T023958Z-20260924T023833Z-2fb546cf-2fb546cf38-recovery-warning-dirty`
and static artifact
`20260924T024128Z-20260924T024052Z-2fb546cf-2fb546cf38-recovery-warning-dirty`
deployed successfully. The hub passed seven smoke checks, and static smoke
verified 3,301 current or previous content-addressed assets. A real paid
breach has not been induced on staging2, and browser UI testing is still
waiting for the first-party staging2 login approval.

Commit `3db7b894bf` adds the five oldest overdue projects per storage class
and recovery kind to operator health, with project ID, host, due time, and
delay. The list remains bounded while walking the entire bay inventory.
The focused server test and build passed. Hub artifact
`20260924T024628Z-20260924T024503Z-3db7b894-3db7b894bf-recovery-oldest-debt-dirty`
deployed, and all seven hub smoke checks passed. At about 02:48 UTC,
`admin health --wide` listed a newly due free snapshot for project
`b528cb8d-797c-464c-8f60-1508789595c2`, with its exact due time and
host, confirming that the new operator detail is live. The overall project
recovery level was warning for that brief delay: zero paying critical debt,
zero unknown statuses, zero hosts missing recent pressure telemetry, and
204 succeeded, 41 deferred, zero failed attempts in the prior 24 hours.
The next check returned healthy with the project absent from the debt list
and 205 succeeded attempts, confirming that the brief warning cleared after
recovery.

Fresh remote-only restore drills succeeded on both staging2 project hosts.
On the canary host, Rustic backup
`46b41ca02c9891ff178699fed31876c4c64cdf98c51f05b79d755342ed03eadb`
restored `recovery-canary/confirmed-id.txt` into a separate file in project
`3441c07a-894a-4080-bf8b-acf2bc27d043`; both files had SHA-256
`c3a848943654991ef2de9d997efc29873b6415c5b688b29b21874dada231f3f6`.
On the shared host, Rustic backup
`3e575fd771127b3e233c408d30d4663a11a2a68efc54f3edf1d12cba2d7ab67d`
restored `recovery-canary/marker.txt` into a separate file in project
`ac76eb98-13fc-43f5-b207-30c70313b5e8`; both files had SHA-256
`db3f6c46072e81a7817771def53035af3535bb4067581ac48026c0cb55a6b1a2`.
Both restore operations returned `succeeded`, and byte comparisons returned
zero. These are two host samples, not evidence of coverage across every
repository shard or paying class.

The repo-built operator CLI's audited `admin db project-recovery` diagnostic
worked against staging2 for the confirmed-ID canary. Audit ID
`2755029a-c391-4828-9161-8a88617b7528` returned five recent attempt
rows in 1 ms, including outcome, due time, bounded stage durations, host,
service class, and backup identity. Commit `f184c3964d` adds focused tests
showing that a storage payer change is reflected by the next host inventory
and that paid backup work retries after a running free backup releases the
nonpreemptible lane. The server and project-host package builds passed, as
did all seven host-status and 31 scheduler tests. This commit changes tests
only, so the staged runtime remains the preceding hub and host artifacts.

Commit `9297945372` treats a report without an explicit funding class from
an older host as `unclassified` in both the bay projection and attempt
history. Operator health now counts explicit unclassified critical debt,
instead of silently classing it as free. Fifteen focused server tests and the
package build passed. Hub deployment
`20260924T030021Z-20260924T025857Z-92979453-9297945372-recovery-unclassified-dirty`
passed all seven smoke checks. The post-deployment project recovery check
showed zero paying critical debt, zero unclassified critical debt, zero
unknown statuses, and zero hosts missing pressure telemetry. Its 24-hour
attempt counts were 218 succeeded, 41 deferred, and one failed; the next
check counted 219 succeeded. The single failed attempt was a free backup on
the shared host, grouped as reason `other`. This report does not establish
its exact cause or whether that specific project recovered. An audited raw
SQL query to identify it returned `fresh_auth_required`; the first-party
elevation is still pending. The failure remains an open staging finding.

## September 24 follow-up: shadow mode and lost backup acknowledgement

Commit `e645027217` adds a per-host shadow mode for snapshot and backup
reconciliation. It walks and orders the complete inventory, then logs bounded
paying/free/unclassified due counts, retry waits, and oldest delay without
running maintenance or publishing status. The default remains active. All 33
focused scheduler tests and the host package build passed. The flag has not yet
been exercised live on a staging host.

A fresh operator session identified the single failed free backup as project
`cc7b8e16-ccdc-41b3-88cc-4680924230e5` on the shared host. The failed
attempt at 02:57:44 UTC was a 408 timeout from `hosts.recordProjectBackup`.
The bay nevertheless recorded `projects.last_backup=2026-09-24T02:56:54.651Z`.
The worker's failed status remained after the retry time, because the next
change-aware due time had moved forward. Commit `7194de8890` fixes this:
when the bay's confirmed backup time covers the failed due obligation, the
host reads the matching off-host Rustic snapshot before clearing the stale
failure. Unrelated failures remain visible. Focused host tests passed 34/34,
server tests 7/7, and conat, server, and host package builds passed.

Staging2 hub artifact
`20260924T032427Z-7194de88-recovery-reconcile-7194de88-20260924-dirty`
passed seven smoke checks. Project-host artifact
`20260924T032650Z-7194de88-recovery-reconcile-7194de88-20260924-dirty`
completed canary-first rollout `179985a9-0bd7-447a-86a3-582d10d137d4`
on both online hosts. Project-host smoke passed. The affected project's live
backup status became `succeeded` at 03:32:19 UTC with reason
`confirmed_backup_after_failed_report`, Rustic ID
`f924d45d391477aed5734d8f6e2d638f90cc583b2e2e849f2dc5c79ec6fbcc0b`,
and next due `2026-09-25T02:56:54.651Z`. The original failed attempt
remains in 24-hour history for operational accounting.

The first-party testing browser registered when launched at the project list
under the designated non-admin account (browser `P8N9JVJ2ZU`). Typed actions
opened the canary's Project Settings and Recovery section. The [Recovery
settings screenshot](screenshots/staging2-recovery-settings-testing-account-2026-09-24.png)
shows the latest backup and snapshot ages, and the automatic backup schedule
opened read-only for this collaborator. The [file listing screenshot](screenshots/staging2-project-host-auth-error-testing-account-2026-09-24.png)
shows `failed to sign in - Error: missing project-host bearer token`.
Full workspace entered a reconnect loop; the backup browser did not finish
loading. The same file-listing failure occurred on the shared-host testing
project. Thus the recovery summary has a partial live UI check, while file and
backup browsing remain blocked on the testing account and require follow-up.

## September 24 follow-up: recovery status in Settings

Commit `81f7b3f18b` places the shared hub-reported snapshot and off-host
backup protection status in Project Settings -> Recovery. The prior Settings
view displayed only the last backup age; the file-browser status remains
available there as before. This lets a user see confirmed points, overdue
obligations, and unknown reporting in a hub-backed view when the project-host
file view is unavailable. The Settings flyout and status tests passed 11/11;
frontend lint and the frontend package typecheck passed.

Staging2 static artifact
`20260924T040232Z-81f7b3f1-recovery-settings-81f7b3f-20260924-dirty`
deployed successfully and passed static smoke checks. A non-admin testing
browser (`HD9UEU7M6B`) opened the canary project. Its browser logs continued
to show repeated `missing project-host bearer token` responses from the
project-host connection, despite an existing project-host session cookie. The
typed browser screenshot timed out and the QuickJS screenshot path returned a
syntax error, so this run did not produce a visual confirmation of the new
Settings status. The browser issue is a UI qualification blocker, separate
from the backup-worker and restore-drill results above.

An audited staging2 funding check found no active paid subscription or
purchase/site/team-license-backed membership grant. Staging2 therefore has
no genuine paying-funded project sample for a live priority check. Do not
substitute an admin-assigned membership for a paid funding contract.

## Open findings and release gates

1. Browser UI qualification is partial. The testing account reached Project
   Settings, the Recovery summary, and the read-only backup schedule. The file
   listing and backup browser could not connect to either project host because
   the browser lacked a project-host bearer token. Diagnose this auth path,
   then retest the full recovery interface and warning states.
2. The plan's full observability and scheduler contract remains broader than
   the current code: a calibrated safe-capacity threshold, operator drill
   reporting, and gated automatic rollout are not yet present. A versioned
   schedule cache with a 10-minute ownership lease, event-triggered due work,
   mutation-boundary assignment checks, bounded host/bay attempt history, and
   24-hour timing/byte metrics are now deployed; the full inventory still
   reconciles on a 15-minute timer. The audited backup-health diagnostic
   confirmed the latest scheduled ID, and the repo-built one-project
   diagnostic returned raw attempt rows under an audit ID. The aggregated
   operator health query returned new completions and due-to-success metrics.
3. The requested seven-day canary, 30-day due-to-success objectives, paid/free
   production distributions, interactive latency comparison, and restore
   drills across repository shards require observation after code review and
   coordinated rollout. None is established by this single-day staging test.
4. Staging2's overall health has a separate pre-existing bay-backup restore
   warning. Project snapshot/backup health must be judged separately.
5. The host scheduler now uses a 60-to-120-second initial delay and a
   15-minute full reconciliation sweep, with one-minute retries after a skipped
   sweep. A pressure-blocked startup followed by a successful full-sweep
   retry was observed live; due-timer recovery after a restart and host
   responsiveness under a large live inventory remain to be validated. The
   canary event path completed about 97 seconds after bay confirmation; its
   generation check cached the prior observation for about five minutes, so
   edit-to-bay change detection took longer than dispatch.
6. The staging account hit its 16 active runtime sponsor-slot limit while
   creating the bay-history canary. `project create --start` returned a project
   ID and `started: true`, but the project remained `opened` and an immediate
   `project exec` timed out. A subsequent `project start --wait` identified the
   sponsor-slot denial. Stopping the already-verified stage-metrics canary
   released a slot; starting and testing the new project then succeeded. This
   is a staging test-capacity constraint and a CLI status issue, not evidence
   that the snapshot/backup worker failed.
7. The 24-hour deferral counter is cumulative, so the two fixes for
   `snapshot_not_created` need a longer post-rollout observation. The exact
   stale-bay/local-snapshot case has an automated test but could not be
   reproduced through the public snapshot CLI because it labels explicit
   snapshots as manual. Live normal scheduled snapshots and marker readback
   succeeded on the new host artifact.
8. The free backup's lost hub acknowledgement is now reconciled live after
   repository readback. Its failed attempt remains in the 24-hour historical
   counter. Continue watching for repeated hub report timeouts and confirm
   later scheduled backup cycles complete normally.

Do not promote this change to production until the open code and UI findings
are reviewed and the operational gates are planned with the maintainer.
