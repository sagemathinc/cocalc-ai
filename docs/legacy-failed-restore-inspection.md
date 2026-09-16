# Inspecting a Failed Legacy Restore

A failed legacy import can leave partial files in a project that subsequently
accumulates new work. Retrying a full restore is not a selective merge: it can
replace that work. Prepare the retained archive separately before deciding what
to recover.

An administrator can explicitly allow preparation of a failed import:

```sh
cocalc legacy-migration remediation prepare PROJECT_ID \
  --allow-failed-restore \
  --reason "Compare the final archive while preserving newer project files" \
  --support-reference "Support case" \
  --snapshot-name final-archive-inspection
```

The override requires a nonempty audit reason, an exactly `failed` restore
status, and an available archive with matching manifest metadata. It does not
accept active restores, or bypass the normal checks for successful restores.
The administrator identity, reason, support reference, and snapshot name are
recorded in preparation history.

Preparation uses the existing project-host snapshot/diff operation. It does not
copy the archive into live HOME or mark the restore successful. The response
includes `preparation_only: true` and the snapshot path and comparison. The
ordinary `needs_remediation` field remains false for failed imports: it describes
eligibility for the successful-migration remediation workflow, not whether this
inspection succeeded.

Inspect the snapshot and comparison, then separately review any proposed copies.
Preserve current files first, copy genuinely missing files selectively, and keep
both versions of conflicting files for review. Do not resolve conflicts by
timestamps alone. Neither `remediation apply` nor a normal restore retry is a
newer-file-preserving merge; this flag deliberately does not enable either for
failed imports. Do not run a restore retry concurrently with inspection.

The ordinary user preparation API and bulk application eligibility are unchanged.
