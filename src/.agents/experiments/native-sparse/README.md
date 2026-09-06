# Native Sparse Qualification

Run `node probe.cjs /absolute/path/to/rustic /absolute/path/to/report.json` on
Linux/Btrfs. The script compiles two small C helpers, creates its own disposable
repository with isolated credentials/configuration, imposes a three-minute
deadline per command, and removes only its generated temporary tree afterward.
It requires a development binary exposing `--sparse by-content-required`.

## Initial Results, 2026-09-05

Rustic CLI 0.11.4 with the CoCalc core sparse patches, debug CLI/core build,
Rust 1.94.0. These are functional and resource measurements, not release-build
throughput predictions. Full output: local
`/tmp/cocalc-native-sparse-report-2026-09-05.json`.

Fixtures: 1 TiB entirely holes, 100 GiB with 1 MiB of data, 16 MiB with 1 MiB
of interleaved data, and 1 MiB ordinary data.

| Operation                                | Elapsed |  Peak RSS | Observed process reads |
| ---------------------------------------- | ------: | --------: | ---------------------: |
| Initial backup                           | 11.28 s | 445.1 MiB |              18.52 MiB |
| Unchanged backup                         |  6.23 s | 318.1 MiB |               30.8 KiB |
| Ordinary-file edit                       |  4.51 s | 476.2 MiB |               1.03 MiB |
| Sparse-file edit, mtime reset            |  4.94 s | 477.2 MiB |               2.03 MiB |
| Fresh sparse restore                     | 20.72 s | 307.7 MiB |               3.05 MiB |
| Existing sparse restore, verify-existing | 15.24 s | 307.7 MiB |              40.04 MiB |
| Repository check with data verification  |  4.40 s | 685.4 MiB |               4.57 MiB |

Process reads are sampled `/proc/PID/io` rchar lower bounds, include repository
and configuration reads, and are not physical-device I/O measurements. Peak RSS
comes from `wait4`, not sampling. Password derivation has its own baseline cost.

The initial backup added 3,173,574 repository bytes, but its uncompressed tree
was **154,234,081 bytes**. That difference is essential for admission design:
compression and deduplication do not remove the memory cost of chunk references.
Each unchanged backup reused all four files, added no content/tree blobs, and
grew the repository by 619 bytes. Each small edit reprocessed only that file;
resetting mtime did not defeat ctime-based change detection.

Fresh restore and repair over existing contents passed independent union-of-data-
extents byte comparison and allocation checks. The latter deliberately wrote
nonzero data into the 1 TiB zero file before restoration. Verification itself
must skip known holes; ordinary full-file verification would reread a terabyte.

## Limits Of This Evidence

- The unchanged-format default Rabin zero stream emits one reference per 512 KiB:
  a 1 TiB file has 2,097,152 references, 64 MiB of raw IDs, and roughly 134 MiB
  of JSON references before other metadata and processing buffers.
- This fixture has highly repeated IDs, not the worst-case unique-chunk index,
  deeply nested directories, huge xattrs, long filenames, or fragmented extents.
- It is a local Btrfs directory, not the actual privileged read-only staging
  snapshot path or a quota-enforced restore. Those are separate required gates.
- No production binary, policy limit, archive deletion, or deployment was enabled
  by this experiment. Derive candidate limits from adversarial measurements and
  independently enforce process memory/runtime limits before rollout.

## Optimized Build And Compatibility

Repeating the probe with the release build, default CLI features, and explicit
strict backup/restore flags also passed. The uncompressed tree was 154,234,215
bytes. Initial/unchanged/ordinary-edit/sparse-edit times were 9.39/1.44/1.60/2.10
seconds; fresh/existing restores took 12.88/9.44 seconds. Peak memory was about
432 MiB for initial backup, 466 MiB for the sparse edit, 294 MiB for restore and
671 MiB for data checking. Raw report:
`/tmp/cocalc-native-sparse-release-report-2026-09-05.json`.

`compatibility.cjs CURRENT_RUSTIC OLD_RUSTIC RESTIC` passed with Rustic 0.11.1,
the patched 0.11.4, and independently implemented Restic 0.18.0. It checks
bounded 128 MiB/16 MiB fixtures, exact full-file hashes, symlinks and hardlinks.
Restic's official Linux amd64 archive SHA-256 was checked against its release
SHA256SUMS: `98f6dd8bf5b59058d04bfd8dab58e196cc2a680666ccee90275a3b722374438e`.

The new reader recovered the old backup with zero allocation for the all-hole
file and 1 MiB allocation for the mixed 16 MiB file. Both old Rustic and Restic
read and verified new backups correctly. They are not substitutes for the
qualified quota-safe reader: old Rustic allocated 128 MiB for the zero file;
Restic's `--sparse` still allocated 16 MiB for the mixed file. Format
compatibility and sparse allocation safety are separate properties.
