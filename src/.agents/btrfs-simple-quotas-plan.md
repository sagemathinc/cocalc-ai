# Btrfs Simple Quotas Plan

Status: implemented direction and ongoing dogfooding

Goal: keep CoCalc on btrfs simple quotas only for the project-home quota use
case, while keeping frequent local snapshots viable and avoiding the
pause/health-failure pattern observed on alpha.

## Why This Plan Exists

The alpha host showed a strong correlation between:

- classic qgroup-based quota usage
- rolling snapshot churn
- `btrfs-cleaner` pegging CPU
- router/persist/project-host health failures

After disabling:

- `COCALC_DISABLE_BTRFS_QUOTAS=1`
- `COCALC_DISABLE_BTRFS_ROLLING_SNAPSHOTS=1`
- `COCALC_DISABLE_BEES=1`

the host became materially more stable under the same kind of heavy interactive
and disk-intensive dogfooding load. This does not prove qgroups are the only
cause, but it is strong enough to justify treating "do not use classic
qgroups" as the working hypothesis.

Frequent local snapshots remain strategically important for safer coding-agent
workflows, so the target is not "remove snapshots". The target is "make quotas
cheap enough that snapshots remain usable".

## Assumptions

1. Hard exact snapshot accounting is not required.
2. Slightly unintuitive quota attribution is acceptable if it is explainable in
   the UI and docs.
3. Migration pain for existing hosts is not a blocker right now because
   CoCalc.ai is still pre-release and the current host count is tiny.
4. BEES should stay off until quota mode is settled; it is a separate axis of
   risk.

## What Simple Quotas Change

Simple quotas are promising because they avoid the backref-walking behavior that
makes classic qgroups expensive under snapshots, while preserving much of the
same admin surface.

However:

- accounting is by extent lifetime / original owner, not precise shared
  ownership
- per-snapshot usage semantics become less intuitive
- cloned/shared extent attribution can be surprising

For CoCalc, that is probably acceptable for:

- live writable project-home quota enforcement
- "this project roughly owns this much data including its snapshots"

It is not a good fit for:

- exact per-snapshot accounting
- exact shared/exclusive reporting that users will interpret literally

## Current Host Capability Check

Alpha currently has:

- kernel: `6.17.0-1010-gcp`
- `btrfs-progs`: `6.6.3`

and the installed `btrfs` userspace already advertises:

- `btrfs quota enable --simple`

So the host tooling appears sufficient for an initial simple-quota experiment.

## Current Direction

1. CoCalc uses a quota mode instead of a binary "quotas on/off" assumption.
2. Supported quota modes are:
   - `disabled`
   - `simple`
3. Classic qgroup support is intentionally removed from source paths so nobody
   can accidentally re-enable it by "improving semantics".
4. Hosts that still have qgroups enabled on disk should be force-migrated to
   `simple` at startup.
5. UI and API surfaces should clearly state which quota mode a host is using.
6. Snapshot-related storage displays should avoid overclaiming precision when
   the host is in simple-quota mode.

## Landed Implementation

### 1. Replace the boolean quota toggle with a quota mode

The file-server/btrfs layer now supports:

- `COCALC_BTRFS_QUOTA_MODE=disabled|qgroup|simple`

Compatibility:

- preserve `COCALC_DISABLE_BTRFS_QUOTAS=1` as a higher-priority override to
  `disabled`
- keep the existing emergency kill switch behavior intact
- treat the old `qgroup` value as `simple` for compatibility during rollout

### 2. Force startup reconciliation to simple quotas

Filesystem startup now does this:

- `disabled`: skip quota enable and queue startup
- `simple`: run `btrfs quota enable --simple <mount>`
- legacy qgroup runtime state: disable quotas, then re-enable in simple mode

### 3. Remove qgroup-only bookkeeping

Removed source support for:

- tracking-qgroup creation
- snapshot qgroup assignment
- qgroup-limit writes to tracking qgroups
- public/storage types that reported `"tracking"` as a supported quota scope

The remaining quota path is:

- ensure simple quotas are enabled
- apply the limit directly on the subvolume path
- read quota information from the direct subvolume qgroup row

### 4. Leave a clear comment trail

The source now includes explicit comments that classic qgroups are intentionally
unsupported because they caused severe latency, hangs, and daemon failures
under CoCalc's snapshot-heavy workload.

## Follow-Up Work

1. Keep dogfooding hosts with:
   - `COCALC_BTRFS_QUOTA_MODE=simple`
   - rolling snapshots enabled
   - BEES as a separate controlled variable
2. Make any remaining UI/operator wording reflect that CoCalc quota semantics
   are simple-quota based, not tracking-qgroup based.
3. Keep the emergency `disabled` mode, but do not reintroduce classic qgroup
   support.

## Open Risks

1. Rootfs clone / shared extent attribution may produce surprising numbers.
2. Snapshot usage UI may need a more substantial redesign than expected.
3. Some `btrfs qgroup` subcommands still behave differently enough under simple
   quotas that targeted adjustments may be needed despite the shared surface.
4. BEES may interact badly with extent attribution; keep it out of scope until
   simple quotas are proven stable first.

## Best Next Step

Keep dogfooding the current simple-quota hosts hard, and treat any attempt to
reintroduce classic qgroups as a regression rather than an alternative design
to revisit.
