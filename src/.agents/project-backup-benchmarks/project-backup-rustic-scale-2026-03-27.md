## Project Backup Rustic Shared-Repo Scaling

Date: 2026-03-27

Host:
- `bench`
- host id: `0ec9acaf-432a-4c3c-a76e-8cec615f0fe5`
- machine: `gcp t2d-standard-16`
- filesystem for benchmark workdir: `/mnt/cocalc` (`btrfs`)

Harness:
- [project-backup-rustic-scale.ts](/home/wstein/build/cocalc-lite2/src/packages/server/cloud/smoke-runner/project-backup-rustic-scale.ts)

Artifacts:
- [project-backup-rustic-scale-shared-sharded-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/project-backup-benchmarks/project-backup-rustic-scale-shared-sharded-2026-03-27.json)
- [project-backup-rustic-scale-shared-2048-2026-03-27.json](/home/wstein/build/cocalc-lite2/src/.agents/project-backup-benchmarks/project-backup-rustic-scale-shared-2048-2026-03-27.json)

What this benchmark measures:
- synthetic project backups using the real `rustic 0.11.1` binary on the host
- `shared` repo layout versus `sharded-16`
- one snapshot per synthetic project
- hot-path operations for one target project after many unrelated snapshots exist:
  - `rustic snapshots --json --filter-host <target>`
  - current CoCalc wrapper behavior: `rustic snapshots --json`, then parse all and find the target snapshot id
  - direct exact-id lookup: `rustic snapshots --json <snapshot_id>`
  - `rustic repoinfo --json`
  - one more `backup` after a tiny change to the target project

Important limitation:
- this is not yet an R2 benchmark
- it isolates repo/index scaling on-host, which is the right first step for the `O(N)` question

## Results

### Shared repo

| projects | snapshots | filter-host | wrapper full-scan | direct id | repoinfo | backup after change | full-scan json size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 256 | 256 | 345.5 ms | 367.2 ms | 335.7 ms | 350.9 ms | 362.8 ms | 502 KiB |
| 1024 | 1024 | 358.5 ms | 428.9 ms | 341.9 ms | 374.1 ms | 390.5 ms | 2012 KiB |
| 2048 | 2048 | 378.4 ms | 506.4 ms | 340.1 ms | 405.0 ms | 420.9 ms | 4118 KiB |

Derived `wrapper - direct` overhead:
- 256 snapshots: `31.4 ms`
- 1024 snapshots: `86.9 ms`
- 2048 snapshots: `166.3 ms`

### Sharded 16-way

| projects | total snapshots | snapshots in target shard | filter-host | wrapper full-scan | direct id | repoinfo | backup after change | full-scan json size |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 256 | 256 | 18 | 339.3 ms | 336.1 ms | 340.1 ms | 340.7 ms | 354.8 ms | 35 KiB |
| 1024 | 1024 | 67 | 336.4 ms | 342.4 ms | 335.8 ms | 343.3 ms | 359.0 ms | 132 KiB |

## Interpretation

What looks good:
- raw shared-repo `rustic` operations are much flatter than feared
- even at `2048` snapshots in one repo, `filter-host`, `direct id`, and `repoinfo` stayed in the rough `340-405 ms` band
- there is no sign here of a catastrophic `O(N)` blow-up like the ZFS-filesystem-import problem

What does scale:
- our current CoCalc wrapper validation path, which does `snapshots --json` and then scans all snapshots client-side
- that overhead grows with total snapshots in the repo
- at `2048` snapshots, the extra cost versus direct id lookup was already about `166 ms`

What sharding buys:
- not a dramatic speedup for `filter-host`
- but it keeps the wrapper full-scan path near-flat because each shard only sees a bounded subset of snapshots
- it also keeps the full JSON payload much smaller

## Practical Takeaway

Based on this benchmark alone:
- `one repo per project` looks overly conservative
- `one repo per region` looks viable from rustic's side, at least at this scale
- the main scaling problem we found is in our wrapper, not in rustic

So the highest-value next change is:
- stop validating exact snapshot ids by scanning `rustic snapshots --json`
- use a direct exact-id path and/or store the exact snapshot id in the database and trust it

Then:
- rerun the same benchmark against actual R2-backed repos
- if R2-backed shared repos also stay flat enough, one regional repo becomes a serious option
- if not, sharding is the obvious fallback
