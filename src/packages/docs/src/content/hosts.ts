/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

export const PROJECT_HOSTS_BODY = String.raw`
## What project hosts are for

A project host is compute capacity that can run CoCalc projects. On hosted
CoCalc, project hosts are CoCalc-managed or cloud-backed capacity; users cannot
attach an arbitrary local computer or VM as a host. Hosts have access to
project-level credentials such as backup passwords, so direct user-controlled
hosts are only appropriate in self-hosted Launchpad or Rocket deployments.

Use project hosts for heavier workloads such as long-running research
computations, courses, or agent sandboxes.

The host is not just a label. It controls where the project filesystem lives,
where project processes run, where host-local snapshots are stored, what runtime
software is installed, which backup region is used, and which users are allowed
to place projects there.

## Create or choose a host

1. Open the project host administration area.
2. Configure a cloud provider. In self-hosted Launchpad or Rocket, configure a
   cloud provider or self-hosted connector.
3. Refresh the provider catalog if needed.
4. Choose a machine type, region, disk size, and lifecycle policy.
5. Start the host and wait for bootstrap to finish.
6. Move or create projects on the host when it is ready.

Use enough disk space for runtime images and project data. Very small disks can
fail during image bootstrap or package installation.

## Access and placement

Private hosts are available to the owner and delegated users. A delegated
**User** can create or move projects onto the host. A delegated **Manager** can
also start and stop the host, manage access, configure the per-project RAM cap,
and place projects there.

Admins can publish a host into the **Public shared pool** by assigning a host
tier. Users whose membership grants that project-host tier, or a higher tier,
may place projects there without delegated host access.

## Project RAM cap

The host **Project resource policy** has an optional per-project RAM cap. This
cap lets projects use more RAM on a large host without changing normal project
policy for CPU and storage. Leave it blank when normal project limits should
apply. Set it deliberately when the host is dedicated to workloads that need
larger in-memory notebooks, language models, databases, or agents.

## Moving projects

Moving a project between hosts is a data operation, not a cosmetic setting.
CoCalc moves through backups and restore. Files in \`/tmp\` are discarded,
previous host-local snapshots are discarded after the move, and SSH access must
be reconfigured after the move. If the destination region differs, the backup
region can change after a successful new backup.

## Long-running work

For research jobs, scheduled automation, or agent sandboxes, use a host with
enough CPU, RAM, disk, and restart behavior for the workload. Keep important
state in project files, a database, or another durable location rather than only
inside a process.

## Agent notes

When helping with project hosts:

1. Determine whether the user is on hosted CoCalc, Launchpad, Rocket, or Lite.
   Lite does not use project hosts. Hosted CoCalc does not allow arbitrary
   local user machines as hosts.
2. Open the hosts page with the \`hosts.open\` docs action when browser context
   is available.
3. For CLI inspection, start with:

~~~sh
cocalc host list --json
cocalc host get <host>
cocalc host projects <host> --all
cocalc host metrics <host>
cocalc host bootstrap-status <host>
~~~

4. Before recommending a move, check source host status, backup freshness,
   destination access, destination RAM/disk, region changes, and whether \`/tmp\`
   or host-local snapshots matter.
5. Do not assume the current bay is authoritative. Route host operations by the
   host's owning bay and project operations by the project's owning bay.

## Why this matters in CoCalc

Project hosts make CoCalc more than a shared web editor. They let the workspace
own real compute, run persistent services, use cloud machines economically, and
give agents a stable Linux environment to work in.
`;

export const PROJECT_HOST_ACCESS_BODY = String.raw`
## What host access controls

Host access controls who may place projects on a private dedicated host and who
may administer that host. It is separate from project collaborators: a user can
collaborate on a project without being able to create their own projects on the
host, and a host user can place their own projects without being a collaborator
on every existing project.

## Roles

- **Owner** pays for the host and has full control.
- **Manager** can start and stop the host, manage access, configure the
  per-project RAM cap, and place projects on the host.
- **User** can create or move their own projects onto the host.

Use **Access** on the host drawer to add users or managers by account. Use
**Remove** to revoke delegated access.

## Public shared pool

Admins can put a host in the public shared pool by enabling the shared-pool
policy and setting a tier. Any user with project-host tier greater than or
equal to that value may place projects there without a delegated access row.

Use this for shared fleet capacity. Use delegated access for a private host
that should only be usable by a known set of people.

## Per-project RAM cap

The host access page also includes **Project resource policy**. The optional
RAM cap applies to projects running on that host. It is useful when a large
dedicated host should permit larger notebooks, agents, or databases than the
normal project policy allows.

Do not set the cap higher than the host can realistically support for the
number of simultaneous projects. If several projects can run at once, leave
headroom for the project host itself, filesystem cache, backups, and runtime
services.

## Agent notes

When answering access questions:

1. Distinguish host access from project collaborators.
2. Check whether the host is private, delegated, or public shared-pool.
3. For "why can't I move/create here?", check delegated access, membership host
   tier, host status, placement availability, and region filters.
4. For RAM questions, compare the per-project RAM cap with host RAM and the
   number of projects expected to run concurrently.
5. Host access mutations require fresh auth and must route to the host-owning
   bay.
`;

export const PROJECT_HOST_MOVE_BODY = String.raw`
## What a project host move does

Moving a project to another host changes where the project runs and where the
project's host-local data lives. CoCalc uses backups to transfer the project to
the destination host, restores it there, and updates the project-host
assignment.

Use a move when a project needs more RAM, GPUs, a different region, a quieter
host, or a host that a specific group can access.

## Before moving

Check these items before starting the move:

1. The destination host is running or can be started.
2. The user is allowed to place projects on the destination host.
3. The destination has enough disk and RAM for the project.
4. The source host has a recent backup, especially if the source host is
   stopped or deprovisioned.
5. The user understands that \`/tmp\` files and previous host-local snapshots
   will not follow the project.
6. SSH access may need to be configured again after the move.

If the move changes backup region, CoCalc restores from the current backup
region, creates a new backup in the destination region, then switches the
project's backup region after that backup succeeds.

## During and after the move

Watch the move progress. If the source host is unavailable, the move may use
the most recent backup. After the move finishes, open the project, verify files,
start the needed notebooks or services, and check that collaborators can still
work.

## Agent notes

For browser work, open the project settings or project file flyout and use the
host picker. For CLI work, inspect the host and project first:

~~~sh
cocalc host list --json
cocalc host get <destination-host>
cocalc host projects <source-host> --all
~~~

If automating a move, prefer explicit destination host ids. Do not rely on
implicit placement unless the task is genuinely "pick an available host".
Always mention the \`/tmp\`, snapshot, backup freshness, SSH, and region
consequences before advising a user to move important work.
`;

export const PROJECT_HOST_LIFECYCLE_BODY = String.raw`
## Lifecycle states

A project host has two related lifecycles:

1. the CoCalc host record, access policy, billing policy, and project
   placement metadata
2. the provider resources that actually run projects, such as the VM, disk,
   network identity, daemon processes, and runtime software

**Start** provisions or starts the provider machine and then waits for
bootstrap, software lifecycle, and daemon health to settle. **Stop** shuts down
the machine while keeping the host record and recoverable provider state.
**Restart** reboots the running machine. **Deprovision** removes provider
resources. **Delete** removes the host record after deprovisioning, or before a
provider machine was ever created.

## Start, stop, and restart

Use **Start** when the host is stopped or deprovisioned but should run
projects again. Start can be blocked by billing enforcement, missing connector
availability for self-hosted machines, active lifecycle work, or provider
errors.

Use **Stop** when you want to stop paying for active compute while keeping the
host configuration. CoCalc may ask whether to back up projects first. During an
active start or restart, **Emergency stop** can appear when the provider
supports stopping the machine and the host is in a stoppable state.

Use **Restart** for runtime drift, daemon problems, or settings that require a
machine restart. Reboot is graceful when the provider supports it. Some
providers also expose a hard reboot, which is more disruptive and should be a
maintenance-window action.

## Deprovision and delete

Deprovisioning is destructive for provider resources. It removes the cloud
machine and attached provider resources. It does not mean "hide from the UI" or
"pause billing for a minute"; it is a lifecycle boundary. Use it when changing
settings that require a fresh machine, retiring the host, or recovering from
provider drift that cannot be reconciled safely.

Deletion is the final cleanup. It is available after deprovisioning, or before
provisioning created provider resources. Deleted hosts do not expose further
destructive actions.

## Maintenance operations

The host action menu also includes **Backup projects**, **Drain**, and
sometimes **Cancel backups**. Backup projects creates project backups for
provisioned or running projects on the host. Drain is for removing active work
from a host before maintenance. Cancel backups is only offered during the
backup stage of a host operation.

## Agent notes

Before running lifecycle commands, check active host operations, project
backups, assigned projects, billing enforcement, and provider capabilities.
Prefer deprovision over delete when provider resources still exist. Do not
advise deprovisioning a host with important unbacked work.
`;

export const PROJECT_HOST_SPOT_RECOVERY_BODY = String.raw`
## Why spot recovery exists

Spot hosts can be much cheaper than standard on-demand hosts, but the cloud
provider can reclaim them at any time. CoCalc's spot recovery strategy controls
what happens after that interruption: retry spot, optionally fall back to a
standard VM, and later probe whether spot capacity is available again.

Spot recovery is active only when the host uses **spot** pricing and
**Interruption restore** is set to **Restore immediately**. The **Spot Recovery
Strategy** modal shows the recovery states as a diagram, but the diagram is
read-only; the settings below it control behavior.

## Retry spot first

After a spot interruption, CoCalc first tries to restore the same kind of spot
capacity. The key settings are:

- **Spot retry window (minutes)**: how long CoCalc keeps retrying spot before
  moving on.
- **Retry backoff (seconds)**: the base delay between spot restore attempts.
  The worker adds exponential backoff up to a cap.
- **Max restore attempts before fallback**: a count-based limit. Set it to
  \`0\` to rely only on the retry window.

Use a short window when user-facing uptime matters. Use a longer window when
cost matters more than immediate recovery.

## Standard fallback

When **Allow standard fallback** is enabled, CoCalc can temporarily switch the
host to a standard on-demand VM if spot recovery fails. The host remains
configured as a spot host, but it is running as a standard fallback. The UI
shows this as **standard fallback** and explains the current standard rate and
the spot rate when restored.

The fallback settings are:

- **Minimum standard runtime (minutes)**: how long the standard fallback should
  run before CoCalc starts trying to return to spot.
- **Spot probe interval (minutes)**: how often to check the same zone and
  machine type for spot availability.
- **Require successful probe before returning to spot**: when enabled, CoCalc
  only switches back after a matching probe VM starts successfully.

## Returning to spot

While a host is on standard fallback, CoCalc probes for spot availability.
After a successful probe and the minimum runtime window, it can move back to
spot. Returning to spot is itself disruptive because the underlying VM changes,
so schedule sensitive workloads accordingly.

## Agent notes

When explaining spot recovery, distinguish three states: desired pricing
(spot), effective pricing (possibly standard fallback), and recovery phase.
Use spot for cost-sensitive workloads that tolerate interruption. Use standard
hosts for workloads that must not be interrupted by cloud spot reclamation.
`;

export const PROJECT_HOST_CHANGE_RULES_BODY = String.raw`
## The rule of thumb

Some host settings are policy and can change immediately. Other settings change
the underlying provider machine and need a restart or full deprovision. Treat
host edits as infrastructure changes, not normal project settings.

## Changes that can happen while running

**Disk enlarge** can be done any time without reboot for GCP and Nebius hosts.
This is an online capacity increase. It should still be treated carefully:
watch the storage tab and keep backups current, but users do not need to stop
the host just to grow disk.

Access policy, per-project RAM cap, shared-pool tier, and many metadata or
billing policy settings are also host record changes. They do not by
themselves recreate the provider machine.

## Changes that require restart

Switching **spot** and **standard** pricing can be requested any time, but the
effective machine changes only after restart. Instance type changes are the
same: they can be edited while the host exists, but they require restart before
the running machine matches the new shape.

Use the UI's restart/reprovision warnings as the source of truth for whether a
host is currently running old infrastructure.

## Changes that require deprovision

Moving a host between region or zone requires deprovision. Region and zone are
provider placement decisions; CoCalc cannot mutate a running VM into another
region. Back up projects, drain or move workloads, deprovision, then provision
again in the new location.

## Practical checklist

1. Check whether projects are running on the host.
2. Check whether the change is disk, pricing, instance shape, region, or zone.
3. Back up projects before restart or deprovision work.
4. Warn users about interruption when the change requires restart.
5. Warn users about provider-resource deletion when the change requires
   deprovision.

## Agent notes

For GCP and Nebius, disk enlarge is online. For spot/standard and instance type
changes, expect restart. For region/zone moves, expect deprovision. Do not
promise a no-downtime machine shape or location change unless provider-specific
code explicitly supports it.
`;

export const PROJECT_HOST_RELIABILITY_BODY = String.raw`
## What the reliability view measures

The host **Reliability** tab summarizes recent host availability. It is not a
generic cloud SLA and it is not a project success metric. It answers: when this
host was intended to be online, how often was it actually reporting online?

The modal and tab show:

- current state, such as online, planned downtime, or recovering
- current uptime
- window availability over the selected lookback period
- reliability over intended-online periods
- unplanned outage count
- unplanned exposure time
- planned downtime, when present

## Reliability versus availability

**Reliability** measures uptime only during periods when the host was intended
to be online. Planned downtime is excluded from the reliability denominator.

**Availability** is wall-clock uptime over the whole window. A host that was
intentionally stopped for most of the month can have low availability but good
reliability.

## Reading the day grid

The small day squares summarize the recent window. Green days were reporting
online. Yellow or red indicates unplanned exposure. Gray indicates planned
downtime. Hovering a day shows the day's details.

If the host is currently unavailable, the top alert distinguishes planned
unavailability from unplanned or recovering state.

## Admin annotations

Admins can annotate recent non-online events. Use this to distinguish planned
maintenance, provider incidents, testing, billing holds, or known user-driven
stops. Public notes should be written carefully because they can be shown to
users.

## Agent notes

Use reliability when deciding whether a host is suitable for long-running
workloads. If a user reports intermittent failures, compare reliability,
current state, host logs, active operations, spot recovery state, and project
events before blaming a notebook or terminal.
`;

export const PROJECT_HOST_SOFTWARE_LIFECYCLE_BODY = String.raw`
## What the runtime tab is for

The host **Runtime** tab explains what software the host wants to run, what is
actually installed, and what managed daemons are currently doing. It combines
cluster defaults, host-specific overrides, host telemetry, reconcile state, and
daemon rollout state.

There are two related surfaces:

- **Runtime software**: versions for project-host, project bundle, and tools.
- **Managed daemon components**: local daemons such as project-host services
  that can be restarted, reconciled, rolled forward, or rolled back.

## Bootstrap and software lifecycle

Bootstrap prepares the host. Software lifecycle then keeps the host aligned
with desired state. The lifecycle reports summary status, drift count, last
reconcile result, active reconcile work, and errors.

Drift means the host's observed state does not match desired state. It may be
normal during an upgrade or after changing versions, but persistent drift means
the host needs reconcile or investigation.

## Reconcile and upgrade

**Reconcile** asks the host to repair or align installed software and daemon
state with the desired configuration. It is the first action to try when the
host reports drift but the desired versions are already correct.

**Upgrade** changes desired versions and then queues lifecycle work. Newly
started projects use the upgraded project bundle and tools. Project-host daemon
upgrades may briefly reconnect browser and proxy traffic, so they should be
scheduled with care.

## Daemon lifecycle

Managed daemons have desired versions, installed versions, running versions,
health, rollout phase, and sometimes rollback hints. A daemon can be pinned by
a host-specific override or inherit the cluster default.

If a daemon is disruptive, prefer maintenance windows. If a desired version is
not installed yet, setting it queues reconcile work. Refresh the runtime tab to
watch rollout, health, rollback, and repair state.

## Agent notes

For deep inspection, use host runtime and deployment commands in addition to
the browser tab. Look for version drift, failed reconcile, daemon health,
rollout phase, and host-specific overrides. Do not treat project bundle,
project-host daemon, and tools as the same artifact; they affect different
parts of the runtime stack.
`;

export const PROJECT_HOST_STORAGE_BODY = String.raw`
## What the storage tab is for

The host **Storage** tab is where you inspect provider disk capacity, storage
mode, usage, reservations, and host-level storage actions. It is the right
place to check before growing a disk, moving projects onto a host, draining a
host, or changing infrastructure that could affect local project data.

Project host storage is not the same thing as a project backup. The host disk
is where running project files live. Project backups are the portable recovery
copy that CoCalc can use when moving or restoring projects.

## Persistent and ephemeral storage

Persistent storage is designed to survive ordinary host restarts and provider
machine replacement according to the provider's disk model. Ephemeral or local
storage is faster or cheaper for some workloads, but it should be treated as
recoverable only through project backups and explicit project data copies.

Before placing important projects on a host, check whether the host uses
persistent storage, ephemeral storage, or provider-specific attached disks. Do
not assume that files outside the project backup path, such as temporary files,
will survive deprovision, move, or provider replacement.

Shared scratch disks are a separate host-scoped storage feature. They are
mounted at \`/scratch\` in projects on the host, shared by those projects, and
not included in project backups or project moves. Use the **Shared scratch
disks** docs before enabling scratch for a host with multiple users or projects.

## Growing disk

For GCP and Nebius hosts, disk enlarge can be done while the host is running
and does not require a reboot. Growing disk is one-way: plan for future use,
but do not treat it as a reversible experiment.

After growing disk, verify the Storage tab and the host status. If usage remains
high, check whether projects are producing temporary files, caches, datasets,
or build artifacts that should be moved or deleted instead of simply growing
the disk again.

## Backups and snapshots

Use project backups for portable project recovery, cross-host moves, and
protection before lifecycle actions. Use provider snapshots or host-local
snapshots only when the UI or provider explicitly exposes that workflow for the
host; they are infrastructure recovery tools, not a substitute for project
backups.

Before deprovisioning, deleting, moving, or changing storage mode, make sure
important projects have current backups. If a project has changed region, verify
that a backup exists in the destination backup region after the move completes.

## Agent notes

When diagnosing storage or advising a lifecycle action:

1. Open the host **Storage** tab for the selected host.
2. Check storage mode, provider, disk size, current usage, and whether online
   grow is supported.
3. Distinguish host disk state from project backup state.
4. Before deprovision, delete, region move, or storage-mode change, verify
   project backup freshness and assigned projects.
5. Warn explicitly that \`/tmp\`, caches, host-local snapshots, and files
   outside the project backup model may not follow a project move.
`;

export const PROJECT_HOST_SHARED_SCRATCH_BODY = String.raw`
## What shared scratch is

A shared scratch disk is host-scoped working storage mounted at \`/scratch\`
inside projects on a project host. It is useful for large shared datasets,
model checkpoints, build caches, generated artifacts, and temporary working
files that should not live in normal project quota.

The word **shared** is the important part: every project on that host sees the
same \`/scratch\` filesystem. Do not put secrets, private student work, or
user-specific data there unless every project and user on the host should be
able to read and write it.

## What it is not

Shared scratch is not project storage. It does not count toward project quota,
does not move with a project, and is not copied by project backup, project copy,
or project move. If a project moves to another host, the files in \`/scratch\`
stay with the original host.

Shared scratch is also not a CoCalc backup. It uses provider network block
storage rather than local SSD, and the provider disk type may have its own
durability properties, but CoCalc does not back up scratch contents.

## Lifecycle rules

Scratch persists across normal host stop/start, reboot, ordinary host edit or
recreate, spot-to-standard fallback, standard-to-spot changes, and instance type
changes. It is deleted when the host is explicitly deleted or when the scratch
disk itself is deleted.

Adding scratch or deleting scratch can be requested while the host is running.
Projects may need to be restarted before they see a newly added \`/scratch\`
mount. Deletion can fail if running projects are still using the filesystem,
because the host must unmount it before destroying the disk.

## Growing and changing scratch

For GCP hosts, scratch disk growth is online. It does not require a host reboot,
and projects can keep running while the disk and filesystem are enlarged.

GCP scratch disks can also be configured for automatic grow. When automatic
grow is enabled, CoCalc watches host-level \`/scratch\` usage, grows by the
configured increment when free space crosses the threshold, caps growth at the
configured maximum, and still runs billing/admission checks before increasing
pay-as-you-go storage.

For Nebius hosts, creating the initial scratch disk can be done without a host
reboot. Growing an existing Nebius scratch disk later requires a host reboot
before the larger filesystem is available.

Scratch growth is one-way: you can grow the disk, but you cannot shrink it in
place. To shrink or change disk type, delete the scratch disk and recreate it at
the desired size and type, which destroys all scratch data.

Nebius scratch disks are sized in 93 GB increments. If you request a smaller or
non-aligned size, the UI rounds up to the provider-supported size.

## Billing and planning

Scratch is host pay-as-you-go storage. It can continue to cost money while the
host is stopped, because the provider disk still exists. Use it deliberately
for data that benefits from being shared on one host, and clean it up when the
workload is finished.

For course or workshop hosts, explain the sharing model to users before
enabling scratch. A public or shared-pool host with scratch can make the same
filesystem visible to unrelated projects if placement is broad enough.

## Agent notes

When helping with shared scratch:

1. Ask for or select the project host id; scratch is attached to a host, not to
   a project.
2. Open the selected host's Storage tab with the \`hosts.scratch.open\` docs
   action.
3. Confirm the host-owning bay before making control-plane changes.
4. Warn that \`/scratch\` does not follow project backup, copy, restore, or
   host-to-host move workflows.
5. Treat scratch deletion as destructive for every project using that host.
6. If the user is moving a project to another host, ask whether any needed data
   is only in \`/scratch\` and should be copied into project files or another
   durable location first.
`;

export const PROJECT_HOST_LOGS_BODY = String.raw`
## What host logs are for

The host **Logs** tab shows operational history for the project host itself:
provisioning, bootstrap, lifecycle actions, software reconcile, daemon state,
provider errors, and recent host-controller activity. Use it when the host is
not starting, projects cannot be placed, software is drifting, or a lifecycle
action looks stuck.

Host logs are different from project logs. A notebook kernel crash, terminal
process failure, or web app error may be a project problem. A failed provision,
daemon rollout, provider API error, or unavailable host service is a host
problem.

## First things to check

Start with the drawer overview and the relevant tab:

1. **Details** for current state and active operations.
2. **Reliability** for recent online/offline history.
3. **Runtime** for software lifecycle, drift, and daemon health.
4. **Logs** for the event stream behind those summaries.

For CLI inspection, use a small recent tail first:

~~~sh
cocalc host logs <host-id> --tail 200
~~~

If the recent tail is not enough, narrow by the time of the failed action
instead of dumping unrelated history.

## Reading log patterns

Provider errors usually point to credentials, quotas, unavailable machine
types, pricing mode, spot interruptions, region or zone capacity, or network
setup. Bootstrap errors usually point to package installation, image setup,
SSH/connector availability, or first-start configuration. Runtime errors point
to daemon health, version drift, reconcile failures, or project-host service
rollout.

When a host is recovering from spot interruption or fallback, logs are most
useful when read together with the spot recovery state and current effective
pricing.

## Sharing logs safely

Logs may include host ids, project ids, paths, provider names, and operational
context. Avoid pasting large raw logs into public channels. Prefer a short
tail around the failure time, plus the host id, action attempted, current
state, and any active operation id.

## Agent notes

When helping with host debugging:

1. Ask for or select the host id.
2. Open **Logs**, **Runtime**, and **Reliability** rather than using logs alone.
3. Capture the action attempted, approximate time, current host state, active
   operation, and whether the host is spot or standard.
4. Use \`cocalc host logs <host-id> --tail 200\` for a focused first pass.
5. Route host inspection to the host-owning bay; do not assume the browser's
   current project bay owns the host.
`;
