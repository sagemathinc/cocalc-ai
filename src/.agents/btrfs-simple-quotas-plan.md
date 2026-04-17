# Btrfs Simple Quotas Migration Plan

Status: draft implementation and validation plan

Goal: replace expensive classic btrfs qgroups with btrfs simple quotas for the
project-home quota use case, while keeping frequent local snapshots viable and
avoiding the pause/health-failure pattern observed on alpha.

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

## Desired End State

1. CoCalc uses a quota mode instead of a binary "quotas on/off" assumption.
2. Supported quota modes are:
   - `disabled`
   - `qgroup`
   - `simple`
3. New hosts should be able to default to `simple` without invasive code forks.
4. UI and API surfaces should clearly state which quota mode a host is using.
5. Snapshot-related storage displays should avoid overclaiming precision when
   the host is in simple-quota mode.

## Proposed Implementation

### 1. Replace the boolean quota toggle with a quota mode

Introduce a host env / config mode such as:

- `COCALC_BTRFS_QUOTA_MODE=disabled|qgroup|simple`

Compatibility:

- preserve `COCALC_DISABLE_BTRFS_QUOTAS=1` as a higher-priority override to
  `disabled`
- keep the existing emergency kill switch behavior intact

### 2. Update the btrfs/filesystem initialization path

Today the filesystem layer assumes classic quotas:

- `btrfs quota enable <mount>`
- qgroup queue startup

Change this to:

- `disabled`: skip quota enable and queue startup
- `qgroup`: current behavior
- `simple`: run `btrfs quota enable --simple <mount>` and then use the same
  qgroup/limit surface unless testing shows an incompatibility

### 3. Make runtime posture and host status mode-aware

Add explicit reporting for:

- quota mode
- whether quota queue is active
- whether snapshot accounting is exact vs approximate

This should be visible in:

- runtime posture logs
- file-server runtime status
- eventually `/hosts`

### 4. Adjust storage/accounting UI semantics

In `simple` mode, do not pretend snapshot accounting means the same thing as it
did with classic qgroups.

Required changes:

- annotate snapshot usage/accounting as approximate / attribution-based
- avoid wording that implies exact shared/exclusive ownership
- keep per-project quota messaging focused on enforcement, not forensic storage
  truth

### 5. Keep BEES off during the first simple-quota phase

Do not combine:

- simple quota introduction
- BEES reintroduction

at the same time. First determine whether simple quotas plus rolling snapshots
solve the pause problem. Only then decide whether BEES can come back.

## Validation Plan

### Phase A: Fresh-host experiment

Use a fresh or freshly reprovisioned host/pool.

1. Enable:
   - `COCALC_BTRFS_QUOTA_MODE=simple`
2. Keep:
   - rolling snapshots on
   - BEES off
3. Dogfood under:
   - heavy terminal use
   - Codex turns
   - high local disk I/O
   - many open files/tabs
4. Watch for:
   - `btrfs-cleaner` pegging CPU
   - router/persist/project-host health restarts
   - user-visible pauses

### Phase B: Snapshot-heavy behavior check

Exercise:

- frequent automatic local snapshots
- snapshot deletion churn
- project restore/clone flows

Confirm:

- no return of pause storms
- quota enforcement still behaves acceptably for writable project homes
- snapshot usage displays remain understandable enough for operators/users

### Phase C: Decide default policy

If simple quotas are stable:

- make `simple` the default mode for new hosts
- keep `disabled` as the emergency fallback
- do not automatically migrate old hosts; use reprovision/rotation instead

## Open Risks

1. Rootfs clone / shared extent attribution may produce surprising numbers.
2. Snapshot usage UI may need a more substantial redesign than expected.
3. Some qgroup subcommands may behave differently enough under simple quotas
   that we need targeted adjustments despite the shared surface.
4. BEES may interact badly with extent attribution; keep it out of scope until
   simple quotas are proven stable first.

## Best Next Step

Implement quota mode support in the file-server/btrfs layer and deploy it only
to a fresh alpha-style host with:

- `COCALC_BTRFS_QUOTA_MODE=simple`
- rolling snapshots enabled
- BEES disabled

Then dogfood that host hard before deciding whether classic qgroups are gone
for good.
