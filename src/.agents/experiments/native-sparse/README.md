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

## Native Btrfs Quota And Snapshot Gate

[Qualification run 34001212323](https://github.com/sagemathinc/rustic/actions/runs/34001212323)
passed on both native `ubuntu-24.04` (amd64) and `ubuntu-24.04-arm`. CLI source
`0ef705a619cf07996d4711cf8e8c5701d6bb70ce` pins core `5b6146b`.

Each runner creates a marked, disposable 8 GiB Btrfs loop filesystem. The test
uses actual read-only snapshots for three successive backups and sets a 4 GiB
qgroup limit on the restore subvolume. A deliberate 5 GiB allocation must fail
with EDQUOT, not ENOSPC, before the restore test counts as quota-enforced.

Both architectures restored the 10 GiB / three-island fixture in 12,288 bytes,
the mixed 16 MiB fixture in 1,048,576 bytes, and preserved hardlinks and symlinks.
Independent union-of-data-extents comparisons and `check --read-data` passed.
The unchanged backup reused all five file entries with zero new file data; an
ordinary-file edit followed by resetting mtime changed only that file.

This qualifies the native binary on those fixtures, not CoCalc's production
staging reservation, privileged service supervision or archive deletion logic.
No rollout or policy exclusion was enabled. Keep this distinction when using
these results for parameter or lifecycle decisions.

The follow-up run `34002157054` also passed on both architectures, with CLI
`737ba53` and pinned core `f45990d`, including admission and capability support.

## Admission And Metadata Costs

Run `python3 admission_probe.py CURRENT_RUSTIC /absolute/report.json`. It uses
an isolated local repository, four Rayon threads, bounded output and process-
group deadlines. It measures actual metadata and RSS, not only upload size.
The current release build passed; full report is local
`/tmp/cocalc-native-admission-report-2026-09-05.json`.

- A 70 TiB all-hole file was inventoried in 0.32 seconds: 146,800,640 worst-case
  content references, or 9,835,642,880 JSON-reference bytes before other metadata.
  A 4,194,304-reference test budget rejected it in 0.32 seconds, before any
  repository artifact was written. This is a test threshold, not a fleet limit.
- 5,000 empty files with long names and 2 KiB xattrs required 16,285,000 source-
  metadata bytes. Their tree serialized to 16,280,012 bytes and compressed to
  only 50,684 bytes. Zero apparent file data does not mean negligible backup work.
  Inventory took 0.40 seconds; backup took 0.67 seconds. A metadata budget one
  byte too small, and a 4,999-entry budget, failed without repository writes.
- The next backup reused all 5,000 files and added no data/tree blobs (0.56 s).
  A separate 128 MiB dense fixture backed up in 1.07 seconds at 227 MiB peak RSS;
  its unchanged backup reused both files with no new blobs in 0.33 seconds.

These are bounded fixtures, not proof of maximum unique-index growth, extreme
xattrs/depth, global concurrency or production throughput. A trial 4 GiB virtual
address-space cap aborted the 1,000-file run; that failure alone does not establish
a 4 GiB RSS requirement. Virtual reservations are distinct from RSS. The probe uses a 16 GiB
virtual cap. Production memory enforcement uses the separately qualified cgroup
MemoryMax, not RLIMIT_AS. Do not infer a production RSS budget from either cap.
