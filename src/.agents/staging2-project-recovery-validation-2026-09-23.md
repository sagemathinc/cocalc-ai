# Staging2 project recovery validation

Date: 2026-09-23 UTC

Status: staging implementation and restore drills completed; production gates remain open.

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

The `-dirty` artifact suffix came from unrelated, pre-existing untracked files;
the source commits above identify the tracked code used for the builds.

## Validation

| Check                                                                     | Result                                                                                                                                                            |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused package tests, typechecks, `build:dev`, frontend lint, formatting | Passed before deployment; the cursor fix passed its focused test and server typecheck.                                                                            |
| Project-host, hub, and static staging2 smoke checks                       | Passed.                                                                                                                                                           |
| First production-timed scheduler sweep                                    | Found an empty-string UUID cursor error. Fixed in `426994cc`, deployed to staging2, and verified on the next normal sweep.                                        |
| Scheduled backup on a newly provisioned project                           | Rustic backup `e034db1fa34b9994f20eecf606de470f003965bf70b8d4a2078f352bf21de4b9` created at 20:43:24 UTC; `projects.last_backup` advanced to 20:43:24.645 UTC.    |
| Scheduled backup restore                                                  | Restored `recovery-canary/marker.txt` to a second file and read back `new scheduled worker 2026-09-23`.                                                           |
| Bay backup file index                                                     | The Rustic catalog and file restore worked, but admin `backup-health` still reports `latest_index_backup_at: null` for this backup.                               |
| Independent snapshot lane                                                 | Local snapshot `2026-09-23T20:45:17.464Z` created after the backup completed, with the host still responsive to project commands.                                 |
| Manual backup and restore                                                 | Passed on a separate disposable project after the new project-host deployment.                                                                                    |
| Full Btrfs snapshot restore                                               | `mode=both` restored a marker to its pre-mutation value and restarted the project successfully.                                                                   |
| Home-only Btrfs snapshot restore                                          | `mode=home` restored `historical-home-marker` while preserving a `preserve-current-rootfs` sentinel added after the snapshot. The project restarted successfully. |
| Recovery health visibility                                                | After the first successful sweep, unknown snapshot and backup status counts both fell from 12 to 0.                                                               |

The scheduled-path project is
`1b461cb0-47c3-4d58-bdc0-3bdd4af2e139`. The separate restore-test project is
`c33fbadb-38b4-487d-b8be-6ac2dff58143`. A pre-rollout canary project is
`4cf27fc8-0d44-4138-a39c-87643694074f`. These disposable projects remain
on staging2 for inspection.

The automated pagination test walks 1,003 projects across five pages. Live
staging2 validation used its existing small host inventory plus the disposable
projects; it did not create hundreds of live projects.

## Open findings and release gates

1. Browser UI testing is pending the staging2 CLI fresh-auth approval. Frontend
   automated checks and static smoke passed, but the actual project status UI
   has not yet been exercised in a browser.
2. The bay backup file index was not produced by the scheduled path. The
   recoverable Rustic snapshot and `last_backup` report were confirmed, but
   any release criterion requiring a bay file index for each backup remains
   open until its indexing policy and writer are confirmed and tested.
3. The plan's full observability and scheduler contract remains broader than
   the current code: stage-specific timing and bytes, event-triggered due work,
   ownership/schedule revision tracking, pressure debt and capacity reports,
   operator drill reporting, and gated automatic rollout are not yet present.
   The current scheduler still reconciles on a 15-minute timer.
4. The requested seven-day canary, 30-day due-to-success objectives, paid/free
   production distributions, interactive latency comparison, and restore
   drills across repository shards require observation after code review and
   coordinated rollout. None is established by this single-day staging test.
5. Staging2's overall health has a separate pre-existing bay-backup restore
   warning. Project snapshot/backup health must be judged separately.

Do not promote this change to production until the open code and UI findings
are reviewed and the operational gates are planned with the maintainer.
