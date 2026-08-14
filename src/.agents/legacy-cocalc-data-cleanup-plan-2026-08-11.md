# Legacy CoCalc.com Data Cleanup Plan

Date: 2026-08-11

Status: operational plan. No deletion has been performed by this document.

Update 2026-08-11T23:18Z: William applied delete-all lifecycle rules to
`kucalc-prod2-storage-streams` and `kucalc-prod2-archived-projects`. Both
buckets now have Object Versioning disabled, Soft Delete retention set to 0,
and a lifecycle rule deleting objects with `age: 0`. Cloud Storage lifecycle
deletion is now expected to proceed asynchronously.

Update 2026-08-12T19:40Z: rechecked both bucket configs and Cloud Monitoring
metrics. The delete-all lifecycle rules remain installed, Object Versioning
remains disabled, and Soft Delete retention remains 0. Monitoring still shows
no change in `total_bytes` or `object_count` from the 2026-08-11 baseline:
`kucalc-prod2-storage-streams` remains 82,119,017,933,760 bytes and
36,758,197 objects; `kucalc-prod2-archived-projects` remains
61,197,462,829,175 bytes and 4,202,162 objects.

Update 2026-08-12T20:00Z: Google Cloud Console object browser showed "No rows
to display" and "No soft-deleted objects" for both buckets. A direct Storage
JSON API `objects.list` check with `maxResults=5` also returned zero live
objects and zero versioned objects for both buckets. This is stronger evidence
that lifecycle deletion completed and the Cloud Monitoring
`storage/total_bytes` and `storage/object_count` aggregates are stale or
lagging.

## Goal

Reduce ongoing costs from old `cocalc.com` infrastructure after the July 2026
shutdown and project archive migration, while keeping the remaining blob
migration work separate and recoverable.

The near-term deletion targets are old project archive/storage buckets and
obsolete VM disks. The old legacy blob sources are not deletion targets yet.

## Current Cost Signal

Inputs:

- August 2026 billing CSV uploaded under `/home/user/scratch`.
- Cloud Monitoring bucket metrics queried after authenticating as
  `wstein@sagemath.com` against GCP project `sage-math-inc`.

The report appears to contain mainly the first 10 days of August. The SKU-level
Cloud Storage subtotal is 266.95 USD for the report window.

Dominant storage SKUs:

| SKU                              |               Usage | Report subtotal |
| -------------------------------- | ------------------: | --------------: |
| Nearline Storage South Carolina  | 16,554.76 GiB-month |      165.55 USD |
| Coldline Storage South Carolina  | 22,203.67 GiB-month |       88.81 USD |
| Nearline Storage US Multi-region |    597.18 GiB-month |        8.96 USD |
| Archive Storage US Multi-region  |    952.79 GiB-month |        2.29 USD |

The two South Carolina SKUs almost certainly correspond to:

- `kucalc-prod2-archived-projects` - Nearline, us-east1
- `kucalc-prod2-storage-streams` - Coldline, us-east1

Assuming this is approximately 10 days of a 31-day month:

- South Carolina Nearline monthly equivalent: about 513 USD/month.
- South Carolina Coldline monthly equivalent: about 275 USD/month.
- Combined old project bucket monthly equivalent: about 790 USD/month.
- Implied stored size: roughly 50 TiB Nearline plus 67 TiB Coldline, about 117 TiB total.

After resolving the exact current bucket metrics from Cloud Monitoring:

| Bucket                            | Class    | Current size | Object count |
| --------------------------------- | -------- | -----------: | -----------: |
| `kucalc-prod2-storage-streams`    | Coldline |    74.69 TiB |   36,758,197 |
| `kucalc-prod2-archived-projects`  | Nearline |    55.66 TiB |    4,202,162 |
| combined old project bucket total | mixed    |   130.35 TiB |   40,960,359 |

Using the observed SKU rates in the billing report:

- Coldline South Carolina is exactly about 0.004 USD/GiB-month.
- Nearline South Carolina is exactly about 0.010 USD/GiB-month.
- `kucalc-prod2-storage-streams` is about 306 USD/month.
- `kucalc-prod2-archived-projects` is about 570 USD/month.
- Combined old project bucket storage is about 876 USD/month, or about
  29 USD/day.

The billing CSV usage divided by current bucket size implies the report covers
about 9 days of storage, which explains the earlier rough 10-day extrapolation.

Other visible report costs:

- Compute Engine subtotal: 56.79 USD in the report window, roughly
  160-180 USD/month if the same pattern continues.
- Persistent disk SKU shown in the CSV is small, but disk inventory still needs
  a separate check because stopped VMs can retain large disks.

## Retention Decision

Recommended decision:

1. Delete `kucalc-prod2-storage-streams`.
2. Delete `kucalc-prod2-archived-projects`.
3. Keep the old blob sources until the R2 blob plan reaches its own cleanup
   gate:

- old `smc-blobs` bucket;
- old database VM/disk or a verified export sufficient to recover blob
  bytes and metadata.

Current `smc-blobs` metrics:

| Storage class                | Current size | Object count |
| ---------------------------- | -----------: | -----------: |
| Durable Reduced Availability |    29.47 GiB |      496,075 |
| Multi-Regional               |   178.51 GiB |    4,017,503 |
| Nearline                     |     1.24 TiB |   19,192,273 |
| `smc-blobs` total            |     1.45 TiB |   23,705,851 |

This confirms `smc-blobs` is much smaller than the old project buckets, but it
contains the unresolved legacy blob corpus and should not be deleted yet.

Rationale:

- Millions of projects were migrated to R2 over a month ago.
- Successful restores have been observed.
- There are no known reports of failed restores or missing project data.
- The remaining unsolved legacy blob work does not require these old project
  archive buckets.

## Preconditions Before Bucket Deletion

Before applying deletion:

1. Confirm the old project migration manifests and R2 repositories are still
   available and independently backed up.
2. Confirm no restore worker, cron job, or operator script still reads either
   old bucket.
3. Snapshot current bucket metadata:

```sh
gcloud storage buckets describe gs://kucalc-prod2-storage-streams --format=json \
  > /tmp/kucalc-prod2-storage-streams.bucket.json

gcloud storage buckets describe gs://kucalc-prod2-archived-projects --format=json \
  > /tmp/kucalc-prod2-archived-projects.bucket.json
```

4. Save current billing evidence and this deletion approval note in a durable
   operator folder.
5. If a fresh exact size is required, prefer Cloud Monitoring bucket metrics
   over `gcloud storage du` because `du` lists objects and can be slow for huge
   buckets. If `du` is used, include noncurrent versions:

```sh
gcloud storage du --summarize --readable-sizes --all-versions \
  gs://kucalc-prod2-storage-streams

gcloud storage du --summarize --readable-sizes --all-versions \
  gs://kucalc-prod2-archived-projects
```

6. Verify and update `gcloud` auth. The current local config was observed to
   fail refreshing `cocalc-rocket-bootstrap@projecthosts.iam.gserviceaccount.com`.

On 2026-08-11, `gcloud auth login --no-launch-browser` restored access as
`wstein@sagemath.com`. The bucket-owning project is `sage-math-inc`, not
`projecthosts`.

Current bucket protection state:

| Bucket                           | Versioning | Soft Delete | Lifecycle state                         |
| -------------------------------- | ---------- | ----------- | --------------------------------------- |
| `kucalc-prod2-storage-streams`   | enabled    | 30 days     | deletes noncurrent versions after 1 day |
| `kucalc-prod2-archived-projects` | enabled    | 30 days     | deletes older noncurrent versions       |
| `smc-blobs`                      | enabled    | 30 days     | deletes older noncurrent versions       |

There is no retention policy shown in the bucket metadata for the two project
cleanup buckets.

## Efficient GCS Bucket Deletion Strategy

Do not delete millions of objects from a local shell loop.

Preferred strategy:

1. Disable Object Versioning so no new noncurrent versions are created.
2. Disable or minimize Soft Delete before deleting live objects, if policy
   permits. Existing soft-deleted objects are not affected by clearing the
   setting.
3. Install an Object Lifecycle Management rule with `Age=0` and `Delete`, so
   Cloud Storage performs server-side asynchronous bulk deletion.
4. Monitor bucket object count and bytes until live and noncurrent bytes fall.
5. Delete the now-empty bucket after lifecycle deletion completes and retention
   windows expire.

Example lifecycle file:

```json
{
  "rule": [
    {
      "action": { "type": "Delete" },
      "condition": { "age": 0 }
    }
  ]
}
```

Example commands:

```sh
gcloud storage buckets update gs://kucalc-prod2-storage-streams \
  --no-versioning \
  --clear-soft-delete \
  --lifecycle-file=/tmp/delete-all-objects-lifecycle.json

gcloud storage buckets update gs://kucalc-prod2-archived-projects \
  --no-versioning \
  --clear-soft-delete \
  --lifecycle-file=/tmp/delete-all-objects-lifecycle.json
```

If retention policies or holds are configured, clear only unlocked policies
after inspection. Do not use `--lock-retention-period`.

Important billing caveats:

- Soft-deleted objects can remain billable until their retention duration ends.
- Existing soft-deleted objects are not removed by `--clear-soft-delete`.
- Object Versioning can retain noncurrent versions; include noncurrent bytes in
  size checks.
- Nearline and Coldline can have early deletion charges, but this data is old
  enough that ordinary minimum-storage-duration charges should not dominate.

## VM Disk Cleanup

Inventory before deleting:

```sh
gcloud compute instances list --project=sage-math-inc
gcloud compute disks list --project=sage-math-inc --sort-by=~sizeGb
gcloud compute snapshots list --sort-by=~creationTimestamp
```

Current visible VM/disk inventory in `sage-math-inc`:

| Instance                | Zone         | Status     | Machine type    | Notes                                                    |
| ----------------------- | ------------ | ---------- | --------------- | -------------------------------------------------------- |
| `m1-sagemath-org`       | `us-west1-b` | running    | `f1-micro`      | likely unrelated small host                              |
| `kucalc-prod3-ctl-hsy`  | `us-east1-d` | running    | `e2-standard-4` | legacy recovery host; attached to blob/db recovery disks |
| `kucalc-prod3-ctl`      | `us-east1-d` | terminated | `n2-highmem-2`  | old control VM                                           |
| `kucalc-prod3-ctl-ws-3` | `us-east1-d` | terminated | `n2d-highmem-4` | old worker/control VM                                    |
| `kucalc-prod3-master`   | `us-east1-d` | terminated | `n1-standard-4` | old master VM                                            |

Largest disks:

| Disk                    |   Size | Type          | Attached to            |
| ----------------------- | -----: | ------------- | ---------------------- |
| `shares-recovery`       | 675 GB | `pd-standard` | `kucalc-prod3-ctl-hsy` |
| `prod3-db-archive`      | 300 GB | `pd-standard` | `kucalc-prod3-ctl-hsy` |
| `kucalc-prod3-ctl-ws-3` | 300 GB | `pd-standard` | terminated VM          |
| `kucalc-prod3-master`   | 133 GB | `pd-standard` | terminated VM          |
| `kucalc-prod3-ctl`      | 100 GB | `pd-standard` | terminated VM          |
| `kucalc-prod3-ctl-hsy`  | 100 GB | `pd-balanced` | running recovery VM    |
| `m1-sagemath-org`       |  10 GB | `pd-balanced` | running small VM       |

## Old Compute Servers Project

The old "compute servers" product used a separate GCP project:

```text
cocalccomputeservers-398318
```

Current decision from William: preserve exactly one running VM and its disk.
Everything else in that project is a cleanup candidate.

Current VM/disk state:

| Resource                              | State                             |
| ------------------------------------- | --------------------------------- |
| VM `prod-5155` in `us-east5-a`        | running, preserve                 |
| Disk `prod-5155`, 60 GB `pd-standard` | attached to `prod-5155`, preserve |
| Other VM instances                    | none found                        |
| Other persistent disks                | none found                        |
| Static external addresses             | none found                        |

Current bucket state:

- 25 buckets, all named `prod-*`.
- All have 7-day Soft Delete.
- Object Versioning is not shown as enabled.
- Total size: 949,723,934,059 bytes, about 884.50 GiB.
- Total object count: 2,730,303.

Storage class breakdown from Cloud Monitoring:

| Storage class     | Current size |
| ----------------- | -----------: |
| Archive           |   773.03 GiB |
| Coldline          |    63.28 GiB |
| Nearline          |    24.26 GiB |
| Regional/Standard |    23.93 GiB |

Rough bucket storage cost is only a few dollars per month because most bytes
are Archive class. The buckets are still cleanup targets because they are
legacy product data and add operational clutter.

Largest buckets:

| Bucket                                               |       Size |   Objects |
| ---------------------------------------------------- | ---------: | --------: |
| `prod-00000025-23737b24-400f-4efd-b70e-c8e89f727b82` | 388.07 GiB | 2,289,857 |
| `prod-00000031-512830d0-db19-49fc-a608-f5309c6273da` | 214.02 GiB |   322,241 |
| `prod-00000048-ad02f7dc-e805-442e-bb3b-a00f36708f45` | 105.85 GiB |    22,638 |
| `prod-00000040-b9ae3b32-5283-4fb1-96a2-32fc4c44313b` |  55.53 GiB |     4,871 |
| `prod-00000022-28966641-26ac-44ee-88f5-ccab279c668a` |  39.77 GiB |     8,303 |

Current snapshot state:

- 61 snapshots, all `READY`.
- All named `prod-*-shutdown`.
- Created on 2026-07-01 around 04:45-05:07 Pacific.
- Total source disk size: 4,335 GB.
- Total snapshot storage bytes: 1,601,109,997,504 bytes, about 1.46 TiB.

Largest snapshots:

| Snapshot              | Source disk size | Snapshot storage |
| --------------------- | ---------------: | ---------------: |
| `prod-3214-shutdown`  |           500 GB |       276.64 GiB |
| `prod-9916-shutdown`  |           125 GB |        56.39 GiB |
| `prod-11063-shutdown` |           125 GB |        52.44 GiB |
| `prod-9935-shutdown`  |           125 GB |        48.26 GiB |
| `prod-10925-shutdown` |           100 GB |        43.35 GiB |

Recommended compute-server cleanup sequence:

1. Verify `prod-5155` is the only VM to preserve.
2. Delete all 25 `prod-*` buckets except there is no `prod-5155` bucket in the
   current bucket list. Use server-side lifecycle deletion or bucket deletion
   after disabling Soft Delete if immediate cost/clutter cleanup is desired.
3. Delete all 61 `prod-*-shutdown` snapshots.
4. Re-run inventory and confirm only VM `prod-5155` and disk `prod-5155`
   remain.

Recommended policy:

1. Keep exactly the VM/disk needed for legacy blob work until R2 blob migration
   reaches its cleanup gate.
2. Delete stopped VMs that are not needed for blob recovery.
3. Delete unattached disks after a final snapshot only if they might contain
   unique operational data.
4. Delete old snapshots after the corresponding disks are intentionally gone
   and a short verification window passes.

## Blob R2 Implementation Plan

Do not tie old project bucket deletion to legacy blob migration. The old
project buckets can go first.

For blobs, follow the existing plan in
`legacy-blob-r2-storage-and-migration-plan-2026-07-18.md`, but implement in
small deployable slices:

### Phase A: no-behavior-change storage abstraction

- Add a `BlobByteStore` interface under `@cocalc/server/blobs`.
- Add a PostgreSQL implementation that delegates to existing `db().save_blob`
  and `db().get_blob`.
- Route `saveBlobToDatabase` and `readBlobFromDatabase` through the interface
  while keeping behavior unchanged.
- Add tests for UUID validation, idempotent save, and read missing/existing.

Gate: all current blob tests pass and no deployment configuration changes.

### Phase B: R2 object layout and backend

- Add deterministic key layout:
  `blobs/v1/<first-two-uuid-hex>/<uuid>`.
- Add R2 implementation using `@cocalc/backend/r2`.
- Store exact uncompressed bytes.
- Store trusted metadata:
  `sha256`, `size`, `content-type`, `source`, `version`, `created-at`.
- Implement `head`, `get`, and conditional immutable `put`.

Gate: focused tests with a mocked R2 request layer verify collision handling
and idempotent duplicate writes.

### Phase C: managed-site configuration

- Add explicit backend setting:
  `blob_storage_backend = auto | postgres | r2`.
- Add blob-specific R2 bucket/host settings rather than overloading backup
  bucket semantics:
  - blob bucket prefix or full bucket name;
  - canonical public blob host;
  - read Worker health URL;
  - write credential selection.
- Use `secret-setting-input.tsx` for any admin secret UI.
- `auto` must choose R2 only when configuration and health checks are complete
  before writes begin.

Gate: partial R2 config fails closed to PostgreSQL or refuses R2 startup; it
must never silently split writes.

### Phase D: public read Worker

- Implement a small Worker outside the hub data path.
- Accept only canonical UUID GET/HEAD.
- Validate UUID before R2 access.
- Return immutable cache headers and `nosniff`.
- Reject listing, metadata, and arbitrary key proxy behavior.
- Keep `/blobs/<filename>?uuid=<uuid>` as compatibility redirect or hub route
  during transition.

Gate: staging proves cold/warm read behavior and malformed request behavior.

### Phase E: dual-write and current corpus

- Dual-write current production uploads to PostgreSQL and R2.
- Backfill the small current production corpus.
- Verify bytes and UUIDs.
- Switch public reads to Worker/R2 only after verified copies exist.
- Keep PostgreSQL bytea for rollback until a separate cleanup decision.

### Phase F: legacy blob migration

- Inventory legacy database rows and exact archived-syncstring exclusions.
- Reconcile `smc-blobs` GCS pointers.
- Migrate only verified safe raster images.
- Record a resumable manifest outside the serving path.
- Keep old blob sources read-only until support cases and random verification
  pass explicit thresholds.

## Immediate Next Actions

1. Re-authenticate `gcloud` with an account that can inspect and modify the old
   buckets.
2. Save bucket metadata and lifecycle/soft-delete/versioning state.
3. Make a written operator decision to delete the two old project buckets.
4. Apply server-side lifecycle delete rules with `Age=0`.
5. Monitor billing and bucket metrics daily until the storage SKUs disappear or
   reduce to soft-delete retention tail.
6. Start Phase A of the blob R2 implementation in code.

## References

- Google Cloud Storage object deletion overview:
  https://docs.cloud.google.com/storage/docs/object-deletion-overview
- Google Cloud Storage delete objects:
  https://docs.cloud.google.com/storage/docs/deleting-objects
- Google Cloud Storage soft delete:
  https://docs.cloud.google.com/storage/docs/soft-delete
- Google Cloud Storage lifecycle management:
  https://docs.cloud.google.com/storage/docs/lifecycle
- Google Cloud Storage pricing:
  https://cloud.google.com/storage/pricing
- Cloudflare R2 pricing:
  https://developers.cloudflare.com/r2/pricing/
