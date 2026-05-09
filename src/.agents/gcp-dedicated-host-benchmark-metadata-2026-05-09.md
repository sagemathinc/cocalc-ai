# GCP Dedicated-Host Benchmark Metadata Design

Status: design note, recorded on 2026-05-09

This document records the current design for adding CPU benchmark metadata to
the GCP dedicated-host selector so customers can make materially better machine
choices for compute-heavy workloads.

It exists because raw `vCPU` count is not enough. Two GCP machine types with
the same nominal `vCPU` count can differ substantially in real compute
throughput and compute-per-dollar.

## Scope And Release Status

This is a dedicated-host catalog and UX improvement.

It is not part of billing correctness and it must not block the existing work
to keep prices accurate, complete, and clearly explained.

That said, this is user-facing product value for the same dedicated-host
surface we are actively shipping, so it is reasonable to implement as a scoped
follow-up to pricing/policy work.

Recommended scope for the first implementation:

- GCP only
- curated machine families only
- selector/sorting guidance only
- no backend billing, admission, or spend-policy dependencies

## Problem Statement

Customers choosing a dedicated host often care about questions such as:

- which `8 vCPU` machine is actually faster for CPU-heavy work
- which machine has stronger cores, not just more threads
- which machine gives the best CPU performance per dollar

Today our selector shows:

- machine family and size
- RAM and vCPU counts
- region-aware price and compatibility

That is already much better than nothing, but it still omits one important
decision dimension:

- relative compute performance

For CoCalc dedicated-host users, this matters because the workload is often:

- long-running numeric or symbolic compute
- parallel CPU-heavy jobs
- course/research servers where throughput per dollar matters

## Product Goal

The selector should help the user answer three separate questions:

1. Which machine has the highest total CPU throughput?
2. Which machine has the best CPU quality per vCPU?
3. Which machine gives the best CPU performance for the displayed price?

Those are not the same metric and should not be collapsed into a single
number.

## Non-Goals

This design is not trying to:

- predict exact performance for every customer workload
- benchmark GPU, disk, or network behavior in v1
- change provider billing logic
- change dedicated-host spend enforcement
- support every possible GCP machine series immediately
- add benchmark ranking for Nebius in v1

## Current Code Surface

The current dedicated-host catalog stack already has the right seams for this
work:

- pricing and provider estimation live in
  [project-host-pricing.ts](/home/user/cocalc-ai/src/packages/util/project-host-pricing.ts)
- machine and region option labels are assembled in
  [registry.ts](/home/user/cocalc-ai/src/packages/frontend/hosts/providers/registry.ts)
- region ranking logic already exists in
  [region-ranking.ts](/home/user/cocalc-ai/src/packages/frontend/hosts/utils/region-ranking.ts)
- create/edit host flows already expose machine metadata, price, and sorting

Benchmark metadata should be a new, parallel catalog layer. It must not be
mixed into pricing ingestion or spend logic.

## Source Strategy

### Primary source: official Google CoreMark tables

The official source should be Google’s published Compute Engine CoreMark page:

- https://docs.cloud.google.com/compute/docs/coremark-scores-of-vm-instances

Reasons:

- it is vendor-published
- it explicitly documents the methodology
- it includes machine type, CPU platform, score, standard deviation, and sample
  count

The page currently states:

- benchmarks are produced with PerfKitBenchmarker
- thread count equals the VM’s `vCPU` count
- each test runs five times and the first result is dropped

This is good enough for first-pass advisory metadata.

### Secondary source: Cyclenerd repo

This repo is still useful:

- https://github.com/Cyclenerd/google-cloud-compute-machine-types

But it should be treated as a secondary bootstrap/fill-gap source only.

Reasons:

- it is unofficial
- it may aggregate data from multiple sources
- it is useful for machine metadata and cross-checking, but it should not be
  treated as the sole truth for customer-facing benchmark claims

### Long-term source: CoCalc-owned benchmark runs

The best long-term answer is to measure our own curated machine catalog on the
actual CoCalc image and runtime stack.

That should be a later phase, not the first implementation.

## Recommended Data Model

The stored benchmark record should preserve raw source data and keep derived
indices out of the catalog itself.

Suggested type shape:

```ts
type GcpMachineBenchmarkSource =
  | "google-coremark"
  | "cyclenerd"
  | "cocalc-measured";

type GcpMachineBenchmark = {
  machine_type: string;
  cpu_platform?: string;
  architecture?: "x86_64" | "arm64";
  coremark_total: number;
  sample_count?: number;
  stddev_percent?: number;
  source: GcpMachineBenchmarkSource;
  source_url?: string;
  source_updated_at?: string;
  measured_at?: string;
};
```

Suggested storage shape:

```ts
type GcpBenchmarkCatalog = {
  fetched_at: string;
  entries: Record<string, GcpMachineBenchmark>;
};
```

Important design rule:

- store raw benchmark values
- derive all UI-facing indices later

That keeps the catalog stable and avoids rebaking data every time we change a
labeling or ranking policy.

## Derived Metrics

We should derive three metrics at runtime.

### 1. Total throughput

```text
throughput = coremark_total
```

This is the simplest answer to:

- “which full machine is faster overall”

### 2. Per-vCPU quality

```text
per_vcpu = coremark_total / vcpu_count
```

This is the simplest answer to:

- “how strong are the cores, not just how many threads do I get”

This is not the same as a true single-thread benchmark, so the UI must not
label it as “single-thread”.

### 3. CPU value

```text
cpu_value = coremark_total / displayed_hourly_price
```

This should use the customer-facing displayed hourly price:

- after provider surcharge
- after spot/on-demand choice
- after region choice

Reason:

- value should reflect what the customer is actually paying
- not our internal cost

## Normalization Policy

The catalog should not store baked “score 142” style display numbers.

Instead:

- keep raw `coremark_total`
- normalize in the frontend for the current comparison set

Recommended normalization:

### Throughput comparison

Compare among machine types with the same `vCPU` count when possible.

Reason:

- this directly answers the question the user actually asks most often:
  - “which `8 vCPU` machine is best”

Suggested display:

- `CPU perf: 1.8x vs other 8-vCPU options`

If there is no meaningful same-vCPU comparison set, fall back to absolute rank
within the current visible machine list.

### Per-vCPU comparison

Normalize globally across the curated GCP machine list.

Suggested display:

- `Core quality: 1.4x baseline`

### CPU value comparison

Normalize against the current visible options for:

- selected region
- selected pricing model
- selected surcharge settings

Suggested display:

- `CPU/$: best in this region`
- or `CPU/$: 1.3x region median`

## UI Design

### Machine option label

Do not dump raw CoreMark numbers into the main dropdown label.

Recommended label shape:

```text
c3-highcpu-8 · 8 vCPU · 16 GiB · CPU perf 1.8x · CPU/$ 1.3x
```

When benchmark data is missing:

```text
c3-highcpu-8 · 8 vCPU · 16 GiB · benchmark unavailable
```

### Tooltip or details popover

Expose raw benchmark context in a tooltip/popover, not the main label:

- raw CoreMark score
- per-vCPU score
- CPU platform
- sample count
- standard deviation
- source
- caveat that workloads vary

Example fields:

- `Raw CoreMark: 182,300`
- `Per vCPU: 22,787`
- `CPU platform: Sapphire Rapids`
- `Sample count: 120`
- `Std dev: 2.7%`
- `Source: Google Compute Engine CoreMark benchmarks`

### Machine sorting modes

We should add machine sorting modes for GCP:

- `Balanced`
- `Cheapest`
- `Fastest CPU`
- `Best CPU/$`

This should be separate from region ranking.

### What not to do

Do not:

- pretend this is a workload-specific benchmark
- use stars or vague adjectives with no data behind them
- rank machines only by raw total score across wildly different sizes

That would look polished but be technically weak.

## Curated Family Scope

The first implementation should only cover the GCP families we already expose
for dedicated hosts:

- `t2a`
- `t2d`
- `n2d`
- `c3`
- `c3d`

This is deliberate:

- it matches the current dedicated-host catalog
- it avoids expanding the scope into every GCP family
- it captures the series where customers are most likely to compare CPU-heavy
  choices

Later additions can include:

- `c4`
- `c4d`
- `n4`
- `n4d`

## Architecture Recommendation

### Phase 1: checked-in benchmark catalog

Do not start by building a fragile runtime scraper.

Instead:

- create a checked-in benchmark catalog file
- generate it with a small script from the official source
- review it manually when refreshing

Suggested new files:

- `src/packages/cloud/catalog/gcp-benchmarks.ts`
- `src/packages/cloud/catalog/gcp-benchmark-data.json`
- `src/scripts/cloud/update-gcp-benchmarks.ts`

Reasons:

- benchmark data does not need daily refresh like pricing
- checked-in data is easier to review
- UI behavior becomes deterministic
- failures in a benchmark refresh script do not break runtime host creation

### Phase 2: frontend-only integration

Wire benchmark metadata into:

- machine option labels
- machine sort modes
- machine details tooltip/popover

Do not send benchmark metadata into billing or spend policy code.

### Phase 3: CoCalc-owned measurement

Once the product value is proven, add our own benchmark pipeline for the
curated machine list on the actual CoCalc image.

That data can either replace or augment the Google benchmark source.

## Confidence And Fallback Rules

We should explicitly track source quality.

Recommended policy:

- `google-coremark`: default preferred source
- `cyclenerd`: allowed only when official data for a curated machine is missing
- `cocalc-measured`: preferred over both once it exists and is stable

If benchmark metadata is missing:

- do not block machine selection
- show `benchmark unavailable`
- disable `Fastest CPU` and `Best CPU/$` only if the visible comparison set is
  too incomplete to rank honestly

## Caveats To Surface In UI

The UI should say, in small text or tooltip form:

- benchmark numbers are synthetic CPU indicators
- real workload performance varies
- memory bandwidth, vector instructions, disk, and network can dominate some
  workloads
- CPU/$ depends on the selected region and pricing model

This is especially important when comparing:

- `t2a` vs x86 families
- `highcpu` vs `standard` shapes
- on-demand vs spot value

## Recommended Implementation Order

1. Add a checked-in benchmark catalog and refresh script for curated GCP
   families.
2. Add frontend parsing and type support for benchmark metadata.
3. Add machine sort modes:
   - `Fastest CPU`
   - `Best CPU/$`
4. Add benchmark fields to machine option labels and details tooltip.
5. Add tests covering:
   - missing benchmark metadata
   - same-vCPU throughput comparisons
   - CPU/$ ranking under different regional prices and surcharges
6. Reassess whether existing host cards should surface benchmark hints or
   whether that is selector-only in v1.

## Recommendation Summary

The right first implementation is:

- GCP only
- curated families only
- official Google CoreMark metadata as primary source
- checked-in benchmark catalog, not runtime scraping
- raw metrics stored, derived indices computed in UI
- separate throughput, per-vCPU quality, and CPU/$ signals

This gives customers actionable information without pretending benchmark data
is more exact than it really is.

## Sources

- Google Compute Engine CoreMark benchmarks:
  https://docs.cloud.google.com/compute/docs/coremark-scores-of-vm-instances
- Google Compute Engine machine-family recommendations:
  https://docs.cloud.google.com/compute/docs/machine-resource
- Cyclenerd machine-type reference repo:
  https://github.com/Cyclenerd/google-cloud-compute-machine-types
