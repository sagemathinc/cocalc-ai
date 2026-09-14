# Legacy Migration Scripts

## `archive_to_r2.py`

Converts a legacy CoCalc.com project archive tar from:

```text
gs://kucalc-prod2-archived-projects/default/project-<project_id>.tar
```

to the cocalc.ai restore object:

```text
r2:cocalc-projects/prod3/default/<project_id>.tar.zst
```

It first tries the archive's `bup/` repo. If bup is missing or fails, it extracts
the archive's `.lz4` ZFS streams, replays the latest chain into a throwaway
file-backed ZFS pool, and exports that filesystem instead.

Run it on a VM with `bup`, `lz4`, `zstd`, `rclone`, `zfsutils-linux`, and either
`gsutil` or `gcloud`.

Bootstrap a fresh Ubuntu VM with:

```bash
sudo ./src/scripts/legacy-migration/setup-archive-to-r2-vm.sh \
  /run/secrets/cocalc/cocalc-legacy-gcs-readonly.json
```

The optional key path activates the read-only GCS service account for root,
which matters because the recovery worker usually runs with `sudo`.

Example:

```bash
sudo ./src/scripts/legacy-migration/archive_to_r2.py \
  --r2-env-file /run/secrets/cocalc/r2.sh \
  --ids-file /home/user/scratch/legacy-inventory/active_missing_r2_but_gcs_project_ids.tsv.gz \
  --limit 10
```

The default compression is `zstd -3 --long=27 -T0`, which favors migration
throughput over maximum compression. Use `--zstd-level` and `--zstd-threads` to
tune worker shape. For one worker per VM, `--zstd-threads 0` lets zstd use the
available CPUs during the final tar/compress phase. If multiple workers share a
VM, cap each worker with `--zstd-threads` to avoid CPU oversubscription.

For production shards generated from a fresh `GCS archive inventory - R2 final
object inventory` worklist, use `--skip-gcs-stat --skip-r2-stat` to avoid two
extra remote metadata calls per project. Do not use those flags for ad hoc or
hand-written project ID lists; the safe default checks both sides and skips
already-uploaded final objects.

The script writes a JSON result line per project and, after a successful
non-dry-run upload, attempts to write a sidecar to:

```text
legacy-recovery/prod3/default/<project_id>.json
```

Inspect `sidecar_uploaded` in the result line. A sidecar failure records
`sidecar_uploaded: false` and `sidecar_error` even though the archive upload
succeeded; an uploaded archive does not by itself establish that its sidecar
was written.

For the full recovery run, generate ordered ID files externally and run recent
projects first, then drain the complete `kucalc-prod2-archived-projects`
inventory. With the default remote existence check, an existing final
`prod3/default/<project_id>.tar.zst` is skipped. `--force` or `--skip-r2-stat`
bypasses that protection; restrict those options to the reviewed worklist.

Run one worker per VM with the default `--pool archive2r2`, or use a unique
`--pool` and `--workdir` per concurrent worker on the same VM. The ZFS fallback
uses a file-backed scratch pool and must not share a pool name between processes.

The final R2 upload is promoted as:

1. upload to `<project_id>.tar.zst.partial`
2. verify that the partial object's size matches the local archive
3. move it to `<project_id>.tar.zst` with `rclone moveto`
4. verify that the final object's size matches the local archive

The size checks detect incomplete transfers of a different length; they do not
compare content checksums or prove restore correctness. A failed final-size
check is reported after the move. Preserve a recovery copy before deliberately
replacing an existing final object.
