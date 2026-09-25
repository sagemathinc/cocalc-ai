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

## September 24 follow-up: browser authentication and virtual backup preview

Commit `3786059f1c` preserves the browser session cookie across the
project-host Conat WebSocket upgrade and adds a rate-limited diagnostic that
records only whether authentication headers are present. The host package
build and 52 focused tests passed. Project-host artifact
`20260924T041938Z-3786059f-recovery-auth-diagnostic-3786059-20260924-dirty`
completed canary-first rollout `e0a864d1-77bd-41c2-8d07-38863794cdfc`
on both online hosts. The browser still showed the old authentication failure
until the separately managed Conat router was rolled out on the canary host
(`442c8a78-2839-4c96-a035-cad00fd0640e`) and shared host
(`dd74de8a-d009-4a98-af8c-573b5864d3dd`). Both router rollouts succeeded.
The testing account then authenticated and loaded the file listing. This
shows that a project-host artifact rollout alone left the router running its
older bundle; the deployment procedure must update or explicitly check the
router component when its code changes.

The non-admin testing account then showed live confirmed recovery points in
[Project Settings](screenshots/staging2-recovery-status-settings-testing-account-2026-09-24.png):
latest local snapshot at September 23 21:16:09 browser time and latest off-host
backup at September 23 00:07:35 browser time, with next due times alongside.
The [backup catalog](screenshots/staging2-recovery-backup-browser-testing-account-2026-09-24.png)
listed four dated backups, including the same latest off-host point. Expanding
that backup exposed a separate UI defect: the inline preview tried to read
`.backups/<timestamp>` through the ordinary filesystem and displayed [an `ENOENT` error](screenshots/staging2-recovery-backup-catalog-testing-account-2026-09-24.png).

Commit `3f5ee76525` routes inline backup previews through the existing Rustic
archive listing hook, resolves snapshot preview paths through the explorer's
virtual-path mapping, and keeps virtual recovery previews read only. It also
makes preview entries keyboard operable and labels the close control. Two
focused component tests, the frontend package typecheck, and frontend lint
passed. Static artifact
`20260924T043908Z-3f5ee765-20260924T0445Z-3f5ee765-recovery-peek-dirty`
deployed to staging2 and passed bay health checks. A first upload attempt
stalled in SSH/SFTP; a clean retry installed release `20260924044209-static`.
After a hard browser refresh, the [same backup preview](screenshots/staging2-backup-peek-postfix-expanded-2026-09-24.png)
expanded without an error and showed `Empty directory`, consistent with this
canary project's empty home. The focused test also covers a nonempty archive
listing and keyboard opening of a file. To exercise the live file path, I wrote
`recovery-ui-canary/marker.txt` in canary project
`1793a413-42c9-49cf-8a2e-0abd641e8b28` and created a manual backup. The
operation succeeded with Rustic ID
`dc18d24937595e3f3ce69dd3805fa24c55edfe78c8061b1ae79a9c232820a310`
at 04:50:45 UTC. In the non-admin browser, the [inline preview showed the
folder](screenshots/staging2-backup-nonempty-peek-2026-09-24.png), and opening
it listed `marker.txt`. The [backup file preview](screenshots/staging2-backup-nonempty-marker-open-2026-09-24.png)
showed the exact `staging2-backup-preview-20260924` marker. I used the UI
Restore to /tmp action, then read
`/tmp/recovery-ui-canary/marker.txt` inside the project through `project exec`;
it returned the same marker with exit code 0. The original project file was
left in place.

A further code review found that a file clicked directly inside an expanded
backup folder skipped the special backup selection handler. Commit
`ae3f8c0422` routes inline preview file clicks through that handler, including
snapshot files. Two focused peek tests, frontend typecheck, and lint passed.
Static artifact
`20260924T050951Z-ae3f8c04-20260924T0509Z-ae3f8c04-recovery-peek-open-dirty`
deployed to staging2 as release `20260924051216-static` and passed bay health
checks. In the non-admin browser, I expanded `recovery-ui-canary` inside the
new backup and clicked `marker.txt` from the [inline file row](screenshots/staging2-backup-direct-peek-file-2026-09-24.png).
The [backup selection modal](screenshots/staging2-backup-direct-peek-file-preview-2026-09-24.png)
opened with the exact marker content. The first navigation into this backup
showed a [timeout screen](screenshots/staging2-backup-direct-peek-root-ready-2026-09-24.png); clicking Refresh loaded the same directory. That
intermittent catalog delay remains a staging finding to watch.

At 04:47 UTC, `admin health --wide` marked project recovery healthy: zero unknown
statuses, zero overdue delay, and recent pressure telemetry on both online
hosts. The 24-hour history contained 336 succeeded, 53 deferred, and one
historical failed attempt; that failed backup was reconciled after repository
readback, while its attempt remains counted. The separate bay-backup restore
check still warned, and browser latency had insufficient samples. These
checks are a point-in-time staging result, not the seven-day canary.

## September 24 follow-up: automatic fleet recovery stop gates

Commits `f801a3d360` and `2e6b962d36` add a durable recovery health
baseline to each bay-local host runtime fleet rollout. The worker checks
project-recovery health, browser latency health, failed maintenance attempts,
backup debt age, emergency storage pressure, and pressure telemetry after each
wave. It saves upgraded and health-gated host IDs separately so a worker
restart checks a completed host before advancing. A global default promotion
also requires measured browser latency; an unmeasured cohort pauses instead of
being promoted.

The server package typecheck, 17 focused PGlite tests, and full development
build passed. Hub artifact
`20260924T054144Z-2e6b962d-recovery-latency-gate-2e6b962-dirty`
was active on staging2 as release `20260924054330-hub`; all seven hub smoke
checks passed. A same-version, two-host canary campaign with global promotion
disabled succeeded as operation
`76fb590e-d063-453f-9e21-dd5ffac035f6`. Its durable record contains
baseline and post-wave snapshots plus both passed host IDs. A second
same-version campaign requested global promotion and paused as intended:
operation `06c46d8d-fee6-43c6-8147-a02d4f30a221` reported that
interactive latency was unmeasured and global promotion required browser
latency samples. The existing global project-host version and previous rollout ID
were unchanged. At 05:44:53 UTC, post-test project-recovery health was healthy
with zero unknown or overdue statuses; browser latency still had no samples.
The negative test used the same already-deployed host artifact, so it tested
the gate without introducing a new project-host build.

A final cohort fix in commit `d7db3a7d4e` rechecks every already-upgraded
host after each later wave, including campaigns without global promotion.
Hub artifact `20260924T054830Z-d7db3a7d-recovery-cohort-gate-d7db3a7-dirty`
is the current staging2 hub release `20260924055018-hub`. All seven hub
smoke checks passed. Same-version campaign
`5182f247-372b-4d87-a74e-c12b1362d84c` succeeded with both host IDs
in its durable passed list; baseline and final project-recovery levels were
healthy. The post-campaign operator check at 05:51:37 UTC remained healthy
for project recovery, while browser latency remained unknown.

This proves live admission and fail-closed promotion behavior for the unknown
latency case. It does not prove the latency regression threshold under actual
load, a seven-day canary, or a 30-day due-to-success objective.

## September 24 follow-up: four-shard remote-only restore drills

I created four isolated staging2 projects on the canary host, each assigned to
a distinct active backup repository shard, wrote a unique marker, and created
an off-host Rustic backup while the project was stopped. I moved each project
to the shared host, restored the original backup into a temporary path, and
verified the marker hash. The initial cross-host restores succeeded, but could
have used Rustic's local cache. Commits `2f760bcc25` and `54f5d4ea55` added a
`--remote-only` restore option and allowed the corresponding `--no-cache`
flag through both privileged and sandboxed restore paths. The first live
remote-only attempt exposed the missing sandbox allowlist entry; after the
second commit and host rollout, all four remote-only restores succeeded.

| Shard repository                       | Project                                | Original backup                                                    | Remote-only restore operation          | Marker SHA-256                                                     |
| -------------------------------------- | -------------------------------------- | ------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------ |
| `712f48f7-2d11-4a69-9359-2c80ec83f548` | `aa9d72ea-bd4c-460e-b479-2760cc8b9c29` | `21aa4e7d38341c3f240b8bb121b2b130c813daeeb192a084467ef4a28720fa62` | `15b39241-81c0-458a-9485-30a00855fa22` | `07a35b2d36c6a506d333fe49c39a13d3b73c2fea27602d5ce970bef47a96d5e0` |
| `bea69159-87f7-498e-84a0-5b0560a84f03` | `85793315-15ec-4cab-b062-ee7fcae065c6` | `f2772c1213d69fdd0f4e2136f1dd7293051a373c7a077539809f1ac8e3e867b9` | `46870c18-fef1-423f-9000-6a3e9cd04e97` | `2b79a7230500070ed124c5515fdf8ceae0f8b4fb031ae56bcb9751ef7a72a297` |
| `f3c8309a-b085-4c5d-905b-ec939a5815d1` | `2bf70bcc-b77e-4288-876f-65250eeab79a` | `9edb08069db3bcd24ace0bc4fba8629086573a6dd8499c485f9d257d1d9744a9` | `bc45acd5-d792-44eb-b656-3ef970164726` | `cde05fbf5644d47e55fd7e8099da0095d748e657cda5070d1b6b0c824f7bf220` |
| `fcf896d9-7e29-4c54-93ce-c5cb84024956` | `9dab607d-1839-4f8c-90e3-874de7b5f451` | `08fb8bb97587382e8133497359521ba5e168258b9a278589268e851a43faa78c` | `b00fa9b0-445f-452b-b5fd-3048163c6b9e` | `fc22bf3409ce4121ff77f98be6d222988fee7a116a11f9f9439670af4d5fc53f` |

Every restore operation reports `status=succeeded` and
`result.remote_only=true`. I read each restored file through the project
file API while the project was stopped and computed SHA-256; all four matched
the original marker. All four projects remain stopped (`state=opened`) on
`staging2-shared-1`. This tests one repository in each active shard and a
canary-host-to-shared-host data move. It does not constitute long-term
retention testing or a production restore drill.

The full development build, touched package typechecks, 13 project-backup API
tests, six project-host Rustic wrapper tests, 109 bootstrap tests, and eight
sandbox Rustic tests passed. The helper artifact
`20260924T061738Z-2f760bcc-20260924T0618Z-2f760bcc-remote-only-dirty`
was installed on both hosts. The hub artifact
`20260924T061912Z-2f760bcc-20260924T0620Z-2f760bcc-remote-only-dirty`
is active as release `20260924062058-hub`; seven hub smoke checks passed.
The final project-host artifact
`20260924T063316Z-54f5d4ea-20260924T0635Z-54f5d4ea-cache-allow-dirty`
is running on both staging2 hosts as explicit host overrides, and both hosts
passed project-host smoke checks. The bay global project-host default was not
promoted.

The first project-host fleet campaign
`4edd3ef3-de74-4230-945c-5f0d9c75339a` stopped at its recovery health
gate after two free projects on the shared host became briefly overdue for
local snapshots during restart. The gate recorded healthy baseline and warning
post-wave recovery, then refused global promotion. The host scheduler
subsequently caught up and recovery returned to healthy before the final
host-by-host patch rollout. The remote-only drill itself caused fresh free
snapshot debt on the shared host: at the immediate post-test check, seven
projects were overdue by at most two minutes, including two drill projects.
There were zero paying incident-threshold breaches, zero unknown statuses,
and recent pressure telemetry on both hosts. Scheduled maintenance cleared the
four drill projects' snapshot debt without manual intervention; the audited
status query at 06:43:47 UTC recorded new successful local snapshots, and
`admin health` returned project-recovery=healthy with no overdue debt at
06:44:26 UTC. The short warning and gate stop remain real staging observations.

## September 24 follow-up: audited remote restore attempts

Commit `9bb79f9fce` adds `admin db project-restore-drills`, an audited,
bounded operator view of remote-only project restore operations. It can filter
one project and a 1-to-365-day lookback and reports the operation status,
backup ID, current repository shard and host assignment, and timing. It does
not display restored file paths or contents, and it does not label an operation
as externally hash-attested. The current repository/host columns describe the
project assignment when the diagnostic runs, not a historical assignment
snapshot. Operation retention limits how far back the view can actually see;
a durable drill ledger and automatic content attestation remain open.

The focused CLI suite passed 59 tests; Conat, server, and CLI typechecks and the
full development build passed. Hub artifact
`20260924T070322Z-9bb79f9f-20260924T0655Z-9bb79f9f-restore-view-dirty`
is active on staging2 as release `20260924070847-hub`. The first deploy
attempt ended when SSH closed during `scp`, before staging the release; a
retry of the same immutable artifact succeeded. All seven hub smoke checks
passed. The source-built CLI returned five audited rows under audit ID
`170d36a9-4b11-41c2-87d9-a072388f4015`: the four successful shard
restores and the first failed cache-allowlist attempt. The four successful
rows map to four distinct current backup repository IDs.

CLI artifact `20260924T070953Z-9bb79f9f-20260924T0710Z-9bb79f9f-restore-view-dirty`
built successfully. A staging2 CLI deploy was rejected because CLI deployment
targets global `dev`, `candidate`, or `stable` installer channels, not a
site profile. No channel was promoted. The checked-in and source-built CLI
contains the new operator command; the installed `/opt` CLI remains older.

## September 24 follow-up: durable drill evidence and responsive Recovery UI

Commits `acc17dbdfa` and `4a86d48bd4` add an immutable bay-side operator
attestation for a successful remote-only restore. It records the restore
operation, backup, project, repository and host assignment at attestation time,
the expected and observed SHA-256 values, the operator, and a reason. The
operator view labels this evidence `operator_supplied`; it is not a
host-generated content signature. The view continues to return attested drills
after operation-record retention deletes the LRO, and its lookback is measured
from restore completion. A PGlite test deletes the LRO and verifies both
retention and the 30-day window. Fresh admin authentication and an audit event
are required to record evidence.

The final hub artifact
`20260924T081501Z-4a86d48b-20260924T0817Z-4a86d48-drill-window-dirty`
is active on staging2 as release `20260924082032-hub`. Hub smoke passed.
I downloaded each restored marker from its stopped project, recalculated SHA-256,
and recorded four passing attestations, one per active repository shard. The
audited diagnostic `21db47f3-168a-4452-bd6c-bbf0f42a3f0e` returned all
four passing attestations plus the earlier failed cache-allowlist restore.
A repeated attestation returned `created=false`. The source-built CLI
contains `admin db project-restore-drill-attest`; no global CLI installer
channel was promoted. Focused PGlite tests, CLI admin tests, touched package
typechecks, and the earlier full development build passed. The broader CLI
suite still has unrelated legacy chat-send failures.

Live Chromium testing on staging2 exposed a narrow-width Recovery layout
defect: descriptions collapsed into one-character lines at 390 CSS pixels.
Commits `d17f105f4d` and `982446521c` stack the recovery actions and
constrain their buttons at compact widths. Commits `cdde41ca11` and
`4f7e79869d` return focus to Create Snapshot after its dialog closes;
the second commit fixes a stale closure in the shared close listener.
The final static artifact
`20260924T085636Z-4f7e7986-20260924T0859Z-4f7e798-focus-owner-dirty`
is active on staging2. Static smoke, frontend lint, typecheck, and focused
keyboard tests passed. In the live browser at 320 CSS pixels, the page had no
document overflow, the Create Snapshot button fit inside its card, Enter opened
the dialog, and Escape closed it and returned focus to that button. The
[320-pixel Recovery view](screenshots/staging2-recovery-320-2026-09-24.png)
and [desktop Recovery view](screenshots/staging2-recovery-1280-2026-09-24.png)
are saved for review. One earlier browser attempt briefly showed the generic
CoCalc crash overlay after Escape; subsequent attempts did not reproduce it,
and its cause is not established.

At 09:04:08 UTC, project-recovery health was healthy with zero unknown statuses,
zero paying incident-threshold breaches, and recent pressure telemetry on both
hosts. The shared host reported 505 distinct free snapshot obligations and
1.48 execution slot-hours over 24 hours; free snapshot due-to-success p95 was
114 seconds from 597 completions. These staging values do not calibrate a
production safe-capacity threshold. Overall staging2 health remained warning
because bay-backup restore/PITR had no completed backup and browser latency
telemetry had no samples.

## September 24 follow-up: repeated dialog focus validation

A repeated keyboard check found that the prior zero-delay focus restoration
raced Ant Design's closing transition: the first Escape returned focus, but
later cycles could leave focus on the page body. Commit `c0289d1a23` keeps
the dialog mounted through its close transition and restores focus in the
transition callback. The focused component test now closes it three times in
succession; all six snapshot-dialog tests, frontend typecheck, and lint passed.

Static artifact
`20260924T091441Z-c0289d1a-20260924-focus-transition-c0289d1-dirty`
is active on staging2 as release `20260924091554-static`. All seven static
smoke checks passed. In a separate authenticated Chromium tab at 320 CSS
pixels, 12 consecutive Enter/open and Escape/close cycles returned focus to
the Create Snapshot button every time. The page had no document overflow,
visible crash overlay, or JavaScript page errors. This strengthens the focus
result but does not establish the cause of the earlier one-off crash overlay.

## September 24 follow-up: unknown status and inventory load canary

A fresh disposable project first displayed two live Recovery alerts at 390 CSS
pixels: local snapshots and off-host backups both said current protection
status unknown, showed no confirmed recovery point, and retained the missed
due time. The page had no document overflow or JavaScript errors. After the
worker ran, the same view displayed confirmed snapshot and backup times. The
[desktop unknown-state view](screenshots/staging2-recovery-unknown-1280-2026-09-24.png)
and [390-pixel unknown-state view](screenshots/staging2-recovery-unknown-390-2026-09-24.png)
are saved for review. This qualifies the live unknown-to-confirmed transition;
a live blocked-reason warning still needs qualification.

I created 80 empty projects on staging2-shared-1 between 09:30:31 and
09:30:47 UTC, raising its provisioned inventory from 18 to 98. All 80 initial
snapshot checks correctly reported `no_content_change`. Their p95
creation-to-check time was 578 seconds. All 80 initial off-host backups
succeeded by 09:48:27 UTC, including three that first deferred for
`lifecycle_active` and then retried. Backup creation-to-success p50/p95/p99
was 798/1044/1058 seconds; audited operator query
`b8cd5fe0-af5f-4127-8384-d2e1e801148d` contains the timing aggregate.
During the run, one sampled host check showed 28.5% CPU, 11.4 GiB available
memory, storage admission allowed, and no capacity alert. These are short
staging observations on empty free-class projects, not a production latency
baseline or a 500-project live inventory test.

Code inspection after the first batch found a gap in event dispatch:
provisioning acknowledgement was not notifying the maintenance queues. The
first reports arrived during the full-reconciliation window; that timing is
consistent with waiting for the sweep. Commit `4956908676` emits a bounded scheduler candidate only
after the owning bay accepts the host's provisioned report. The existing
assignment and schedule checks still run before mutation. Both focused
project-host test files passed (41 tests), as did the package typecheck.
Artifact
`20260924T094846Z-49569086-20260924-provisioned-dispatch-4956908-dirty`
was built and published. The generic fleet rollout skipped both pinned hosts;
explicit canary-first host upgrades succeeded on the canary and shared hosts,
and project-host smoke passed.

On the upgraded canary host, a new project created at 09:57:31 UTC received its
no-change snapshot check about 16 seconds later and a confirmed off-host
backup about 22 seconds later. It started in 3.7 seconds, wrote and read a
marker through project exec, and stopped cleanly. After pressure subsided on
the upgraded shared host, another new project created at 10:35:43 UTC received
its snapshot check about 16 seconds later and backup about 20 seconds later.
The canary host had a stale pre-upgrade synthetic probe claim and then
recorded a passing automatic probe at 10:10 UTC.

A second 80-project batch immediately after the shared-host upgrade could not
qualify dispatch latency: global memory PSI full average rose above 50% even
though roughly 11.5 GiB of RAM was available. The worker correctly skipped
risky maintenance with `memory_pressure`; host status remained current and
admission/capacity checks showed no separate alert. I stopped the load test
and deleted both 80-project cohorts, their test backups, and the individual
canaries. The shared host returned to 17 provisioned projects. At 10:39 UTC,
project-recovery health was healthy with zero unknown statuses and zero paying
incident-threshold breaches. Pressure and safe-maintenance capacity still need
calibration using a longer representative canary and production baseline.

## September 24 follow-up: host memory gate visibility

The second load batch exposed a visibility gap: the scheduler skipped all
maintenance when global memory PSI exceeded its guard, before any project
received a deferred attempt. Commit `67c2409d46` publishes the latest
host-wide memory gate decision in the host heartbeat, attaches a fresh blocked
reason to owning-bay recovery status, and shows that reason in overdue and
unknown Recovery alerts. Operator project-recovery health now lists blocked
hosts. It also fails closed with `memory_measurement_unavailable` when
meminfo or enabled PSI telemetry cannot be read. Commit `01e334c666`
preserves this gate in the normalized `host metrics` view. The gate is
reported once per host check, avoiding per-project writes during pressure.

Focused tests passed: 36 snapshot/backup scheduler tests, 17 owning-bay
status tests, 8 Recovery UI tests, and 26 host-metrics normalization tests.
Conat, project-host, server, and frontend package typechecks and frontend lint
passed. The staging2 hub releases `20260924105839-hub` and
`20260924110837-hub`, static release `20260924110258-static`, and
project-host artifact
`20260924T105933Z-67c2409d-20260924-memory-gate-67c2409-dirty`
were deployed. Both project hosts were upgraded explicitly, canary first.
Hub, static, and project-host smoke checks passed. An audited read-only bay
query (audit `a9a9f4da-fe46-4b67-bd33-cb83b3f995c8`) confirmed a fresh
canary heartbeat gate with memory PSI 0; `host metrics` now shows that gate.
At 11:10 UTC, staging2 project-recovery health was healthy: zero unknown
statuses, zero paying incident-threshold breaches, zero hosts at the memory
safety gate, and zero hosts missing recent storage pressure telemetry.

At 11:11 UTC, the upgraded shared host reported a live `memory_pressure`
gate with memory PSI full avg10 at 31.45%. Project-recovery health changed to
warning and named that host, the block reason, and the measurement. At 11:12,
the next gate check reported PSI 0 and cleared the block. One disposable project
was created to check the user view, but pressure had already cleared before it
could qualify a blocked alert; its delete operation completed with backups
purged. No pressure injection was used.

A live pressure-blocked Recovery alert has not yet been captured after this
rollout. The browser text and bay freshness rules are covered by focused tests;
a live blocked-state capture remains an open UI qualification. The previous
80-project pressure event and this shared-host block verify the scheduler guard
and operator warning.

## September 24 follow-up: restart due timer and memory-gate duration

Commit `bab90ad289` adds a focused scheduler test that reconstructs a
known future due timer after host scheduler restart. Its project-host test file
passed all 37 tests. A live staging2 check then created disposable canary
project `94d31e68-cec6-4e0b-aebf-d05ac1930d5d`, changed its marker
after its first scheduled snapshot, and restarted only the canary project-host
daemon with rollout `e557efce-a390-4f21-9480-ee195a6f4e0a`.
The first full reconciliation after restart ran at 11:21:20 UTC; the next
would not run until roughly 11:36. The existing due time was 11:32:39 UTC.
Polls found one snapshot through 11:32:31, then a second Btrfs snapshot at
11:32:40.460 UTC. The project file still contained the changed marker after
restart, and the browser Recovery view showed the new confirmed snapshot.
This verifies that the rebuilt due timer dispatched before the next full
reconciliation. The test project was later deleted through the first-party
CLI with normal seven-day backup retention.

Commit `417ccd17db` stores a bounded sample of fresh host-wide memory
maintenance gate decisions and reports their 24-hour duration by reason in
operator recovery health. The PGlite metrics tests passed 12/12; database and
server package typechecks passed. Hub release `20260924113527-hub` deployed
to staging2; hub health and all seven smoke checks passed. At 11:37 UTC,
project-recovery health was healthy with zero unknown statuses, zero paying
incident-threshold breaches, zero hosts at the memory gate, and zero hosts
missing recent pressure telemetry. Its detail now lists memory PSI,
available-memory floor, and measurement-unavailable minutes for each active
host. All three were zero in that check. The 24-hour metric starts when the
new samples are collected; historical blocked time before this release is
not reconstructed. Browser-observed UX latency still had no qualifying
samples, so this check does not establish the canary latency gate.

## September 24 follow-up: browser latency traces on the canary

The signed-in staging2 Chromium session recorded 11 real project starts on
the disposable canary, stopping it between starts. At 11:51 UTC, the
60-minute browser lifecycle p95 was 2.7 seconds across 11 samples versus
the configured 10-second warm-start threshold. Admission p95 was 318 ms,
backend p95 2.1 seconds, and frontend convergence p95 91 ms. The same
session opened the changed marker through the file editor and created a
terminal. Terminal-ready p95 was 351 ms, project-exec readiness 2 ms,
file-content paint p95 527 ms from two opens, and file sync readiness p95
704 ms from two opens. The browser showed the changed marker and a live
shell prompt. Project-recovery health stayed healthy with zero unknown,
overdue, or paying incident-threshold statuses. The canary was stopped
afterward.

The disposable project's base image initially had no Jupyter kernel,
pip, or ensurepip. I installed Ubuntu's `python3-ipykernel` package in
that project only, confirmed the live notebook recognized the Python 3
kernelspec, and ran its prepared cell through the browser. The output
matched `staging2-jupyter-readiness`; the live notebook was saved.
At 11:58:43 UTC, operator UX-latency health was healthy: Jupyter readiness
176 ms, lifecycle p95 2.7 seconds from 11 starts, terminal 351 ms, exec
2 ms, file-content paint 561 ms and file sync 709 ms from five opens.
Project-recovery health remained healthy, and the canary was stopped.
These low-load, single-project traces establish the full telemetry path
and basic interactive behavior. They do not compare against a production
baseline, exercise sustained maintenance contention, or satisfy the
seven-day canary gate.

## Open findings and release gates

1. Recovery Settings, project files, and the backup catalog load in the
   non-admin staging2 browser. A nonempty backup was browsed, previewed, and
   restored through the UI. A live overdue snapshot warning was visible in
   the 320-pixel Recovery view, and keyboard navigation, dialog closing, and
   focus restoration passed in Chromium. The unknown state and its transition
   to confirmed protection passed live; blocked warnings still need live
   qualification. Focused component tests cover both states. One
   earlier browser attempt briefly showed the generic crash overlay, without
   a reproducible cause. Archive browsing had one timeout before Refresh.
2. The plan's safe-capacity threshold is still uncalibrated. Durable
   operator-supplied hash attestations and the remote-only restore view are
   deployed on staging2, with four passing shard drills. Automatic fleet
   recovery stop gates run there. A 100-project empty-backup queue produced
   ten browser start samples below the warm-start threshold. Seven later
   scheduled backups uploaded 1.75 GiB of real file data, with 11 successful
   interactive exec probes overlapping an upload. Browser-observed latency
   during sustained large-byte load and a longer comparison window are still
   required for promotion. The versioned schedule cache, ownership lease,
   event dispatch, assignment checks, host/bay attempt history, and 24-hour
   timing/byte metrics are deployed. Full inventory still reconciles on a
   15-minute timer; observed load cannot establish the 70% safe budget
   without a longer canary and production baseline.
3. The requested seven-day canary, 30-day due-to-success objectives, paid/free
   production distributions and interactive latency comparison require
   observation after code review and coordinated rollout. One remote-only
   cross-host restore succeeded in each staging2 repository shard; production
   restore drills and retention-window coverage remain open.
4. Staging2's overall health has a separate pre-existing bay-backup restore
   warning. Project snapshot/backup health must be judged separately.
5. The host scheduler now uses a 60-to-120-second initial delay and a
   15-minute full reconciliation sweep, with one-minute retries after a skipped
   sweep. A pressure-blocked startup followed by a successful full-sweep
   retry was observed live. A bounded 80-project inventory canary completed,
   and due-timer recovery after a restart passed live. A live 525-project
   inventory and backup queue completed on September 24. A later 100-project
   queue allowed same-host browser start and file-open probes, while under-load
   browser terminal and Jupyter readiness remain unqualified. The canary event
   path completed about 97 seconds after bay confirmation; its generation
   check cached the prior observation for about five minutes, so
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

9. A bay-local five-minute recovery notification worker, named on-call
   setting, incident grouping, and daily oldest-debt report are deployed on
   staging2. Trusted incidents now queue immediate critical-lane email even
   when ordinary maintenance email is disabled. A named on-call account is
   configured and the recipient confirmed delivery of the daily recovery-debt
   report. The notification switch was returned to off after the drill. A live
   critical incident drill and any external paging integration remain
   unvalidated. Production alert activation is a separate operational gate.

## 2026-09-24 recovery notification staging rollout

Commit `8592bca8ce61ed6b21a6f4e75ed9f0483844fcc2` adds a bay-local
five-minute notification worker. It considers paid snapshot and backup
threshold breaches, repeated paid failures, paid queues with no recent
completion, missing host pressure telemetry, and overdue work whose funding
class is unknown. Incidents are grouped by affected host lanes and deduplicated
by durable message subject. A once-per-UTC-day report includes oldest free and
paid debt. Configuration requires an administrator account on the owning bay;
the feature switch defaults to off. Messages use the account-notice delivery
path. An external pager or acknowledgement flow has not been tested.

Validation before rollout: the full development build passed; the server and
util package typechecks passed; three focused suites passed all 10 tests; the
frontend lint and formatting checks passed. The staging2 hub artifact
`20260924T122351Z-8592bca8-20260924-recovery-notifications-8592bca-dirty`
was deployed as release `20260924122550-hub`. Migration and worker health
passed, followed by the hub smoke check. The matching static artifact
`20260924T122625Z-8592bca8-20260924-recovery-notifications-8592bca-dirty`
was deployed as release `20260924122723-static`; its smoke check passed,
including 3,400 current and previous content-addressed assets. No project-host
artifact changed in this rollout.

The live `admin settings get` response showed
`project_recovery_notifications_enabled=false` and an empty
`project_recovery_oncall_account_id`. At 2026-09-24 12:26 UTC, the
`project-recovery` health check was healthy and explicitly said operator
notifications were disabled pending configuration. It counted zero paying
threshold breaches, zero unknown-class overdue projects, zero unknown statuses,
and zero hosts missing recent pressure telemetry. Overall site health remained
warning from other existing checks; this is not a recovery-health failure.
No notification was sent as part of this test.

To finish the notification gate, select a named staging on-call administrator,
enable the switch only for a controlled incident drill, verify account notice
delivery and acknowledgement, then decide whether a distinct external paging
integration is required. Keep production disabled until that gate and the
seven-day canary, 30-day objectives, production restore drills, safe-capacity
calibration, and remaining UI/live-load findings are complete. The disposable
staging test project `94d31e68-cec6-4e0b-aebf-d05ac1930d5d` was later
deleted through the first-party CLI with normal seven-day backup retention.

## 2026-09-24 critical operator email staging rollout

Commit `d713ec27d762` closes a delivery-policy gap: ordinary support or
maintenance email preferences could previously disable immediate email for a
recovery incident. A trusted system incident now creates an in-app error notice
and queues required, immediate email on the critical lane. User-authored
messages cannot request this priority. The daily debt report keeps its normal
policy. This strengthens delivery routing but does not prove that an email was
sent, received, acknowledged, or connected to an external paging service.

The full development build passed. Focused tests passed: 11 util policy tests,
12 database projection tests, and 9 server message/worker tests. The database
test follows an incident through the account-notice projection to a queued
critical-lane email despite disabled ordinary email preferences. The immutable
hub artifact `20260924T124426Z-d713ec27-20260924-recovery-critical-email-d713ec2-dirty`
was deployed to staging2 as release `20260924124616-hub`. Worker health and
hub smoke passed. No frontend or project-host artifact changed.

At 2026-09-24 12:46 UTC, live project-recovery health was healthy, with no
paying threshold breaches, unclassified late debt, unknown statuses, or hosts
missing pressure telemetry. The switch remained off and the on-call account ID
empty. The critical email lane was configured to inherit the site SendGrid
backend. No test incident was sent. The next operational check needs a named
staging on-call account with a verified email address, a controlled enabled
incident, and inspection of the email outbox plus recipient receipt and
acknowledgement. Production remains unchanged.

## 2026-09-24 operator delivery readiness health gate

Commit `d05ebe82dd72` makes the project-recovery operator health check
critical if notifications are enabled without a named on-call administrator or
without a usable critical email backend. Invalid backend settings are reported
as a configuration fault instead of crashing the entire health query. The
disabled default remains healthy. Three focused configuration tests and the
server package build passed. The immutable hub artifact
`20260924T125123Z-d05ebe82-20260924-recovery-alert-readiness-d05ebe8-dirty`
was deployed to staging2 as release `20260924125314-hub`. Its worker health
and hub smoke check passed.

At 2026-09-24 12:53 UTC, live recovery health remained healthy with zero paid
threshold breaches, unknown states, or hosts missing pressure telemetry. The
notification switch was still off. The enabled-state critical health path was
validated by focused tests, not by changing live site settings. A named staging
recipient and controlled delivery drill are still required before enabling it.

## 2026-09-24 signed-in Chromium start and recovery health check

The staging2 Chromium session on port 9222 was signed in and showed the
recovery canary's project Settings. Explicit Start controls were exercised on
the disposable project while the staging2 CLI confirmed the runtime reached
`running` and later `opened` after each stop. The rolling 60-minute
browser-observed lifecycle sample at 13:09 UTC contained six starts, with p95
2.8 seconds versus the 10-second warm-start threshold. Admission p95 was
451 ms, backend p95 1.6 seconds, and convergence p95 216 ms. The health check
correctly remained `unknown` because its lifecycle gate requires ten recent
samples; terminal, Jupyter, exec, and file samples had also aged out of this
window. A later reload/navigation race in the probe prevented a clean ten-cycle
sample. This is a low-load single-project observation, not a sustained
maintenance-latency result.

At 13:09 UTC, project-recovery health was healthy: zero paying threshold
breaches, unknown recovery statuses, and hosts missing recent pressure
telemetry. The 24-hour ledger counted 1,037 succeeded, 142 deferred, and one
failed attempt. Free snapshot due-to-success was p95 77 seconds and p99 272
seconds over 861 completions; free backup was p95 964 seconds and p99 1,058
seconds over 175 completions. These are staging observations, not evidence of
30-day service-objective compliance. Site-wide health still warned for
separate bay-backup, admin-alert, and synthetic-smoke checks.

Automatic starts were briefly blocked on this disposable project to prevent
its open terminal and notebook tabs from waking it during the explicit-start
test. The original Allowed setting was restored and verified; the temporary
browser tab was closed; the final CLI status was `opened` (stopped). No
production state or alert-delivery setting changed.

Do not promote this change to production until the open code and UI findings
are reviewed and the operational gates are planned with the maintainer.

## 2026-09-24 interval scheduling and Bees pressure canary

Commit `7a339ffea8` schedules verified snapshot interval waits without holding
an active worker slot. Its focused host tests passed (38/38), server
maintenance-status tests passed (18/18), the integration checks passed (3/3),
package typechecks passed, and the full development build passed. The hub
artifact `20260924T132546Z-7a339ffe-20260924-recovery-interval-wait-7a339ff-dirty`
was deployed as release `20260924132859-hub`; hub smoke passed. The matching
project-host artifact was installed on the canary. A restart caused global
memory PSI to rise above 50%, the conservative host gate deferred scheduled
work, and snapshot debt accumulated. The canary was rolled back to the prior
`67c2409d` project-host artifact while the source was investigated. The shared
host was never upgraded to `7a339ffea8`.

Per-cgroup inspection attributed the pressure to `cocalc-bees`: its
`memory.current` was approximately 1.09 GiB against a 1 GiB `memory.high`,
while the project pool, maintenance, host services, and other top-level
cgroups had zero memory PSI and the host had more than 5 GiB available.
Stopping three test projects did not reduce the pressure. A controlled,
temporary increase of the Bees soft limit to 1.5 GiB brought both Bees and
global PSI below 1% and recovery health returned to healthy. The original
1 GiB limit was restored and verified. The pressure persisted after the
rollback, so this observation does not attribute the Bees workload to the
interval-scheduling change.

Commit `81a6162d01` now attributes isolated Bees cgroup pressure before
applying the global memory gate. It admits at most one maintenance worker
only when Bees is at its soft limit, its PSI accounts for global PSI, other
required cgroups are quiet, and host available memory meets the preferred
floor. Missing or inconsistent cgroup measurements remain fail closed. The
attribution appears in host telemetry. Focused host tests passed (40/40),
server normalization tests passed (27/27), relevant package typechecks passed,
and the full development build passed.

The `81a6162d01` hub artifact
`20260924T141313Z-81a6162d-20260924-recovery-bees-pressure-81a6162-dirty`
was deployed as staging2 release `20260924141524-hub` and passed hub smoke.
The project-host artifact
`20260924T141600Z-81a6162d-20260924-recovery-bees-pressure-81a6162-dirty`
was installed only on `staging2-agent-messaging-canary` and passed host smoke.
The restart reproduced the original condition: Bees PSI exceeded 40% and
global full PSI exceeded 29%, while host available memory remained about
5.3 GiB and other top-level cgroups read 0%. At 14:18:41 UTC the first
maintenance sweep reported `pressure_attribution: bees_cgroup` with global
full PSI 36.18%; at 14:19:20 it did so again with PSI 55.06%. No canary
snapshot or backup debt appeared. By 14:21:47 UTC, recovery health was
healthy with zero overdue/unknown work and zero hosts at the memory gate;
Bees and global full avg10 had returned to 0%. The 1 GiB Bees soft limit
remained in place. The shared host stayed pinned to the earlier
`67c2409d` artifact. No production host or alert setting changed.

This is a short staging restart canary, not the plan's seven-day comparison
or safe-capacity calibration. Keep the shared host pinned until interactive
p95/p99 latency under sustained maintenance, longer due-to-success behavior,
and the wider rollout gates are reviewed. The 30-day objectives, production
baseline and restore drills, a live inventory above 500 projects, and alert
recipient/delivery drill remain open.

## 2026-09-24 daily report delivery and 30-day objective accounting

The staging2 on-call account was set to
`cc82e1f9-b452-42ae-9904-4c29ac1f24a4`. Notifications were enabled briefly
for a controlled daily-debt delivery test, then disabled and verified off. The
transactional outbox recorded one successful delivery attempt at 15:55:57 UTC
to the account's verified address with no error. The recipient confirmed that
the recovery daily debt email reached their inbox. This validates the daily
report path; it does not exercise a live critical-incident alert or recipient
acknowledgement for that lane. The named on-call account remains configured.

Commit `6633901f66` adds durable, daily per-project due-obligation counters
for the proposed paid/free snapshot and backup objectives. It addresses the
128-attempt history cap, which could otherwise discard evidence before a
30-day review. Counters are written transactionally with the maintenance
status and attempt, and are idempotent across retries and repeated reports.
The health view excludes the two newest UTC due days so even the 24-hour free
backup target has matured. A collection-age flag is not evidence that every
host reported continuously; unknown and stale hosts still need separate
review. Focused PGlite tests passed 23/23, the server package typecheck passed,
and the full development build passed.

The hub artifact
`20260924T160541Z-6633901f-20260924-recovery-slo-6633901-dirty` was deployed
to staging2 as release `20260924160821-hub`. Hub smoke passed, including the
project-host route probe. At 16:08:56 UTC, recovery health showed zero paying
incident breaches and zero unknown project statuses; the new 30-day objective
view correctly said `collecting`. At 16:09:18 UTC, an audited read-only query
found one objective state and one daily row, with one due obligation, one
confirmed success, and one on-time success. This verifies live persistence and
readback, not 30-day compliance. The first 30-day window requires a full
collection period and validation of host coverage. Production remains
unchanged; the shared staging host still uses the previously pinned artifact.

## 2026-09-24 greater-than-500 inventory and missed-due preservation

To exercise the live keyset inventory beyond two 250-project pages, 525
disposable, stopped projects were created on `staging2-shared-1`. Their exact
IDs are recorded in `tmp/recovery-scale-canary-20260924-ids.txt` for cleanup.
The admin account's original 250-project limit was temporarily raised to 650
with a typed, audited entitlement override expiring at 20:00 UTC; no previous
override existed. This must be cleared after deleting the test projects.

All 525 projects were provisioned and assigned to the shared host. The full
inventory sweep produced a snapshot status for every one, proving it crossed
the page boundary. Most empty-project snapshots were correctly marked
`no_content_change`; lifecycle deferrals remained visible. Off-host backups
then drained through the independent backup lane while project recovery health
showed the unreported tail as unknown. By 17:05 UTC all 525 backups were
confirmed with distinct, non-null repository IDs, none failed, and recovery
health showed zero unknown snapshot or backup statuses. Due-to-confirmed-backup
was p50 841 seconds, p95 1,987 seconds, p99 2,087 seconds, and max 2,113
seconds. Cleanup is in progress. These empty projects test inventory coverage
and queue behavior, not realistic upload bytes or the 30-day service
objectives.

During the backup queue, ten explicit stop/start plus exec smoke probes on an
existing staging project all succeeded. Start p95 was 2.32 seconds and total
probe p95 was 3.04 seconds. Host maintenance I/O pressure was 0%, the memory
gate stayed clear, and available memory stayed around 11 GiB during sampled
checkpoints. These are backend probes; the browser-observed terminal, Jupyter,
file, and lifecycle health window remained unknown and still needs a sustained
UI canary.

Commit `cd627c72f1` fixes a due-time reset found while inspecting the live
queue: a later edit must not move an already missed snapshot or backup due
time forward. The owning bay now includes the current snapshot outcome and
due timestamp in host inventory, and both lanes retain an unfulfilled earlier
due time. A newer confirmed recovery point releases the old debt. Focused
project-host tests passed 42/42, bay host-status tests passed 7/7, conat,
server, and project-host package typechecks passed, and the full development
build passed. The hub artifact
`20260924T164303Z-cd627c72-20260924-recovery-due-preservation-cd627c72-dirty`
was deployed as staging2 release `20260924164505-hub` and passed hub smoke.
The matching project-host artifact
`20260924T164743Z-cd627c72-20260924-recovery-due-preservation-cd627c72-dirty`
was installed only on `staging2-agent-messaging-canary` and passed host smoke.
The shared host remained pinned during its scale backup queue. A controlled
live edit on the canary raced with an already completed backup, so it did not
prove the missed-due-after-later-edit case; the focused regression test is the
evidence for that exact condition. The disposable live canary project was
deleted with the normal seven-day backup retention after the test.

## 2026-09-24 queued-obligation accounting

The 525-project queue exposed a denominator gap in the newly deployed 30-day
objective counters: a due backup waiting behind other backups appeared as
unknown in live recovery health, but was not included in the historical
obligation denominator until the worker reported an attempt. Commit
`714dbc8265` makes the host publish due snapshot and backup queue status before
dispatch. Queue status creates a durable objective obligation and visible
project debt without inflating attempted-maintenance or deferral metrics. A
snapshot inventory result of `no_content_change` or
`snapshot_interval_wait` cancels a provisional objective; a tombstone prevents
a delayed queue report from recreating false debt. The Recovery view explains
the queued state in plain language.

Focused bay integration tests passed 8/8, host scheduler tests passed 43/43,
frontend lint passed with zero errors or warnings, and the full development
build passed. Immutable hub, project-host, and static artifacts were built and
uploaded. The static artifact
`20260924T173906Z-714dbc82-20260924-recovery-queue-714dbc8-dirty` was
deployed as release `20260924174234-static` and passed smoke, including 3,410
current and previous content-addressed assets. After the 525-project cleanup,
the hub artifact
`20260924T173633Z-714dbc82-20260924-recovery-queue-714dbc8-dirty` was
deployed as release `20260924175120-hub`, passed migration and hub smoke, and
reported healthy project recovery. The project-host artifact
`20260924T173802Z-714dbc82-20260924-recovery-queue-714dbc8-dirty` was
installed on `staging2-agent-messaging-canary` and `staging2-shared-1` in that
order; both host smoke checks passed. The first canary smoke immediately after
upgrade ran before the host was relisted and failed `host not found or not
listed`; the retry after a fresh heartbeat passed. One short memory-gate
warning immediately after the shared host restart cleared on the next health
check; recovery health then showed zero unknown statuses and zero current
memory gates.

The 525-project deletion journal exactly matched the original ID manifest, and
an audited bay query found zero remaining live scale projects. The temporary
admin `max_projects` override was cleared and verified absent. One disposable
canary had its backup purged at deletion; the other 524 used the normal
seven-day backup retention.

A second live canary created 12 disposable projects on the upgraded shared
host. At 17:55 UTC, eight backup status rows read `deferred/queued` while four
had already succeeded. The bay objective state had all 12 backup obligations
with six confirmed successes by the next sample, plus 12 canceled provisional
snapshot obligations after `no_content_change`; there were zero `queued`
maintenance attempts. By 17:56 UTC, all 12 backup statuses read `succeeded`
and all snapshot statuses read `skipped/no_content_change`. Their cleanup uses
normal seven-day backup retention. All 12 delete operations succeeded; the
delete journal matched the original ID list, and an audited bay query found
zero remaining live canary projects. At 17:57:54 UTC, project recovery health
was healthy with zero unknown statuses and zero current memory gates.

This closes the observed **reported inventory queue** gap. A host that never
reconciles, including one blocked before listing by a memory safety gate, can
still be absent from the historical denominator. Unknown/stale host and
project health remains a separate stop signal. A durable coverage audit over
the full 30-day window is required before objective percentages can be
qualified as complete.

## 2026-09-24 critical email delivery drill

Commit `0350f1070d` adds a fresh-auth, admin-only critical email drill. It
requires a valid drill UUID, a named local administrator on-call, and an
available critical email backend. It sends a plainly labeled test through the
same required account-notice critical lane as project recovery incidents,
independent of the routine notification switch. The UUID identifies the test
and deduplicates retries within the one-hour message deduplication window. It
does not manufacture project debt or enable routine alerts.

Focused server tests passed 2/2, dangerous-RPC registry tests passed 5/5, CLI
admin tests passed 61/61, the conat and CLI builds passed, and the full
development build passed. The immutable hub artifact
`20260924T181255Z-0350f107-20260924-recovery-critical-drill-0350f10-dirty`
was deployed as staging2 release `20260924181543-hub`. Migration, worker
health, host route checks, and hub smoke passed.

One live staging2 drill used ID
`85d5d9cf-eab5-48bb-90b3-d8695434a9ca` and returned message ID 41 for
the named on-call account `cc82e1f9-b452-42ae-9904-4c29ac1f24a4`. Audited
read-only query `17c61d56-e257-4899-8a91-4a4c6708bb0b` found exactly one
matching transactional outbox row: `lane=critical`,
`delivery_mode=immediate`, `status=sent`, `attempt_count=1`,
`sent_at=2026-09-24T18:17:14.322Z`, and no error. The recipient was asked to
confirm inbox receipt; that confirmation is pending. The named on-call remains
configured, and `project_recovery_notifications_enabled` was verified false
after the drill. This validates the staging send path and provider acceptance;
it does not establish recipient receipt until the on-call confirms it.

## 2026-09-24 durable objective coverage audit

Commit `18067e3f34` closes a qualification gap in the 30-day objective
report. The owning bay now samples its full eligible project inventory every
five minutes into durable fifteen-minute slots. Each slot retains the worst
observed unknown status, unaccounted due work, or host memory block. Due work
absent from the objective denominator after the hourly reconciliation bound is
visible in operator health and the incident plan. A report is `ready` only
after the complete mature 30-day UTC window contains all 2,880 slots with no
coverage gap; the first recorded obligation alone is insufficient.

Focused PGlite and server tests passed 36/36, including a generated full
2,880-slot window that qualified only while every slot was clean. The server
package typecheck and full development build passed. The immutable hub artifact
`20260924T183202Z-18067e3f-20260924-recovery-coverage-18067e3-dirty`
was deployed as staging2 release `20260924183635-hub`, and hub smoke passed.
The first deploy attempt failed during SSH setup before activation; remote
release inspection confirmed the prior hub was still current, and the retry
completed with migration, worker health, and host route checks passing.

Audited read-only query `72429481-7921-492b-9107-599ae0fc8cbe` found the
first live slot at `2026-09-24T18:30:00Z`: 23 eligible snapshots, 23 eligible
backups, zero unknown statuses, zero unaccounted due work, and zero blocked
hosts. The current operator health display reports these accounting-gap counts
as zero and the mature window as `0/2880` slots, correctly unqualified because
the new audit has not covered the earlier 30 days. This is one live sample,
not evidence of a complete 30-day objective.

## 2026-09-24 current Recovery UI and narrow-screen check

Using a signed-in nonadmin collaborator on the existing staging canary project,
a fresh Chromium context loaded Project Settings and activated its Recovery
link with keyboard focus and Enter. The live page showed a confirmed local
snapshot and off-host backup, each with a next due time; Create Backup was
present as a named button. The first-party browser screenshot and visible
selector commands timed out or returned a QuickJS parser error, so this UI-only
check used local Playwright with the same test account cookie held in memory.
The offered Chromium debugging port 9222 was not listening at the time of the
check.

The initial 320 CSS-pixel rendering squeezed the snapshot status text into a
62-pixel column and broke words apart. Commit `be349868da` reduces settings
page padding below the small breakpoint and omits the decorative alert icon at
that width. Focused frontend tests passed 10/10; frontend lint reported zero
errors or warnings, and the frontend TypeScript build passed. The immutable
static artifact
`20260924T185949Z-be349868-20260924-recovery-mobile-be34986-dirty` was
deployed to staging2 as release `20260924190036-static`; all seven static
smoke checks passed, including 3,422 current and previous content-addressed
assets.

A new signed-in Chromium context against that release again activated Recovery
with keyboard focus and Enter. At 1280 and 320 CSS pixels, both confirmed
status cards were present, the Create Backup button had an accessible name,
and document width equaled viewport width. At 320 pixels the snapshot status
text column measured 122 pixels, versus 62 before the fix. The reviewed
screenshots are
[`before at 320 pixels`](screenshots/staging2-recovery-320-before-compact-fix-2026-09-24.png),
[`after at 320 pixels`](screenshots/staging2-current-recovery-320-2026-09-24.png),
and [`after at 1280 pixels`](screenshots/staging2-current-recovery-1280-2026-09-24.png).
This establishes the healthy state and responsive presentation in the tested
project. A live blocked-state rendering and sustained browser latency during
maintenance remain open canary checks.

## 2026-09-24 shared-host browser load canary

One hundred uniquely named disposable projects were created through the
first-party staging2 CLI and assigned to `staging2-shared-1` (host
`8cd90870-e58f-4979-b87f-cf85f3622324`). Their IDs were journaled in
`tmp/recovery-ui-load-20260924-ids.tsv`. The project list confirmed exactly
100 matching live projects on that host. While the host reconciled them,
operator recovery health showed the temporary unknown inventory tail and an
overdue free backup queue. At the beginning of interactive probes it showed
51 overdue free backups; after ten browser starts it showed 31, with zero
unknown or unaccounted obligations, repeated failures, memory gates, or
missing pressure telemetry.

The audited read-only query
`e806479f-058c-4d5a-984d-763495d8acf0` found exactly 100 projects with
confirmed `last_backup` timestamps, 100 distinct confirmed backup IDs, and
zero failed backup statuses. The first and last confirmations were at 19:06:51
and 19:21:14 UTC. These empty projects exercise host inventory coverage,
backup queueing, and recovery status, but do not model large upload bytes.

Ten browser-initiated starts of an existing smoke project on the _same_ shared
host occurred while backups remained queued. The operator's 60-minute browser
latency check recorded lifecycle p95 3.0 seconds (10 samples) against the
10-second warm-start threshold, admission p95 266 ms, backend p95 2.5 seconds,
and frontend convergence p95 48 ms. Each observed start reached `running`,
and a typed stop returned the smoke project to its original `opened` state.
Ten additional typed start, exec, and stop cycles during the queue all
succeeded; their measured p95 values were 2.91, 1.04, and 1.52 seconds,
respectively, recorded in
`tmp/recovery-ui-load-lifecycle-fixed-20260924.tsv`. An earlier timing journal
used a variable-width fractional clock and is invalid as duration evidence;
the fixed-width rerun is the measurement cited here.

A marker file in that smoke project opened through the signed-in browser while
the backup queue was active. Two file-content paint samples yielded p95 355 ms
in operator telemetry; one collaboration-sync sample was 574 ms. A terminal
created near the end of the test produced a prompt and a 298 ms ready sample,
but the last of the 100 new backups had already completed, so that sample is
not an under-load terminal qualification. An existing notebook was opened
without edits after the smoke project was stopped; its kernel stayed loading, so
there is no under-load Jupyter readiness result from this canary. The marker
and test terminal file were removed, and the smoke project was verified
`opened` again.

The durable fifteen-minute coverage audit retained three unknown snapshot and
three unknown backup statuses in its 19:00 UTC slot even after current health
cleared them. This is the expected conservative record of the temporary
inventory tail. Both unaccounted due counts and the blocked-host count stayed
zero in that slot (audited query
`ed768455-1618-48ec-903f-6d7cc22c7e28`). This test slot cannot qualify a
clean 30-day objective window until it ages out. All 100 disposable projects
were then deleted through the typed CLI with the normal seven-day backup
retention and no immediate purge. Every returned operation was `succeeded`;
the deletion journal exactly matches the creation manifest. The project list
returned zero live matching projects, and audited read-only query
`4da932ca-c6d6-4071-8ebd-909085d4a238` found zero remaining matching
project rows after hard deletion. The existing smoke project was verified
`opened` after its test files were removed. A subsequent operator check showed
project recovery healthy with zero current snapshot or backup delay, unknown
status, unaccounted due work, memory gates, or missing storage pressure
telemetry.

## 2026-09-24 Recovery block wording

Commit `37d60ff551` fixes a status-label error found while comparing host
reason codes with the Recovery view. The host's `io_pressure_unavailable`
means storage pressure could not be measured; the UI had described that as
confirmed storage pressure. It now says measurement is unavailable and that
maintenance will retry. Existing host reasons for volume lifecycle changes,
legacy restore activity, and unconfirmed snapshot or repository backup
results also have distinct plain-language descriptions. Focused Recovery
status tests passed 13/13; frontend lint reported zero errors or warnings,
and the frontend TypeScript build passed.

The immutable static artifact
`20260924T194108Z-37d60ff5-20260924-recovery-block-reasons-37d60ff-dirty`
was deployed to staging2 as release `20260924194156-static`. All seven static
smoke checks passed, including 3,432 current and previous content-addressed
assets. A fresh signed-in nonadmin Chromium context at 320 CSS pixels still
showed the confirmed local snapshot and off-host backup statuses with no
document-level horizontal overflow. A live blocked project has not yet been
captured, so the new wording is qualified by focused component tests and the
post-deploy healthy-state browser check, not by a live blocked-state UI drill.

## 2026-09-24 Classified recovery failures

Commit `f92144b51a` classifies recognizable scheduled maintenance failures
before publishing them to the owning bay. Storage quota, managed backup upload
policy, repository confirmation, repository credentials, and object-store
unavailability now have distinct status reasons and Recovery view descriptions.
The raw error remains in the host log. Unknown errors retain the prior report
path so new failure modes remain diagnosable; the classifier is deliberately
limited to identifiable evidence in the error text. It does not establish that
every possible Rustic or object-store error form is classified. Focused tests
passed: 50 host tests and 16 Recovery UI tests. Project-host and frontend
TypeScript checks and frontend lint passed.

The project-host artifact
`20260924T195131Z-f92144b5-recovery-failure-reasons-20260924-dirty` was
published to staging2. The general rollout skipped both pinned hosts, so I
upgraded the canary host and then the shared host explicitly to that exact
version. Both returned successful upgrade operations and passed project-host
smoke checks. The static artifact
`20260924T195221Z-f92144b5-recovery-failure-reasons-20260924-dirty` was
deployed as release `20260924195335-static`; all seven static smoke checks
passed, including 3,442 current and previous frontend assets.

A fresh disposable project on the upgraded canary host received repository
backup `d572c5ffc2ff9f9402e912837c6f0aed9ad6af2879db01d8e645a8d36270180b`
at 19:56:44 UTC, visible through the typed backup-list API. It was deleted
successfully with the normal seven-day backup retention and no immediate
purge; the matching live project list is empty. At 19:57:15 UTC, project
recovery health was healthy with zero overdue, unknown, or unaccounted due
obligations and no active memory gate or missing recent storage telemetry.
The new error wording is covered by focused component tests and deployment
smoke checks; a genuine live credential or object-store failure was not
induced on the shared staging repositories.

## 2026-09-24 Jupyter during a shared-host backup queue

I created 36 disposable free-class projects on `staging2-shared-1`, the same
host as the existing smoke project's Jupyter kernel. The new projects entered
the scheduled off-host backup queue. At 20:03:19 UTC, an audited read-only
query (`e149745b-7c6c-44a8-b8f3-170da38033e5`) found only 14 of 36 with a
confirmed `last_backup`, establishing that the queue was active during the
20:02:17–20:02:39 UTC notebook runs. The temporary notebook used the typed
live Jupyter API and a Python 3 kernel; every run returned `42` and a completed
run event. Twelve consecutive runs passed, with CLI round-trip p95 3,241 ms.

Eight more checks restarted the same kernel and then ran the cell while the
queue continued. All passed, with combined restart-and-run p95 4,431 ms. At
20:04:23 UTC, 25 of 36 projects had confirmed backups (audit
`9575732d-7265-4053-a26a-65c546bbe2d4`), so the cold-path checks at
20:03:45–20:04:15 UTC also overlapped backup completion. These timings include
CLI and network round trips and are backend execution probes; they do not
replace browser-observed Jupyter readiness metrics.

All 36 projects had `last_backup` by 20:05:25 UTC (audit
`36afa07b-c29a-40b3-919e-99a91ac0b4ba`). Individual typed repository
listings found 36 distinct backup IDs with matching project IDs. The smoke
project was stopped, its temporary notebook removed, and all 36 disposable
projects were deleted with normal seven-day backup retention and no immediate
purge. The creation and deletion journals match exactly. The live project list
and audited project-row query `300b1194-0b86-461b-ac44-aa7eb37d8325` both
found zero remaining projects under the test prefix. At 20:13:38 UTC, project
recovery health returned healthy with zero overdue, unknown, or unaccounted
due obligations and no active memory or storage telemetry gate.

## 2026-09-24 Nonempty backup, byte restore, and delayed-report reconciliation

A disposable project on `staging2-shared-1` stored a 268,435,456-byte
high-entropy file. The scheduled off-host upload scanned 273,544,767 bytes,
uploaded 268,534,693 bytes, and committed repository backup
`ef25b2ba3ce462303b73d3d3b8ca7cde1e6cfaf8400fa45994bf8b7f09054ecf`
at 20:17:28 UTC. The typed backup browser listed the file at its expected
size. This qualifies an actual byte transfer beyond the earlier empty-project
queue canaries.

The host reported a newer change while validating the uploaded backup. The
repository and `projects.last_backup` showed success, but the maintenance
projection remained `deferred/change_generation_changed` for more than five
minutes. Commit `4500a4ffad` extends the existing lost-report reconciliation:
the host marks this case `succeeded` only after it independently finds the
exact later backup in the repository and confirms the previous due obligation
has been met. An absent repository copy does not reconcile. Forty-five focused
scheduler tests and the project-host TypeScript build passed.

The immutable host artifact
`20260924T202325Z-4500a4ff-recovery-postupload-reconcile-20260924-dirty`
was deployed to the pinned staging2 canary host and then the shared host.
Both passed project-host smoke checks after startup. The shared host's first
sweep was skipped by its transient memory safety gate. Its normal retry at
20:28:47 UTC, with no gate active, changed the disposable project's status to
`succeeded/confirmed_backup_after_changed_generation`, attached the exact
repository backup ID above, and retained the next due time of September 25
20:17:28 UTC (audited query `f5df7983-0bbb-44eb-ab15-bbe263600ea2`). The
fix did not force a maintenance run through the safety gate.

The typed restore operation `f07fe13d-1224-4770-a779-49490ec3b24e` restored
the backed-up file to a separate path in the same disposable project. Both
original and restored files had SHA-256
`e04b642fcef58a61e756434c0a26e45d82f57ddf4ca34b9396e2d59db345d21e`.
This verifies saved bytes through the standard restore path. It was not a
remote-only or cross-host restore drill; four earlier remote-only shard drills
cover that separate path. The project was stopped and deleted successfully
with seven-day backup retention and no immediate purge (delete operation
`95b66689-bda7-4144-b100-8adb525dd24e`). A live project-list query for its
unique title returned zero. Project recovery health subsequently reported
healthy: zero overdue, unknown, or unaccounted due obligations and no active
memory or storage telemetry gate.

Read-only staging2 membership audits `f6c9c643-6596-470f-adff-a61d2ac5cdd2`
and `0112b748-6537-4804-97a8-8463d5a6973d` still found no active
positive-cost subscription account or active membership grant. A genuinely
paying-funded staging2 canary therefore remains unqualified. The recipient
has separately confirmed receiving the daily recovery-debt email; the
critical-incident test email's inbox receipt remains unconfirmed.

## 2026-09-24 Scheduled large-byte queue and interactive exec probes

On `staging2-shared-1`, seven disposable projects each wrote a distinct
268,435,456-byte high-entropy file. Two additional projects were created but
remained unopened when the host had 16 running projects; their exec requests
timed out, so they were excluded from the data test and deleted. The seven
data projects produced seven distinct scheduled repository backups, each of
which listed the expected file at 268,435,456 bytes. Their durable attempt
rows reported 1,879,692,957 uploaded bytes in total (1.75 GiB), with backup
creation stages from 17,143 to 27,286 ms. The first group of four uploaded
1.00 GiB and the second group of three uploaded 0.75 GiB. The read-only
attempt audits are `a384758e-0fd0-4df0-9eae-cd721ebc0587` and
`61128e96-7247-4340-99a5-c51e78af6ea2`, respectively.

The first upload in each group committed a repository backup but initially
reported `deferred/change_generation_changed` because another change report
arrived during validation. Normal reconciliation later attached each exact
backup ID and marked both obligations `succeeded`. One project in the second
group deferred before upload and completed on its retry. A final audited
projection (`cf5aaf2b-b050-4de1-9ad8-ab48ac755041`) showed all seven with
`succeeded` backup status and the corresponding repository IDs. This extends
the post-upload reconciliation test from one file to a bounded queue.

The existing shared-host smoke project ran 70 timed typed `project exec true`
checks during the second queue. All succeeded. Matching probe start/end times
to the durable backup attempt intervals found 11 that overlapped an upload;
their CLI round-trip p95 was 1,060 ms and maximum was 1,060 ms. Across all 70,
CLI round-trip p95 was 1,038 ms and maximum 1,180 ms. The overlap sample is
small, includes CLI/network time, and measures command execution rather than
browser start, terminal paint, file sync, or Jupyter readiness. It cannot
qualify the plan's full interactive p95/p99 gate. The host reported normal
storage admission and no maintenance I/O pressure at sampled checks. The
24-hour operator view showed 2.00 GiB uploaded on the shared host after this
test, including the earlier 256 MiB canary; its safe sustained maintenance
budget still needs calibration.

The smoke project was stopped again. All seven data projects and the two
unopened projects were deleted with normal seven-day backup retention and no
immediate purge. Both live title-prefix lists were empty, and audited query
`d8a00d07-e983-4fc4-8c6b-6e9f329803b1` found zero remaining project rows
for all nine IDs. At 20:49:08 UTC, project recovery health was healthy with
zero overdue, unknown, or unaccounted due obligations and no active memory or
storage telemetry gate. The site's overall health remained warning for other
checks.

## 2026-09-24 Coverage audit after load testing

Audited read-only query `39af518a-a053-44a7-a535-e471d347d06b` found ten
consecutive fifteen-minute inventory coverage slots from 18:30 through 20:45
UTC. Every slot recorded zero unaccounted snapshot or backup due obligations
and zero blocked hosts. The 19:00 UTC slot retained three unknown snapshot
and three unknown backup statuses from the earlier temporary inventory tail;
the other nine slots had zero unknown statuses. Coverage collection began
after the first due-obligation record at 16:09 UTC. The first-day sample is
therefore incomplete, and the dirty 19:00 slot must age out of any eventual
clean 30-day qualification window. A current healthy operator check does not
rewrite that historical slot.

The repository-wide `pnpm -C src tsc` completed successfully after the
staging changes and load tests. `pnpm -C src lint:frontend` reported zero
errors or warnings across 3,696 frontend files. The available Chromium
debugging port was closed, and the previously known staging browser session
IDs timed out through the typed browser API, so this run did not add
browser-observed latency samples.

## 2026-09-24 paid customer recovery warning rollout

Commit `0d61977fe1` adds a distinct, default-off customer notice path for
paying-funded projects. The owning bay scans current schedules and confirmed
snapshot/backup timestamps, including projects for which no host attempt
report has arrived. It compares live debt against the paid objectives of 30
minutes after snapshot due time and 6 hours after off-host backup due time.
Before delivery, it rechecks bay ownership, current collaborators, current
funding, and current recovery status. It sends owners and collaborators a
durable account notice with a direct Recovery-settings link. A stable event ID
suppresses retries for the same project, recipient, operation, and due event;
the customer switch is independent of operator incident and daily debt mail.

Focused PGlite tests passed 37/37, including the paid objective boundaries,
recipient selection, funding downgrade, recovery completion, and ownership
change. The full `pnpm -C src tsc` build and frontend lint passed. The hub
artifact
`20260924T212053Z-0d61977f-recovery-customer-warnings-0d61977-dirty`
was deployed as staging2 release `20260924212236-hub`; migration, worker
health, host routing, and all seven hub smoke checks passed. The static
artifact
`20260924T212317Z-0d61977f-recovery-customer-warnings-0d61977-dirty`
was deployed as release `20260924212419-static`; all seven static smoke checks
passed, including 3,451 current and previous content-addressed assets. The
new site setting was read back from the live hub as
`project_recovery_customer_warnings_enabled=false`, its default. Operator
notifications also remained disabled.

This establishes code, build, deployment, and disabled-state staging gates.
The earlier audited inventory found no genuinely paid staging membership, so
the enabled customer notice and email path have not yet been exercised live.
Do not claim paid notice delivery until a controlled paid-funded staging
project crosses an objective and the recipient confirms the notice. The user
did confirm receipt of the separate operator daily recovery-debt email; the
critical incident drill email remains unconfirmed. The seven-day canary,
fully qualified 30-day objective window, browser latency under sustained
load, and production review gates remain open. Production is unchanged.

The follow-up commit `0c3b13a864` changed the warning destination from a
relative project route to an absolute site URL. The notification email
renderer discards a Markdown link's destination from plaintext; keeping the
absolute URL visibly in the body preserves it in both HTML and plaintext.
The focused PGlite suite again passed 37/37, including a rendered plaintext
assertion, and the server package typecheck passed. Hub artifact
`20260924T212936Z-0c3b13a8-recovery-customer-links-0c3b13a-dirty` was
deployed as staging2 release `20260924213119-hub`; worker health and all
seven hub smoke checks passed. The customer warning switch remained false.

Commit `fa4c3bc60d` corrects multibay delivery: payer membership now
resolves on the account home bay, and customer warnings use the durable
account-notice outbox, addressed to each collaborator's home bay. The local
internal message sender required a local account row and could reject remote
collaborators. A deterministic notification event ID makes retries and
overlapping worker startups idempotent. Focused tests cover a remote
collaborator and a competing worker's committed event. This was deployed as
staging2 hub release `20260924214105-hub` and passed seven hub smoke checks.

Commits `f675d0a8c8`, `cd307a6d11`, and `e5d5dada6a` add count-only scan
logging, a durable last-completed scan record, and an operator health check
for a missing or stale enabled worker. The final staging2 hub release is
`20260924215537-hub`; worker health and all seven hub smoke checks passed.
The five focused PGlite suites passed 42/42 and the server package typecheck
passed. A read-only inventory query counted 23 eligible host-owned projects
(audit `5ce4b930-02fe-4111-a29d-2aba93f44b24`); the live projection query
also succeeded (audit `a42fbe97-fd5d-4fae-9d8f-391b78aedddc`). A
read-only funding audit found zero active positive-cost membership
subscriptions and zero funded grants (audit
`bff14472-2473-4463-a4b6-06737a0da648`).

The customer switch was briefly enabled for a worker canary. Before the
first scan, operator recovery health was critical and said the scan had not
completed. At `2026-09-24T21:53:06.448Z`, the worker recorded a completed
scan of all 23 projects and zero notices sent (audit
`01bf247e-6647-4fc0-92ef-4b26aa074580`). Operator recovery health then
became healthy and displayed that timestamp and counts. The switch was
returned to false and read back as false; final operator recovery health was
healthy and displayed "Customer warnings disabled." This confirms the
enabled scan path and its freshness monitor, while genuine paid-recipient
delivery remains untested. Production is unchanged.

Commit `fc1120a3b0` makes classification and recipient delivery errors visible
in the durable scan row and critical operator health while customer warnings
are enabled. The focused server suites passed 36/36 and the server TypeScript
build passed. Staging2 hub artifact
`20260924T220150Z-fc1120a3-recovery-warning-failures-fc1120a-dirty` was
deployed as release `20260924220321-hub`; schema migration, worker health,
host routing, and all seven hub smoke checks passed. An audited schema query
`ee160fe2-29cd-4bfc-9891-67193631e98e` confirmed the additive `failures`
column on the existing scan table. Focused tests inject a recipient home-bay
lookup failure and verify the persisted count and critical health condition.
The live canary did not inject a customer delivery failure.

An updated read-only funding audit found zero active positive-cost
subscriptions and zero current membership grants (`90362d9f-9004-40a2-9c52-fbca1ee5185f`). With customer warnings briefly enabled, the new worker
completed a scan at `2026-09-24T22:08:43.059Z`: 23 projects scanned, zero
notices, zero failures (audit `27d2acab-f73a-45db-902f-4abb2d2507c5`). The
switch was returned to false and read back as false. Recovery health displayed
"Customer warnings disabled" afterward. One immediate health sample was
`warning` during a transient free-project delay; a later sample was `healthy`
with zero current delay, unknown statuses, or unaccounted due obligations.
The customer-delivery qualification remains open until a genuinely paying
staging project crosses an objective and a recipient confirms the notice.

Commit `210285c4a8` persists the customer warning scanner's project cursor
and full-inventory evidence on the owning bay. A hub restart can now resume
after the first 5,000 projects; a full scan retains its project count and
failure count until a later complete scan supersedes it. Enabled operator
health reports missing or older-than-one-hour full coverage as critical, and
an older overlapping worker cannot overwrite a newer scan row. A focused
test covered 5,001 projects across a worker-module restart. Five focused
server suites passed 44/44 and the server package TypeScript build passed.

Staging2 hub artifact
`20260924T221655Z-210285c4-recovery-warning-cursor-210285c-dirty` was
deployed as release `20260924221826-hub`; worker health, host routing, and
all seven hub smoke checks passed. With customer warnings temporarily enabled,
health initially marked the pre-migration row critical because it lacked
full-inventory evidence. The schema audit
`fcc30736-7c62-4586-bbde-53e14adc908a` confirmed the cursor and full-scan
columns. A normal worker pass then completed at `2026-09-24T22:19:48.667Z`:
23 projects scanned, a null cursor, zero notices, and zero failures, with the
same timestamp and count recorded for the full inventory (audit
`972179f7-d5c2-4aed-b886-185e08b1548f`). The current funding audit again
found zero active positive-cost subscriptions and zero current grants
(`b75edd48-e20f-4ac0-b004-496aaf9525e4`). The customer switch was returned
to false and read back as false. The immediate final recovery-health sample
was `warning` for one free snapshot newly due by seconds; it listed zero
paying debt, unknown status, unaccounted obligations, host memory gates, and
missing storage telemetry. Production remains unchanged.

## 2026-09-24 storage payer attribution follow-up

Commit `ecf11ea99e` aligns recovery funding with the existing project usage
account policy. An explicit `usage_account_id` now funds recovery priority and
warnings even when it is not a collaborator; a student course's account is the
fallback payer when there is no explicit usage account. The host inventory
resolves owner entitlements and payer priority on each account's home bay.
An unavailable owner membership still defers the page rather than guessing a
smaller retention limit. Focused server tests passed 44/44, the existing
project usage integration suite passed 7/7, and the server TypeScript build
passed.

Staging2 hub artifact
`20260924T223602Z-ecf11ea9-recovery-usage-payer-ecf11ea-dirty` deployed as
release `20260924223735-hub`; worker health, host routing, and all seven hub
smoke checks passed. At 22:38:39 UTC project recovery health was healthy with
zero paying threshold breaches, unknown statuses, unaccounted due obligations,
host memory gates, or missing storage pressure telemetry. An audited inventory
query found no provisioned project with an explicit external usage payer and
one student course project with a separate course payer (audits
`e107ebd7-2c02-4646-9727-fa6e83caddf1` and
`78b985e0-5d8f-42ee-8ea3-6825973f8a86`). Its host schedule cache had
last verified at 22:37:38 UTC, during the rollout, and still showed the
previous owner payer at the 22:40:37 UTC read (`f221c136-325d-40a7-9a04-4c100a9d8f89`). A post-rollout normal reconciliation must verify that
this cache changes to the course payer before treating the live case as
qualified. At 22:42:54 UTC the host's normal reconciliation refreshed this
cache to the separate course account `298d8ab1-b132-4f64-8edf-b1edd6a47e1c`
with free service class (audited read `9ba407d0-0110-4a46-a462-22467cf807a5`).
That qualifies the live course-payer routing correction; it does not qualify
paid-class dispatch or customer warning delivery. Customer warnings remain
off; production is unchanged.

## 2026-09-24 current-payer health follow-up

Commit `7ad99e017f` makes overdue operator health and repeated-failure counts
resolve the current storage payer on its account home bay. A prior host attempt
can carry a stale funding class after a subscription, grant, or usage payer
change; the health query now refreshes classes for projects with debt or
repeated failures. Lookups are deduplicated by payer, limited to 16 concurrent
requests, and cached for five minutes across operator probes. Failed lookups
remain visible as unclassified instead of inheriting an old free class. The
project recovery status also classifies a paying breach when it crosses the
30-minute snapshot or 6-hour backup customer objective, before the 2-hour or
12-hour incident threshold.

Focused server tests passed 35/35 across status, database integration, and
notification suites; the server TypeScript build passed. Tests cover a host
report marked free whose current usage payer is paying, unresolved home-bay
membership, and per-project classification at the objective boundary.
Staging2 hub artifact
`20260924T225052Z-7ad99e01-recovery-health-payer-7ad99e0-dirty` deployed as
release `20260924225226-hub`. Migration and worker health passed, followed by
all seven hub smoke checks. At 22:52:59 UTC project recovery health was
healthy: zero paying critical debt, unclassified critical debt, unknown
statuses, and unaccounted due obligations. The staging inventory has no
genuinely paying project yet, so the live promoted-payer case is covered by
focused tests rather than an end-to-end paid notification drill. Customer
warnings remain off; production is unchanged.

## 2026-09-24 changed-generation deferral visibility

A live, audited 24-hour attempt query (`da124662-00eb-41c3-b286-3264bf2c9ae0`)
identified `change_generation_changed` as the cause of 63 snapshot and eight
backup deferrals that operator health had grouped under `other`. A second
audit (`63b7c8ae-42ac-43db-9b99-7d5c9ff38b60`) found that the
`snapshot_not_created` attempts were historical and concentrated on a small
set of projects. Current status reads for three repeatedly affected projects
(`3220da7f-7963-422b-80cb-464fe9b836b3`) showed subsequent successful
snapshots and zero consecutive failures.

Commit `461c734a79` gives changed-generation deferrals their own bounded
operator reason code. A database integration test verifies the grouping;
the two focused status suites passed 32/32 and the server TypeScript build
passed. Staging2 hub artifact
`20260924T225646Z-461c734a-recovery-change-generation-461c734-dirty`
deployed as release `20260924225816-hub`; worker health and all seven hub
smoke checks passed. At 22:58:51 UTC, live operator health was healthy and
listed 60 free snapshot and seven free backup
`change_generation_changed` deferrals by name rather than `other`.

## 2026-09-24 bounded replacement and post-rollout restore

Commit `df22c96dc6` tightens automatic rolling backup replacement. The
ordinary entitlement limit now applies until the project is exactly at its
limit. At that point, the existing per-project backup lock permits one
temporary replacement slot. A fresh repository inventory must still match
before the upload, and limit enforcement reads the repository again instead
of trusting its cache. A remote repository quota or capacity failure during
replacement is recorded as `replacement_capacity_blocked`; the old backup
remains. Operator health and the project's Recovery view show this reason.
The existing managed-upload policy check still runs before creation.

Focused file-server snapshot/Rustic suites passed 39 tests, the project-host
reason suite passed seven, the Recovery UI suite passed 17, and the server
integration suite passed 11. File-server, project-host, server, and frontend
TypeScript builds passed, as did frontend lint. Tests cover limits 0, 1, and
4; failed uploads; a changed repository inventory; a full repository; and a
prune retry without a second upload.

Staging2 hub artifact
`20260924T230834Z-df22c96d-recovery-replacement-df22c96-dirty` deployed as
release `20260924231009-hub`; all seven hub smoke checks passed. Static
artifact `20260924T231101Z-df22c96d-recovery-replacement-df22c96-dirty`
deployed as release `20260924231147-static`; all seven static checks passed.
Project-host artifact
`20260924T231217Z-df22c96d-recovery-replacement-df22c96-dirty` was
published. The generic fleet rollout skipped both pinned online hosts. An
initial explicit canary upgrade failed on a 404 artifact URL before
activation; the host retained its prior version. Retrying with the published
software store base URL succeeded (`cffd3413-41bd-494e-a457-9678c8f8b13c`).
The shared-host upgrade then succeeded (`a7d77131-6973-4599-9422-58751fc2ed9d`).
Both hosts reported the exact new project-host version and passed host smoke.

Disposable canary project `fd281d94-e6d2-464b-9130-7dacc65c5521` on the
upgraded canary host produced a scheduled off-host backup
`26a9a09678bfad2f02cb0107fc359d95baa483407b599e5b0df36368aa80a855`.
Because that backup preceded the test marker, a second backup was created
after the write; repository copy
`8ab134173a361978bcdce628bb98a8bcffd2ac37b047a336ff711930ca52411e`
listed `recovery-canary/marker.txt`. Restoring it to a separate path and
comparing bytes returned `retention-slot-canary-20260924T2318Z`. The
disposable project was deleted with seven-day backup retention and no
immediate purge; audited query `5d78a0b2-63d4-4fa9-9b59-335a7619fd91`
found zero remaining project rows. At 23:19:06 UTC recovery health was
healthy with zero paying or unclassified critical debt, unknown statuses,
unaccounted due obligations, memory gates, or missing storage telemetry.
The live test establishes the below-limit backup path and byte recovery;
at-limit replacement and capacity-denial preservation have focused tests but
still lack a live staged repository-capacity drill.

## 2026-09-24 active-shard restore-drill health

Commit `126b7dd340` adds remote-only restore-drill coverage to the regular
project-recovery operator check. The owning bay counts repository shards with
active projects and confirmed off-host backups, then reads each shard's latest
durable hash attestation. A failed latest drill is critical; missing evidence
or a passing drill older than 30 days is a warning. Health includes bounded
per-shard problem details. The query is scoped to the owning bay, and the
attestation table has a repository/time index.

The focused PGlite suite passed 5/5, including current, failed, missing, and
stale shard cases; the server TypeScript build passed. Staging2 hub artifact
`20260924T232606Z-126b7dd3-20260924T2327Z-126b7dd3-restore-drill-health-dirty`
deployed as release `20260924232738-hub`. Migration and worker health passed,
and all seven hub smoke checks passed. At 23:28:14 UTC, live project-recovery
health was healthy: **4/4 active backup shards** had passing remote-only
restore drills within 30 days, with zero failed, missing, or stale latest
drills. No paying or unclassified critical debt, unknown status, unaccounted
due work, memory gate, or missing recent storage-pressure telemetry was
reported. Overall site health was warning because of separate existing
checks, including recent admin alerts and insufficient browser-latency
samples. Production is unchanged.

## 2026-09-24 retention-limit staging canary

Disposable staging project `1206f6cb-0624-4d42-8062-cdc693638932` was
created on the upgraded canary host under the staging administrator. Its
effective entitlement allows 15 backups. The normal worker made the first
backup, and 14 manual backups filled the repository to exactly 15. A further
manual create failed with `there is a limit of 15 backups`, leaving the
inventory at 15. This verifies the live ordinary upload limit.

To exercise the scheduled worker without waiting a day, an audited,
project-ID/host/repository-scoped database write temporarily aged only this
disposable project's bay `last_backup` value by 25 hours. The dry run returned
exactly one row (`c23a4980-26fc-48f2-b360-593d886210be`); the committed
write is audit `1060206f-3d56-46e3-b1f6-38a7891a88b7`. After a marker edit,
the worker reconciled against the fresher repository copy from 23:34:52 UTC
and restored the true `last_backup` time. It reported a deferred
`backup_not_created` attempt instead of deleting a copy or claiming an
unmade backup. All 15 backup IDs remained listed. A retained older backup
(`4f7c54c1eda155d5cf99d4cb63aa9b566608bb69a56e705e65086d875cd623e3`)
restored `recovery-canary/marker.txt` to another path, and its bytes matched
`retention-limit-marker-20260924T2331Z`. At 23:37:09 UTC project-recovery
health was healthy, including 4/4 restore-drill shard coverage.

The canary remains in staging with 15 backups and later file edits. Its
ordinary daily due time is approximately 2026-09-25 23:34 UTC. Observe the
natural scheduled replacement then, verify the newest marker and older-copy
preservation, and delete the canary under normal seven-day backup retention
afterward. The induced stale-bay reconciliation is useful safety evidence but
is not evidence that an at-limit replacement completed. A controlled
repository-capacity-denial drill remains open. Production is unchanged.

The retention-limit canary was stopped after its byte-restore check to free
its shared-host runtime slot. Its project and 15 repository backups remain
available for the natural daily maintenance observation.

## 2026-09-24 paying-queue stall in regular recovery health

Commit `147a2be321` makes regular project-recovery operator health use the
same paying-queue stall rule as the incident notification worker. A paying
host snapshot lane with overdue work for at least 30 minutes and no confirmed
snapshot completion in that window is critical; the corresponding backup
window is two hours. An unreadable completion history is also critical rather
than silently implying progress. Health shows bounded host/lane details.

The focused notification-plan suite passed 5/5, including the shared stall
rule; the server TypeScript build passed. Staging2 hub artifact
`20260924T234330Z-147a2be3-20260924T2343Z-147a2be3-paying-queue-health-dirty`
deployed as release `20260924234502-hub`. Migration and worker health passed,
and all seven hub smoke checks passed. At 23:45:35 UTC, project-recovery
health was healthy with zero paying queues lacking a recent completion and
4/4 active backup shards covered by recent passing restore drills. Staging2
currently has no genuine paid-funded queue, so the critical live branch is
covered by the shared focused test and still needs a paid staging case.
Production is unchanged.

## 2026-09-24 owning-bay recovery-health scope

Commit `cb9d223ddb` scopes the project-recovery inventory to projects owned
by the current bay. It treats a missing or blank stored owner bay as local
for legacy one-bay rows, matching the existing ownership compatibility rule.
The same filter now controls active restore-drill shard coverage. This avoids
counting foreign project shadows as local debt and avoids dropping legacy
local backup shards from drill coverage.

Before deployment, audited read `76fce94f-493c-4335-ac28-a4af1be6dc18`
found 24 active, provisioned projects on staging2, all explicitly owned by
`bay-0` and all with a confirmed last backup. Two focused PGlite suites
passed 17/17, including foreign-row exclusion and legacy-null inclusion for
both inventory and drill coverage; the server TypeScript build passed.
Staging2 hub artifact
`20260924T235235Z-cb9d223d-20260924T2352Z-cb9d223d-bay-recovery-scope-dirty`
deployed as release `20260924235405-hub`. Migration, worker health, and all
seven hub smoke checks passed. At 23:54:48 UTC, recovery health briefly
reported a free-work warning with zero critical debt or unknown status. By
23:55:04 UTC it was healthy: zero oldest snapshot and backup delay, zero
paying or unclassified critical debt, zero unknown/unaccounted status, zero
stalled paying queues, and 4/4 active backup shards with recent passing
remote-only drills. Fresh operator auth expired before a post-deployment
audited project-count query, so no post-deploy row count is claimed. The
PGlite tests verify the ownership boundary; staging2 has no foreign-owned
project sample. Production is unchanged.

## 2026-09-25 host maintenance schedule ownership

Commit `d9ae08b5a4` applies the same owning-bay boundary to the paged host
maintenance schedule. The bay verifies that the requesting host belongs to the
local bay, then serves only projects assigned to that host and owned locally.
Legacy host and project rows without an explicit bay remain local under the
one-bay compatibility rule. The new PGlite integration case includes a local
project, a legacy project, a foreign shadow on the local host, and a foreign
host. Both focused suites passed 10/10 tests, and the server TypeScript build
passed.

Staging2 hub artifact
`20260924T235945Z-d9ae08b5-20260925T0010Z-d9ae08b5-host-schedule-bay-dirty`
deployed as release `20260925000118-hub`. Migration, worker health, and all
seven hub smoke checks passed. At 00:02:52 UTC, live project-recovery health
had zero paying critical debt, unknown status, unaccounted due work, or
stalled paying queues; 4/4 active backup shards had passing remote-only
restore drills. Two free snapshot obligations were temporarily overdue,
oldest five minutes, so the recovery check was warning at that sample. By
00:03:30 UTC, the recovery check was healthy again with zero oldest snapshot
or backup delay. Overall site health remained warning for separate checks.
Staging2 has no foreign-owned project sample for an end-to-end ownership
negative case. Production is unchanged.

## 2026-09-25 rehome fence for maintenance confirmation and reports

Commit `6d51a5b1de` closes the remaining owning-bay checks in the host
maintenance handshake. An old host can no longer confirm an assignment after
the project rehomes to a different bay. The status writer also checks the
project's current owner bay as part of its database insert, so a delayed
report cannot replace the last local status or append an attempt after a
rehome. Legacy rows with no owner bay still use the local one-bay rule.

Focused PGlite suites passed 14/14, the host-status unit suite passed 9/9,
and the server TypeScript build passed. Staging2 hub artifact
`20260925T000924Z-6d51a5b1-20260925T0009Z-6d51a5b1-maintenance-bay-fence-dirty`
deployed as release `20260925001200-hub`. Migration and worker health passed,
and all seven hub smoke checks passed. At 00:12:35 UTC, live project-recovery
health was healthy: zero oldest snapshot and backup delay, zero paying critical
debt, unknown statuses, or unaccounted due work, and 4/4 active backup shards
with passing recent remote-only restore drills. Overall site health remained
warning for separate checks. Production is unchanged.

## 2026-09-25 recovery-status read after rehome

Commit `1bcf12ff3e` requires the current bay to own a project before reading
its local recovery status. This closes a race in which a customer-warning scan
could recheck a project after it rehomed and read a foreign shadow row from the
old bay. The regular routed project view also gets a safe failure if ownership
changes between directory resolution and the local read. Legacy rows with no
explicit owner bay remain local.

The focused recovery-status, customer-warning, and PGlite suites passed
45/45 tests, including foreign and rehomed row rejection; the server
TypeScript build passed. Staging2 hub artifact
`20260925T001635Z-1bcf12ff-20260925T0016Z-1bcf12ff-recovery-status-bay-dirty`
deployed as release `20260925001806-hub`. Migration, worker health, and all
seven hub smoke checks passed. At 00:18:47 UTC, live project-recovery health
was healthy with zero oldest snapshot and backup delay, zero paying critical
debt, unknown status, or unaccounted due work, and 4/4 active backup shards
covered by recent passing remote-only restore drills. Overall site health
remained warning for separate checks. Production is unchanged.

## 2026-09-25 unclassified storage funding in maintenance reports

Commit `7e572331ef` preserves `unclassified` when a project has no resolvable
storage payer. The host schedule previously labeled such work `free`, which
misattributed its durable attempt history even though operator health
reclassified overdue unknown funding. The schedule and report types now carry
the explicit class. Dispatch still gives it bounded non-paying progress.

The focused host schedule suites passed 10/10, the priority suite passed
3/3, and Conat, server, and project-host TypeScript builds passed. Staging2
hub artifact
`20260925T002258Z-7e572331-20260925T0022Z-7e572331-unclassified-funding-dirty`
deployed as release `20260925002432-hub`. Migration, worker health, and all
seven hub smoke checks passed. At 00:25:19 UTC, the live recovery check was
warning because one free snapshot was due by less than a minute; it showed
zero oldest rounded snapshot or backup delay, zero paying critical or
unclassified debt, zero unknown/unaccounted status, and 4/4 active backup
shards with recent passing remote-only drills. By 00:25:59 UTC, the recovery
check was healthy with zero current snapshot and backup delay. Overall site
health remained warning for separate checks. No deliberate unclassified
staging canary was created for this change; the PGlite test covers that
branch. Production is unchanged.

## 2026-09-25 signed-in Chromium Recovery view

The user-provided Chromium debugging session on port 9222 was available with
two signed-in staging2 tabs. A read-only inspection of project
`1793a413-42c9-49cf-8a2e-0abd641e8b28` at a 1269 CSS-pixel viewport
showed the current Recovery settings section with the latest confirmed local
snapshot and off-host backup and their next due times. The browser timezone
was America/Los_Angeles. At 5:29 PM local time, the displayed 5:41 PM
snapshot and 9:50 PM backup due times were still in the future; the green
status was appropriate. The initial impression that the backup due date was
past came from comparing it with the UTC date, not the browser's local time.

The Recovery section and document had no horizontal overflow at this width.
Both status regions used polite live announcements, and the Create Snapshot,
Restore Snapshot, and Create Backup buttons were visible and enabled. The
[focused staging2 screenshot](screenshots/staging2-recovery-live-2026-09-25.png)
preserves the rendered result. This confirms one current live UI state; it
does not qualify under-load terminal or Jupyter latency, a live blocked reason,
or a paid-project warning. Production is unchanged.

## 2026-09-25 staging membership and browser readiness follow-up

The staging administrator `cc82e1f9-b452-42ae-9904-4c29ac1f24a4` has
membership class `admin` from source `admin`, not a purchased subscription.
The live membership-tier catalog lists only that hidden, non-purchasable
admin tier, and a read-only quote for a one-seat monthly `member` team
package failed because that tier is unavailable. No purchase or account
mutation was made. This environment cannot presently provide a genuine
paid-funded project for the dispatch-priority or customer-warning delivery
drill. A test account with a purchased membership or a deliberately configured
staging purchase tier is required for that gate.

In the signed-in Chromium session, opening a project terminal recorded a
369 ms browser-observed terminal-ready sample, with a 1 ms project-exec
readiness sample. Opening a new notebook recorded 399 ms file-content paint
and 586 ms sync readiness, but its Python 3 kernel was unavailable in this
project's base image. The browser recorded no Jupyter-ready sample. These
were low-load probes and do not qualify the under-load latency gate. The
terminal and notebook tabs were closed, and their newly created scratch
files were removed after the probe.

At 00:39:59 UTC, staging2 project-recovery health was healthy: zero current
snapshot or backup debt, unknown statuses, unaccounted due work, or active
memory gates, with 4/4 active backup shards covered by recent passing
remote-only restore drills. The 30-day objective collector began on
September 24 and has not yet accrued a mature window. Overall site health
remained warning for separate checks. The 15-backup canary still awaits its
natural scheduled replacement around September 25 23:34 UTC; a live
repository-capacity-denial drill also remains open. Production is unchanged.
