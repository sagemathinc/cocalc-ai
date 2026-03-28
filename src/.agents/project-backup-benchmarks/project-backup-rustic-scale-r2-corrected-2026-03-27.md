## Project Backup Rustic R2 Scaling

Date: 2026-03-27

Host:
- `bench`
- host id: `0ec9acaf-432a-4c3c-a76e-8cec615f0fe5`
- machine: `gcp t2d-standard-16`
- workdir filesystem: `/mnt/cocalc` (`btrfs`)

Artifacts:
- [project-backup-rustic-scale-r2-corrected-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/project-backup-benchmarks/project-backup-rustic-scale-r2-corrected-2026-03-27.json)

Important setup:
- real R2 backend, not local disk
- `cache_mode = per-project`
- `cold_measurements = true`
- tiny synthetic fixture: only `notes.txt` in each project
- the goal here is remote metadata/index behavior, not bulk upload throughput

Important correction:
- the first R2 harness attempt was invalid because different scenario sizes reused one remote repo namespace
- [project-backup-rustic-scale.ts](/home/wstein/build/cocalc-lite2/src/packages/server/cloud/smoke-runner/project-backup-rustic-scale.ts) was fixed so each scenario gets its own remote repo root
- the measurements below were taken directly against completed corrected scenario repos

One nuance:
- each scenario shows `filter_host_snapshot_count = 2`
- that is expected because the benchmark's `backup_after_change` phase creates a second snapshot for the target host

## Results

| scenario | layout | total snapshots in repo | filter-host | wrapper full-scan | direct id | repoinfo | full-scan json size |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `shared-count-16` | shared | 17 | 1110.7 ms | 999.3 ms | 771.7 ms | 1499.5 ms | 35.6 KiB |
| `shared-count-32` | shared | 33 | 1125.0 ms | 1273.3 ms | 693.0 ms | 1857.7 ms | 69.0 KiB |
| `sharded-count-16` | sharded-16 | 4 in target shard | 1127.0 ms | 903.0 ms | 860.1 ms | 1356.7 ms | 8.4 KiB |

Derived wrapper overhead versus direct-id:
- `shared-count-16`: about `228 ms`
- `shared-count-32`: about `580 ms`
- `sharded-count-16`: about `43 ms`

## Interpretation

What these numbers say:
- with cold cache on real R2, the baseline cost of even exact-id lookup is already roughly `0.7s` to `0.9s`
- `filter-host` and `repoinfo` are closer to `1.1s` to `1.9s`
- the wrapper full-scan path gets noticeably worse as unrelated snapshots accumulate in one shared repo
- sharding keeps the full-scan payload much smaller and almost eliminates the extra wrapper penalty

What these numbers do **not** say:
- they do not prove that one shared repo per region is bad
- they do prove that our current wrapper behavior (`snapshots --json` then client-side scan) is the first thing that must be fixed if we ever move toward shared repos

Practical takeaway:
- store exact snapshot ids in the DB and use direct-id lookup
- after that, rerun a larger corrected R2 sweep
- if direct-id shared-repo behavior stays near-flat, shared regional repos remain plausible
- if global operations still drift upward too fast, sharding is the obvious fallback
