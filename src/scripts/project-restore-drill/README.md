# Disposable Project Restore Drills

`run.py` is the maintained replacement for the October 4 operator campaign
script. That script stopped after verifying the restored bytes and left every
canary project in the operator's project list. This runner **deletes each
successful canary by default**, through the normal project deletion API, after
saving the remote-only restore result, downloaded marker, hashes, and immutable
operator attestation. It waits for deletion before marking the drill complete.
Because the public attestation receipt omits some fields, an exact audited read
checks the immutable operation, project, backup, repository, restore host and
hashes before verification and again before submitting cleanup, including when
resuming a verified checkpoint. Missing or mismatched evidence prevents deletion.
Backups keep the deletion API's normal retention (currently seven days); this
is not an immediate backup purge.

This does not change ordinary backup restores or the attestation API into
project-deletion operations. Never delete projects by matching a title.

## Preparation

- Use a current built CLI with `project create --project-id` support. Explicit
  UUID creation remains admin-only on the server. Complete the normal CLI
  browser login/fresh-auth flow; the script never loads credentials itself.
- Use a persistent private campaign directory, not `/tmp`. Every selected
  project must be a new disposable operator-owned UUID, not a customer project.
- Reserve those UUIDs in `project_backup_repo_assignments` on their authoritative
  bay before creation, using the audited operator workflow. Host registration
  can trigger backups immediately. Do not repin projects after creation or
  after a backup: cached backup configuration and history may disagree.
- Put the exact reserved UUIDs in `plan.json` as shown below. All entries in one
  invocation must belong to `--bay`; choose hosts in that bay and the matching
  regions. Connect `--api` to that owning bay first: the admin DB `--bay`
  option asserts the local bay, it does not route a query to another bay.
  Make separate campaigns for other bays. The runner checks the
  reservation before creation and checks project ownership/placement afterward.
- Include sealed repositories with confirmed backups when selecting coverage,
  not only currently writable repositories. The runner tests a fresh marker,
  not every historical customer snapshot.

```json
[
  {
    "planned_project_id": "11111111-1111-4111-8111-111111111111",
    "host_id": "22222222-2222-4222-8222-222222222222",
    "backup_repo_id": "33333333-3333-4333-8333-333333333333",
    "region": "wnam"
  }
]
```

UUIDs above are illustrative, not targets to use. The runner does not reserve
repositories or repair missing reservations. It refuses to adopt an existing
project or an old incident-script checkpoint.

## Run

Requires Python 3 on Linux and the first-party CLI. Pilot one shard first:

```sh
python3 src/scripts/project-restore-drill/run.py \
  --campaign-dir /path/to/private/campaign \
  --api https://your-site.example --profile operator \
  --owner <operator-account-uuid> --bay <owning-bay> --pilot
```

Remove `--pilot` for the remainder; completed entries are skipped. Use `--shard
<repository-uuid>` to select an exact planned shard. The default CLI executable
is `/opt/cocalc/bin/node /opt/cocalc/bin2/cocalc-cli.js`; `--node` and `--cli` can
select a locally built CLI. At most two hosts run concurrently, one drill per
host. An exclusive campaign lock prevents concurrent runners.

The steps are: create the reserved stopped project, upload a random marker,
back up, remove the original, restore to a different path with `--remote-only`,
download/hash, attest, recheck exact canary ownership/placement and stopped
state, submit deletion, and wait for its durable operation. No runtime is
started just for these file/backup operations.

The authoritative membership must contain **only the planned operator owner**.
Adding any owner, collaborator or other member prevents cleanup, even if the
operator is still an owner. Missing or malformed membership also fails closed.
Do not repurpose or share a campaign canary while a drill is in progress.

Use **`--keep-projects` only for deliberate debugging**. Successful retained
projects are reported separately, not as deleted. Failed or uncertain drills
are always retained for investigation, with project and operation IDs in their
checkpoints. They must be explicitly cleaned up by the operator afterward.

## Recovery And Evidence

`shards/<repository-uuid>/state.json` and command output files retain exact
project/backup/restore/delete IDs, marker bytes, hashes and attestations. The
immutable server attestation survives deletion of the canary and its transient
restore operation. Shard coverage remains based on that attestation as long as
the shard still has live backed-up projects.

A process interruption after verification resumes only cleanup. If a delete
operation ID was saved, the runner polls that operation instead of submitting
another deletion. A cleanup failure does **not** report complete.

An `error` or `submission_pending` checkpoint requires inspection before resume.
Use the saved outputs, `op get <uuid>`, and exact project/tombstone diagnostics
on the owning bay to reconcile the outcome. A timeout is not proof of rejection.
Only after reconciliation, correct the specific checkpoint (for example record
the already accepted `delete_op_id`) and clear the inspected error/pending
marker. Never blindly reset the state or rerun an uncertain mutation. Keep the
original evidence when performing such a repair.

This runner is for future campaigns; it does not automatically sweep or adopt
the October 4 projects or checkpoints.

## Tests

No production access is needed:

```sh
python3 -m unittest discover -s src/scripts/project-restore-drill -v
```
