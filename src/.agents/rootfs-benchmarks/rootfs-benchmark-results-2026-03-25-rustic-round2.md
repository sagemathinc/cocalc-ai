# RootFS Benchmark Results: 2026-03-25 (Rustic Round 2)

Environment:

- Source host: `rootfs-test-2` (`136.118.80.203`)
- Destination host: `rootfs-test-1` (`34.11.143.199`)
- Region: `us-west1`
- Bucket: `lite2-dev-wnam`
- Rustic backend: `opendal:s3` to Cloudflare R2
- Run id: `1774501163-76d2bfe0`

Method:

- This was a second-round due-diligence benchmark for a possible RootFS
  transport/storage format based on `rustic`, not a product-path
  implementation.
- The package-heavy and blob source trees were the same cached benchmark
  lowerdirs used in the earlier RootFS multipart benchmark round.
- Three benchmark slices were run:
  - repeated backups into the same rustic repo to measure small-update behavior
  - cross-host restore from R2 to a different host
  - a synthetic fidelity tree to check hardlinks, symlinks, FIFOs, modes, and
    sparse files

## Summary

| Scenario | Rustic save / backup | Rustic restore | Added / packed bytes | Notes |
| --- | ---: | ---: | ---: | --- |
| `package-heavy-jupyter` baseline | `45.62s` | `13.57s` | `473.19 MB packed` | same `1.36 GB` package-heavy tree as before |
| tiny update on same tree | `4.53s` | n/a | `4.2 KB packed` | one small new file under `/usr/local/share` |
| metadata-heavy repo add | `19.58s` | `20.15s` | `176.62 MB packed` | copied `310.98 MB` of many-file repos into `/opt/repos` |
| `blob-4g-random` baseline | `169.25s` | `22.75s` | `4.384 GB packed` | same `4.54 GB` incompressible blob tree as before |
| fidelity tree | `1.59s` | `1.33s` | `6.9 KB packed` | exposed hardlink/sparse-file fidelity problems |

## Detailed Results

### 1. Package-Heavy Baseline

- Source path: cached `package-heavy-jupyter` lowerdir
- Tree bytes processed: `1,361,349,501`
- Rustic backup wall time: `45.62s`
- Rustic reported backup duration: `44.27s`
- Packed bytes added: `473,193,673`
- Repo total bytes after baseline: `477,175,133`
- Cross-host restore to `rootfs-test-1`: `13.57s`

Reference to current btrfs-stream path:

- btrfs `send+hash+upload`: `33.50s`
- btrfs cold create/start `cache_rootfs`: `35.96s`

Interpretation:

- Rustic backup is slower than the current btrfs publish path on this realistic
  package-heavy tree.
- Rustic restore is much faster than the current btrfs cold-cache import path.

### 2. Small-Update Series On The Same Repo

#### Tiny update

Change:

- added one small text file under
  `/usr/local/share/rustic-bench/tiny-update.txt`

Results:

- backup wall time: `4.53s`
- packed bytes added: `4,195`
- repo total bytes grew from `477,175,133` to `477,181,361`

Interpretation:

- Rustic is extremely attractive for very small follow-up updates.

#### Metadata-heavy repo add

Change:

- copied the cached `metadata-heavy-repos` tree into
  `/opt/repos/repos-from-metadata`
- logical added bytes: `310,982,413`

Results:

- backup wall time: `19.58s`
- packed bytes added: `176,622,175`
- repo total bytes grew to `655,635,832`
- cross-host restore of the latest snapshot: `20.15s`

Interpretation:

- For a many-file, moderately large update, rustic remained quite competitive.
- This is suggestive of the “users make lots of small/medium updates” story,
  though it is not yet an apples-to-apples comparison with the current btrfs
  incremental release benchmark.

### 3. Blob Worst-Case Baseline

- Source path: cached `blob-4g-random` lowerdir
- Tree bytes processed: `4,547,030,058`
- Rustic backup wall time: `169.25s`
- Rustic reported backup duration: `168.17s`
- Packed bytes added: `4,384,116,577`
- Repo total bytes after baseline: `4,385,131,488`
- Cross-host restore to `rootfs-test-1`: `22.75s`

Reference to current btrfs-stream path:

- btrfs `send+hash+upload`: `65.84s`
- best btrfs multipart-download `cache_rootfs`: `44.63s`

Interpretation:

- Rustic still loses badly on worst-case publish.
- Rustic restore remains materially faster than the current btrfs receive path,
  even on the giant incompressible tree.

## Fidelity Check

Synthetic fidelity tree contents:

- regular file
- hardlink pair
- executable file
- symlink
- FIFO
- sparse file

What survived correctly after restore:

- file modes
- symlink target
- FIFO type

What did **not** survive correctly:

- hardlinks were broken
  - source `regular.txt` / `hardlink.txt`: `nlink = 2`
  - restored: both came back with `nlink = 1`
- sparse holes were lost
  - source `sparse.bin`: logical size `10,485,760`, allocated bytes `4,096`
  - restored `sparse.bin`: logical size `10,485,760`, allocated bytes
    `10,485,760`

Interpretation:

- This is the strongest argument **against** switching RootFS transport to
  rustic right now.
- Hardlink fidelity is important for real software trees.
- Loss of sparsity is also undesirable.
- Even though project backup/copy workflows already use rustic successfully,
  RootFS has stricter filesystem-fidelity requirements.

## Main Takeaways

- Rustic restore performance is consistently impressive and is the main reason
  to keep considering it.
- Rustic is especially compelling for repeated tiny updates in the same repo.
- Rustic backup is still materially worse than btrfs-stream on the worst-case
  giant-blob publish.
- The fidelity check exposed two concrete blockers for RootFS use:
  - hardlinks were not preserved
  - sparse files were fully materialized

## Conclusion

This second round makes the tradeoff sharper:

- If we only cared about restore speed and storage efficiency, rustic would look
  very strong.
- For RootFS specifically, the current btrfs-stream approach still has the
  safer correctness story.
- Before any serious switch to rustic, we would need either:
  - proof that rustic can be configured to preserve hardlinks and sparse files
    correctly for this use case, or
  - a compensating design that makes those fidelity losses acceptable
    (which seems unlikely for managed RootFS releases).
