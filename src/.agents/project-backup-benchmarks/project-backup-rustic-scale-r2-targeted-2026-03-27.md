## Project Backup Rustic R2 Scaling After Direct-ID Lookup

Date: 2026-03-27

Host:
- `bench`
- host id: `0ec9acaf-432a-4c3c-a76e-8cec615f0fe5`
- machine: `gcp t2d-standard-16`
- workdir filesystem: `/mnt/cocalc` (`btrfs`)

Artifacts:
- [project-backup-rustic-scale-r2-targeted-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/project-backup-benchmarks/project-backup-rustic-scale-r2-targeted-2026-03-27.json)
- [project-backup-rustic-scale.ts](/home/wstein/build/cocalc-lite2/src/packages/server/cloud/smoke-runner/project-backup-rustic-scale.ts)

Important setup:
- real R2 backend, not local disk
- `cache_mode = shared`
- `cold_measurements = true`
- tiny synthetic fixture to emphasize metadata/index behavior rather than bulk upload
- measurements are incremental within each layout, so `128 -> 512 -> 1024` avoids rebuilding earlier snapshots from scratch

Important implementation detail:
- project backups already store the exact rustic snapshot id, and the CoCalc wrapper now validates with direct lookup:
  - `rustic snapshots --json <snapshot_id>`
- this benchmark is therefore measuring the architecture after fixing the earlier `snapshots --json` full-scan lookup path

One nuance:
- `total_snapshots` is the snapshot count inside the measured repo or shard, not global projects in the whole benchmark
- shared layout therefore grows to `128`, `513`, `1026`
- sharded-64 stays at `2`, `13`, `19` in the target shard even when the global project count reaches `1024`

## Results

| layout | projects | snapshots in measured repo | filter-host | wrapper full-scan | direct id | repoinfo | backup after change |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| shared | 128 | 128 | 2274.2 ms | 1589.2 ms | 724.7 ms | 3209.9 ms | 3531.9 ms |
| shared | 512 | 513 | 5443.6 ms | 3775.2 ms | 693.1 ms | 7698.4 ms | 7063.0 ms |
| shared | 1024 | 1026 | 8638.3 ms | 6232.0 ms | 709.4 ms | 11068.4 ms | 11816.4 ms |
| sharded-64 | 128 | 2 | 1899.1 ms | 1755.0 ms | 1552.4 ms | 3114.2 ms | 6776.4 ms |
| sharded-64 | 512 | 13 | 1029.5 ms | 887.3 ms | 783.1 ms | 1564.4 ms | 2008.1 ms |
| sharded-64 | 1024 | 19 | 1316.3 ms | 991.4 ms | 830.4 ms | 1356.5 ms | 2048.8 ms |

Derived wrapper overhead versus direct-id:
- shared `128`: `864.5 ms`
- shared `512`: `3082.1 ms`
- shared `1024`: `5522.6 ms`
- sharded-64 `512`: `104.2 ms`
- sharded-64 `1024`: `161.0 ms`

## Interpretation

What stayed flat enough:
- exact-id lookup on real R2 stayed in the rough `0.69s` to `0.83s` band once the target shard had a nontrivial amount of data
- this is a much better answer than the old wrapper-scan path and makes stored exact snapshot ids clearly worthwhile

What still scales with unrelated snapshots in a shared repo:
- `snapshots --filter-host`
- `repoinfo`
- the old full-scan wrapper path, even though it is no longer needed for exact-id validation
- the shared `backup_after_change` probe, which has to touch the larger shared repo state

What sharding changes:
- it bounds the shard-local snapshot count very effectively
- at `1024` total projects with `64` shards, the measured shard only had `19` snapshots
- that kept `filter-host`, `wrapper full-scan`, `repoinfo`, and `backup after change` much closer to the low-count baseline

## Practical Takeaway

The direct-id fix substantially improves the case for shared repos:
- exact snapshot validation no longer requires a whole-repo scan
- exact-id lookup itself did not show scary `O(N)` growth in this sweep

But the larger cold-R2 sweep also shows that a single giant shared repo is not automatically free:
- host-filtered listing and repo-wide metadata commands still drift upward with unrelated snapshots
- if interactive browsing, repoinfo-heavy paths, or future retention operations matter a lot, sharding still buys real bounded behavior

So the current architectural answer is:
- per-project repos still look unnecessarily conservative
- one shared repo per region is now plausible for exact snapshot fetch/restore paths
- sharding remains a serious candidate if we want stronger bounds on listing, metadata, and long-term maintenance operations
