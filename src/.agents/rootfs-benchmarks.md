# RootFS Benchmark Plan

This document records the benchmark plan for the RootFS publish, transport, and
fetch pipeline so we do not lose the scenarios, metrics, or assumptions while
the implementation is moving quickly.

It is intentionally narrower than the full RootFS launch plan in
[rootfs.md](/home/wstein/build/cocalc-lite2/src/.agents/rootfs.md). The goal
here is not to prove launch readiness. The goal is to do a disciplined sanity
check that the current architecture is not obviously too slow or too wasteful.

## Current Benchmark Hosts

Initial benchmark pair:

- `rootfs-test-1`
- `rootfs-test-2`

Current known characteristics:

- 4 vCPU
- 4 GB RAM
- 500 GB SSD-backed persistent disk
- different zones
- same physical data center

That same-data-center placement probably does not distort these first
benchmarks very much, because the data path we care about is:

- host A -> R2
- R2 -> host B

not direct host-to-host transfer.

The 4 GB RAM limit is acceptable for a first sanity check, but it means we
must record memory pressure during publish and fetch.

## Initial Disk Observation

On `rootfs-test-1`, a quick sequential write benchmark on the btrfs data volume
produced approximately:

- `270 MB/s` write bandwidth
- about `1K IOPS`

That is a normal-enough GCP persistent-disk baseline. It also means disk may
absolutely be a meaningful bottleneck relative to R2 transfer rates, so the
publish path must record enough timings to distinguish:

- local tree materialization cost
- `btrfs send` cost
- upload/download cost
- `btrfs receive` cost

## Benchmark Goals

The first benchmark round should answer these questions:

1. Is full-release publish fast enough on ordinary cloud disks to be usable?
2. Is cold cross-host create from a published image fast enough to be usable?
3. How much better is warm-cache create than cold-cache create?
4. Is disk or network the dominant bottleneck?
5. Are there obvious pathologies with:
   - huge files
   - lots of package-managed files
   - metadata-heavy source trees
6. Is the current host RAM level enough for the pipeline to complete cleanly?

We do not need to answer every question about launch capacity here. We need to
decide whether the current RootFS design is on a plausible path.

## Metrics To Capture For Every Run

For every benchmark run, capture:

- date and git commit
- source host id
- destination host id
- cloud/provider
- region and zone
- disk class
- disk size
- vCPU and RAM
- workload name
- whether destination cache was cold or warm
- total publish LRO duration
- total create/start duration on destination host
- peak host RSS during publish and fetch if available

Capture phase timings too:

- snapshot/clone time
- merged-tree materialization time
- tree hash time
- `btrfs send` time
- artifact upload time
- artifact download time
- `btrfs receive` time
- lowerdir materialization / cache registration time
- project container start time

Capture artifact sizes:

- logical tree size
- btrfs stream size
- uploaded object size

Capture outcome details:

- success/failure
- error text if failed
- retry success/failure

## Instrumentation Requirements

Before or during this benchmark work, we should add phase timing to the
relevant LROs and transport code paths. This is not benchmark-only work; it has
long-term operational value.

At minimum:

- `project-rootfs-publish` LRO should emit phase timings
- project create/start from managed RootFS should emit phase timings
- host-side RootFS fetch/import should log:
  - backend used
  - replica region
  - bytes transferred
  - download duration
  - receive duration

The benchmark harness should avoid manual stopwatch timing as much as possible.

## Benchmark Sequence

The first pass should be run in this order.

### 1. Raw storage baseline

Measure:

- sequential read throughput on the btrfs volume
- sequential write throughput on the btrfs volume
- a simple `btrfs send` to local file
- a simple `btrfs receive` from local file
- raw upload of a 1 GB file to the regional R2 bucket
- raw download of a 1 GB file from the regional R2 bucket

Purpose:

- separate pure disk cost from pure object-storage cost

### 2. Minimal unchanged-base publish

Publish a project that has no meaningful RootFS changes beyond the selected
base image.

Measure:

- how much overhead exists even for a near-empty publish
- whether current tree hashing and send are acceptably cheap

### 3. Package-heavy publish

This should be a realistic systemwide environment customization under `/`,
preferably with machine-learning packages because that is a common real use
case.

Primary target:

- install TensorFlow or PyTorch systemwide in the project RootFS

Secondary fallback if package/arch availability is awkward:

- install a similarly large systemwide stack such as JupyterLab plus its core
  dependencies

The benchmark should aim for roughly:

- `1-3 GB` of mixed package-managed files under `/usr`, `/usr/local`, and
  related directories

Purpose:

- realistic user customization
- mixed file sizes and metadata
- not just a synthetic giant blob

### 4. Large incompressible file publish

Create a random file under `/`, for example:

- `4 GB` random binary file

Purpose:

- worst-case artifact size
- worst-case upload/download
- makes it obvious whether the path is network-limited or disk-limited

### 5. Metadata-heavy publish

Clone several large source trees into `/opt` or another RootFS path.

Suggested candidates:

- `sagemath`
- `cocalc`
- `openai/codex`

The point is not these exact repos. The point is:

- many files
- many directories
- symlinks
- heterogeneous file sizes

Purpose:

- stress metadata traversal and tree hashing
- catch issues that a single huge file will never reveal

### 6. Cold cross-host create

For each published workload image:

- publish on `rootfs-test-1`
- ensure cache is absent on `rootfs-test-2`
- create a fresh project on `rootfs-test-2`

Measure:

- download time
- receive/import time
- total time to a running project

### 7. Warm-cache cross-host create

Repeat the create on `rootfs-test-2` from the same image without clearing the
cache.

Purpose:

- isolate startup overhead from transport/import overhead
- quantify the value of prepull and cache hits

### 8. Image-switch timing

Use an existing project and switch:

- base image A -> published image B
- published image B -> base image A

Measure:

- stop time
- unmount time
- lowerdir switch time
- restart time

Purpose:

- validate that switching an existing project is operationally reasonable

### 9. Failure injection

Once the happy-path numbers are known, intentionally break the flow:

- restart hub during publish
- restart destination host during fetch
- interrupt upload
- interrupt download

Purpose:

- verify replica status and LRO state are sane after failure
- ensure retries do not corrupt release metadata

## Workload Matrix

The minimum first-round matrix should be:

1. `base-empty`
2. `package-heavy-ml`
3. `blob-4g-random`
4. `metadata-heavy-repos`

For each workload:

1. publish on host A
2. create cold on host B
3. create warm on host B

That gives a compact matrix while still covering the main failure modes.

## Questions The Results Should Answer

After the first round, we should be able to say:

- whether full btrfs-stream publish is fast enough for real users
- whether R2 is fast enough relative to the disk
- whether prepull is likely to matter for the official images
- whether 4 GB RAM is already too small for comfort
- which phase dominates:
  - tree walk/hash
  - local disk copy/materialization
  - `btrfs send`
  - network upload/download
  - `btrfs receive`

## What We Are Not Testing Yet

This benchmark round is not meant to settle:

- incremental release storage
- cross-region replica placement strategy
- large-scale host churn
- launch-scale concurrency
- GPU image performance

Those matter, but they should come after the first same-region sanity check.

## Follow-up Benchmark Round

After this first round, the next serious benchmark pass should use:

- stronger hosts
- more production-like RAM
- explicit disk-class selection
- preferably one pair on GCP and one pair on Nebius

That round should also add:

- cross-region fallback
- prepull policy experiments
- larger official-image candidates

## Result Template

Use a table like this for each run:

| workload | source host | dest host | cache | tree size | stream size | publish total | hash | send | upload | download | receive | start | result | notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| base-empty | rootfs-test-1 | rootfs-test-2 | cold |  |  |  |  |  |  |  |  |  |  |  |

And record environment metadata alongside the table:

- git commit
- provider
- region/zone
- disk type and size
- RAM
- vCPU

## Recommended Immediate Action

The next concrete work after writing this document should be:

1. add phase timing to publish and create/fetch LROs
2. script the workload setup and measurement via `cocalc-cli`
3. run the four-workload same-region matrix on `rootfs-test-1` and
   `rootfs-test-2`
4. review the numbers before spending time on incremental releases or broader
   performance work
