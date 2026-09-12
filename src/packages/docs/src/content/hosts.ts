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
hosts are only appropriate in self-hosted Star, Launchpad, or Rocket
deployments. CoCalc Star includes one local project host by default; Launchpad
and Rocket expose the broader operator workflows for managing hosts.

Use project hosts for heavier workloads such as long-running research
computations, courses, or agent sandboxes.

For a comparison with managed VMs and remote notebook kernels, see
[Choose compute for research](/docs/hosts/choose-compute).

The host is not just a label. It controls where the project filesystem lives,
where project processes run, where host-local snapshots are stored, what runtime
software is installed, which backup region is used, and which users are allowed
to place projects there.

## Create or choose a host

1. Open the project host administration area.
2. Configure a cloud provider. In CoCalc Star this is normally already the
   bundled local host; in self-hosted Launchpad or Rocket, configure a cloud
   provider or self-hosted connector.
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

The host **Project resource policy** has an optional per-project RAM cap.
With the cap blank, a private host uses a default derived from its reported
RAM when available, with room left for host services. A public shared-pool host
keeps the project's normal RAM entitlement.

See [Manage project host access and RAM](/docs/hosts/access-and-ram) for the
defaults and how to plan for several projects running together.

## CPU sharing

Projects can use otherwise-idle CPU capacity within the host's project pool,
subject to the pool's CPU limit. That limit can leave capacity for host services.
When several projects need CPU at the same time, their shared-compute
priorities determine their relative shares. Higher priority helps under
contention; it does not reserve particular cores.

To use several cores at once, your program must run work in parallel. The
number of cores visible to a program does not guarantee that all of them will
be available to that program throughout a computation.

## GPU access

On an NVIDIA GPU host, GPU-enabled projects receive access to all of the
host's GPUs. Projects on the same host can use the same devices, so coordinate
concurrent jobs with other host users and check available GPU memory before
starting a large workload.

GPU memory is separate from the project RAM cap. Increasing that cap does not
increase the memory on a GPU.

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

1. Determine whether the user is on hosted CoCalc, Star, Launchpad, Rocket, or
   Lite. Lite does not use project hosts. Hosted CoCalc does not allow
   arbitrary local user machines as hosts. Star normally has exactly one bundled
   local project host.
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

Project hosts make CoCalc more than a shared web editor. They let the project
own real compute, run persistent services, use cloud machines economically, and
give agents a stable Linux environment to work in.
`;

export const PROJECT_HOST_EXAMS_BODY = String.raw`
## A computational scratchpad for exams

Exam Mode adds a temporary browser-based computational scratchpad service to a
private project host. Each browser session receives a clean anonymous CoCalc
project with the exact RootFS and CPU, memory, and disk limits selected by the
instructor. Standard/on-demand capacity is strongly recommended for live exams;
Spot capacity is allowed for testing and non-critical scratchpads.

This is useful when an in-person exam permits computation but requires a clean,
predictable environment. Students can use Jupyter notebooks, files, installed
mathematical software, and optionally terminals without signing into a normal
CoCalc account or reaching the public Internet. They copy their answers to
paper or to the institution's separate assessment system.

Exam mode deliberately does **not** deliver questions, identify candidates,
collect submissions, grade work, or provide proctoring. It complements a
lockdown browser or assessment platform; it does not replace one.

## What one exam run guarantees

When the instructor prepares a run, CoCalc freezes its configuration:

- one stable student hostname suitable for a lockdown-browser allowlist
- one exact RootFS image and digest for every project
- fixed per-project CPU, memory, and disk quotas
- a maximum number of simultaneous projects
- outbound project networking disabled and checked during readiness
- terminal access either allowed or disabled for the entire run
- backups and snapshots disabled for temporary projects
- a project-deletion deadline for scheduled runs, or manual cleanup for practice
  runs
- optional project-host shutdown after scheduled cleanup, enabled by default

The central CoCalc service remains the instructor control plane. Student files,
Jupyter kernels, browser traffic, and other project traffic go directly to the
exam host through the single student origin.

## Before the first rehearsal

1. Create a private managed GCP project host. Use **Standard/on-demand** pricing
   for a live exam. Spot is allowed for rehearsals and non-critical scratchpads,
   but the cloud provider can interrupt or restart it at any time.
2. Size the host for the expected number of simultaneous candidates. Because
   the host runs for a short window, deliberately overprovisioning it is often
   the simplest way to obtain predictable performance.
3. Start the host well before the exam and select the exact RootFS that
   candidates will use. Preparation downloads it to the host when needed and
   pins its immutable digest for the run.
4. Ensure the project-host owner has enough account credit for the complete
   exam window. Existing billing and spending enforcement still apply.
5. Confirm that the instructor's account has the exam-mode entitlement.

Create and rehearse the host well in advance. For each exam, start that same
trusted host 30 to 60 minutes before candidates arrive.

### Host sizing guidance

Use the configured **Maximum projects** as the maximum number of simultaneous
students: each admitted browser session receives one project. As a conservative
starting point, choose a host with:

- at least 8 vCPU
- RAM in GB greater than \`3 + number of students / 2\`

For example, 20 students calls for at least 8 vCPU and 14 GB RAM, while 200
students calls for at least 8 vCPU and 104 GB RAM. The Exams panel performs this
calculation from **Maximum projects** and compares it with the actual host; the
result is advisory and never blocks setup or admission.

This formula deliberately leaves substantial headroom. Exam projects are often
much lighter than their configured per-project memory ceiling, so do not
estimate host capacity by multiplying that ceiling by the student count. A
smaller host may work well for a known workload, but rehearse the exact RootFS,
notebooks, and expected concurrency before relying on it. Short exam windows
usually make deliberate overprovisioning the safest choice.

## Step 1: configure the host

1. Open **Project Hosts**, select the private host, and open its **Exams** tab.
2. Turn on **Enable exam mode**.
3. Keep the generated stable admission token, or choose your own. The resulting
   admission link can be published before the exam and changes only when an
   instructor explicitly replaces the token.
4. Set **Maximum projects** to the largest number of browser sessions that may
   be admitted. This is also the student count used by the host-sizing guidance.
   Leave headroom for instructor testing and accidental extra sessions.
5. Set CPU, memory, and disk limits for each project.
6. Set **Maximum run** to the longest permitted scheduled project lifetime.
7. Set **Cleanup grace**. This is the spending-safety interval before forced
   VM poweroff if cleanup cannot complete; it is not additional candidate time.
8. Decide whether to allow terminals. They are disabled by default. This choice
   is frozen when a run is prepared.
9. Save the configuration and complete the fresh-authentication prompt.

Outbound networking is fixed to **disabled** in the current version.

### CLI and agent automation

Every instructor control in the Exams panel is also available through
\`cocalc host exam\`. This is useful for repeatable rehearsals, institutional
runbooks, and asking a CoCalc agent to prepare or inspect an exam. Use
\`cocalc host rootfs <host>\` to list the images already cached on a host.

~~~bash
# Inspect the current configuration, run, readiness checks, and student URL.
cocalc host exam status <host>

# Enable exam mode and configure per-project limits.
cocalc host exam configure <host> --enable --max-projects 100 \
  --project-cpu 1 --project-memory-mb 2000 --project-disk-mb 5000 \
  --maximum-run-minutes 360 --cleanup-grace-minutes 10 --deny-terminal

# Prepare the run and wait for its smoke test to finish.
cocalc host exam prepare <host> --rootfs <image> \
  --delete-at "FUTURE_UTC_TIMESTAMP" --stop-host

# Rotate a lost token before opening admission, then admit students.
cocalc host exam rotate-token <host>
cocalc host exam open <host>
cocalc host exam status <host> --wait

# Change cleanup policy, or end early and permanently erase all exam projects.
cocalc host exam deadline <host> --delete-at "UPDATED_FUTURE_UTC_TIMESTAMP" --stop-host
cocalc host exam deadline <host> --manual-cleanup
cocalc host exam capacity <host> --max-projects 110
cocalc host exam end <host> --stop-host --yes
~~~

Replace the timestamp placeholders before running the prepare or deadline
commands. Use an ISO 8601 UTC timestamp in the form \`YYYY-MM-DDTHH:MM:SSZ\`
that is at least one minute in the future and within the configured **Maximum
run** interval. The configure example keeps the existing admission token or
generates one when needed.

Configuration, preparation, and token rotation return the stable plaintext
admission token and a copyable admission URL. The authenticated status command
also shows them before, during, and after a run. The URL stores the token in its
fragment, so browsers do not send it to Cloudflare or server access logs. Host
restarts and new exam runs preserve the link; only an explicit token change or
rotation replaces it.
Mutation commands require fresh authentication; run
\`cocalc auth bootstrap\` first when the current CLI session is not elevated.
Pass \`--keep-host-running\` instead of \`--stop-host\` when cleanup should leave
the reusable project host online. Destructive early cleanup always requires
\`--yes\`.

## Step 2: prepare and test a run

1. Start the host and wait until it reports **running** and online.
2. In the **Exams** tab, select a RootFS from the managed catalog.
3. For a timed exam, choose **Delete all exam projects at**. For an open-ended
   practice period, select **Practice mode: erase projects manually** instead.
4. Leave **Also shut down the project host to save resources** selected unless
   the host should remain running for unrelated work after exam cleanup.
5. Select **Prepare and test run** and complete fresh authentication.
6. Wait for the run to reach **ready**. Do not open admission unless every
   readiness check is green.

Preparation downloads the image when it is not already cached, freezes its
digest and the resource policy, creates a real smoke-test project, starts a
Jupyter kernel, checks the disabled-network policy and local cleanup machinery,
and then erases the smoke-test project. A cached image usually takes about one
minute; a first download may take several minutes. A successful preparation
leaves the run **ready** with admission closed; students can enter a token only
after you select **Open admission**.

The panel displays a stable student URL, a copyable admission link, and the raw
shared token as a manual fallback. The admission link prefills the token and
then removes it from the browser address. The token remains visible to the
authenticated instructor even when no run is active. Rotate it explicitly if
it was disclosed; otherwise leave it unchanged so already published links keep
working.

Practice mode has no automatic project-deletion deadline and never shuts down
the host automatically. Admission and student projects remain available until
an instructor selects **End exam and erase now**. Spot capacity can reduce the
cost of a long-running practice session, but it may be interrupted and should
not be used for a high-stakes live exam.

## Step 3: run a candidate rehearsal

1. Select **Open admission** only when new projects should be accepted.
2. Open the admission link in an incognito window or, preferably, a separate
   browser profile.
3. Select **Open scratchpad**. The link prefills the token; the raw token can
   still be entered manually. The browser should open directly into a new
   anonymous project without a normal CoCalc sign-in.
4. Create a Jupyter notebook and evaluate a simple expression such as
   \`2 + 2\`.
5. Save and refresh the page. It should reconnect to the same project.
6. Confirm that terminal controls match the run setting.
7. Confirm that outbound networking fails from a notebook, for example:

~~~python
import urllib.request
urllib.request.urlopen("https://example.com", timeout=5)
~~~

8. Return to the instructor panel, select **Refresh status**, and confirm that
   the active project count increased.
9. To test project isolation, repeat the token flow in a genuinely separate
   browser profile. Separate tabs or incognito windows in the same browser
   session may share the same cookie and therefore the same project.

For the institutional rehearsal, use the exact operating system, lockdown
browser configuration, RootFS, and expected concurrent load planned for the
real exam.

## Step 4: monitor and adjust cleanup

While admission is open, the panel shows public-route health, the frozen RootFS,
active project count, capacity, terminal policy, network policy, the time when
all exam projects will be deleted, and whether the project host will then shut
down. Refresh the panel during a rehearsal to confirm that candidate sessions
appear.

The instructor may move the cleanup time or change the subsequent host-shutdown
choice while the run is ready or open. Updating either requires fresh
authentication. Treat the displayed project-deletion time as authoritative;
cleanup grace is not working time.

The instructor may also increase **Maximum students for this run** immediately
while the run is ready or open. One student uses one temporary project. This is
useful when attendance exceeds the original estimate: increasing 10 to 11 makes
the additional place available without rebuilding the RootFS or interrupting
existing students. Capacity cannot be reduced during a run, and the saved
default for future runs does not change. The panel recalculates its host-sizing
advice before the increase is submitted.

## Step 5: end the run safely

A scheduled run ends automatically. At the configured time, admission closes
and all temporary projects are erased. If **Also shut down the project host to
save resources** is selected, the VM then powers off; otherwise the reusable host
keeps running. A durable central reconciler and a persisted host-local watchdog
both enforce cleanup across service and VM restarts.

For an early end, select **End exam and erase now** and confirm the destructive
action. The same checkbox determines whether the host also shuts down. Do not
manually stop the VM first: exam cleanup must erase candidate projects before
any host shutdown.

After cleanup:

- candidate projects and their TimeTravel history are gone
- anonymous local session records are gone
- the VM is off and compute billing stops when automatic host shutdown was
  selected; otherwise the host remains available for its normal projects
- the reusable project-host record, disk, hostname, and cached RootFS remain

The instructor can later start the same trusted host and prepare a new run.

## Data retention and recovery

Exam projects are local-only projects. They are not normal global CoCalc
projects, and Rustic backups and project snapshots are disabled. TimeTravel
works while a project exists because it is stored with the project files;
it is erased with those files when the run ends.

Candidates must copy anything they need to retain into the institution's
assessment system or onto their answer sheet before the deadline. Exam mode is
designed for zero retention, not recovery after cleanup.

## Lockdown-browser configuration

Allowlist the single HTTPS exam hostname shown in the instructor panel,
including secure WebSockets to that same hostname. The student application,
authentication, files, kernels, and project traffic all use this origin.

Lockdown-browser products differ in URL, certificate, popup, clipboard, and
WebSocket rules. CoCalc cannot infer those local policies. Rehearse the exact
institutional configuration before the first live exam, and verify that page
refresh, notebook execution, autosave, and reconnect all work.

## Operational checklist

At least one day before the exam:

- confirm the host size, Standard/on-demand pricing, and account credit
- start the host and confirm bootstrap and public-route health
- select and rehearse the exact RootFS
- test the institution's lockdown browser from the exam room network
- run representative notebook concurrency
- complete a full timed stop-and-erase rehearsal

Thirty to sixty minutes before the exam:

- start the trusted host and wait for it to become healthy
- prepare a new run and require all readiness checks to pass
- securely record the stable shared admission token
- test one candidate project using the actual lockdown browser
- confirm the project-deletion time, host-shutdown choice, and active-project
  capacity
- open admission only when the room is ready

Normal private-host CPU and network-egress billing is charged to the host owner.
There is no special exam billing or automatic overage protection in this
version.
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

The host access page includes **Project resource policy**, where an owner or
manager can set an optional RAM cap for each project running on the host.

- **Private host:** an explicit cap sets the project's RAM limit. With the cap
  blank, the default is based on reported host RAM, with headroom for host
  services. The user's shared-pool membership RAM limit does not constrain
  this host-derived default. If host RAM is unavailable, the existing project
  RAM limit remains in effect.
- **Public shared pool:** leaving the cap blank keeps the project's normal
  RAM entitlement. An explicit cap can lower that limit but cannot raise it
  beyond the project's entitlement.

All projects share the host's physical RAM. Setting a per-project cap does
not reserve that amount for every project. Plan for the number of projects
that will run together, and leave headroom for the project host itself,
filesystem cache, backups, and runtime services.

The cap covers memory used across the project's running processes, including
notebook kernels, terminals, databases, and agents.

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

## Browser disconnects and project runtime

Closing a browser tab disconnects that browser. Projects with a browser-idle
policy can also stop automatically after browser presence has been absent for
the configured time. Check the **Free project runtime** banner inside the
project for its timeout; do not assume every project has the same policy.

Running code in a notebook, terminal, or agent does not itself supply browser
presence. A public share or a collaborator with only viewer access does not
keep this runtime running. After a browser-idle stop, open the project in an
authenticated CoCalc browser with runtime access before retrying automatic
services. If automatic starts are disabled, use the project's **Start** button
as directed by the error message.

A browser-idle stop preserves project files. Save results to files instead of
relying on variables or other state held only by a running process. A stopped
project, a stopped host, and a browser disconnect are different conditions;
check project and host status before deciding how to recover. Host maintenance,
provider interruptions, and billing enforcement can interrupt availability
independently of the browser-idle policy.

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
- **Max restore attempts before fallback**: a count-based limit. Use a positive
  value. Entering \`0\` currently uses the default count instead of disabling
  the attempt limit.

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

**Disk enlarge** supports online growth for provisioned GCP and Nebius hosts
using persistent storage. Ephemeral storage cannot be resized this way. Keep
backups current and check both provider disk size and usable filesystem capacity
afterward. If the disk grows but filesystem growth reports a warning, follow
the warning's recovery instructions before treating the extra space as usable.

Access policy, per-project RAM cap, shared-pool tier, and many metadata or
billing policy settings are also host record changes. They do not by
themselves recreate the provider machine.

## Changes that interrupt running work

Switching **spot** and **standard** pricing can be requested while a host is
running, but the effective machine changes only after restart.

For managed cloud hosts, stop the host before changing CPU, RAM, machine type,
or GPU selection. Apply the permitted change, then start the host and verify
that it reports the requested configuration. Self-hosted connector changes
follow the connector's own capabilities.

Check the UI's restart/reprovision warnings before applying a change and plan
for interruption of the projects running on that host.

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

For GCP and Nebius persistent storage, check online disk and filesystem growth.
For spot/standard changes, expect restart. Stop a managed cloud host before
editing its machine shape. Region/zone and disk-type/storage-mode changes
require deprovision. Check current backups and interruption effects first.
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

**Availability** divides online time by the selected window after subtracting
periods recorded as **Unobserved**. Planned downtime remains in that denominator.
A host intentionally stopped for most of the month can therefore have low
availability but good reliability. Check the displayed unobserved duration too:
missing observations are not evidence that a host was healthy.

## Reading the day grid

The small day squares summarize the recent window. Green days were reporting
online. Yellow or red indicates unplanned exposure. Gray can indicate planned
downtime or unobserved time. Hovering a day shows the distinction and durations.

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

For provisioned GCP and Nebius hosts using persistent storage, disk enlarge
supports online growth. Ephemeral storage cannot be resized this way. Growing
disk is one-way: plan for future use, but do not treat it as a reversible
experiment.

After growing disk, verify both the provider disk size and usable filesystem
capacity in the Storage tab. If the provider resize succeeds but filesystem
growth reports a warning, follow its recovery instructions and verify the
capacity again. Also check the host status. If usage remains high, check whether
projects are producing temporary files, caches, datasets,
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

CoCalc preserves scratch across normal host stop/start, reboot, and supported
machine replacements such as spot-to-standard fallback. Explicit host
deprovisioning, host deletion, or scratch-disk deletion destroys scratch data.
Before these destructive actions, copy important scratch files to separately
retained storage. Project backups do not include them.

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
reboot. When growing an existing disk, CoCalc attempts to make the larger
filesystem available online. Check the usable capacity after the operation.
If filesystem growth does not complete, follow the warning to retry reconcile
or restart the host if the provider has not exposed the new block size yet.

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

export const PROJECT_HOST_LOGS_BODY = `
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

1. **Overview** for current state and active operations.
2. **Reliability** for recent online/offline history.
3. **Runtime** for software lifecycle, drift, and daemon health.
4. **Logs** for the event stream behind those summaries.

For CLI inspection, use a small recent tail first:

~~~sh
cocalc host logs HOST_ID --tail 200
~~~

If the recent tail is not enough, narrow by the time of the failed action
instead of dumping unrelated history.

## Read resource measurements before changing capacity

Use the selected host's **Overview** tab and **Current metrics** card to check
whether a slow or interrupted job coincides with host pressure. These are
host-wide observations, including other projects and host services; they do not
identify your job's bottleneck on their own.

Check the sample time first. **metrics pending**, **metrics stale**, an absent
field, or an empty history is missing or outdated evidence, not zero usage.
A recent host action can make an earlier sample irrelevant. Compare samples
from the period when the problem happened with the relevant project activity.

### A computation is slow

Inspect host CPU percentage and load averages; the project's process/activity view.

Host CPU is aggregated across cores and projects. Check whether the affected program uses multiple cores and whether other work is competing. One host percentage does not establish that adding cores will speed up this job.

### A notebook kernel is killed or memory grows

Inspect the kernel's memory display, project RAM limit, and host available memory.

The kernel display includes its child processes but excludes unrelated project processes. All of those processes share the project limit. Compare both scopes using [memory troubleshooting](/docs/troubleshooting/memory) and [host RAM policy](/docs/hosts/access-and-ram).

### Writes fail or a project cannot start because of storage

Inspect project disk quota, host disk and filesystem-metadata space, root-disk space, and shared scratch where applicable.

These are separate limits and locations. Match the error to the affected storage before deleting files or changing disk size. See [host storage](/docs/hosts/storage); do not assume host free space means the project has free quota.

### File-heavy work stalls while CPU use is modest

Inspect available I/O containment status, sampled per-project read/write rates, and the workload's own timings.

Check capability and sampling errors first. The top-project list is sampled and can be truncated; it is not a complete per-process profiler. Transfer rates alone do not prove that disk hardware is the bottleneck.

### A GPU allocation fails or GPU work is slow

Inspect device and framework measurements on the machine that actually runs the code.

Current host metrics do not report GPU utilization or GPU memory. Host RAM is not GPU memory; missing GPU measurements do not mean the device is idle or has space.

The notebook usage display does not currently report CPU or memory use for a
[remote Jupyter kernel](/docs/jupyter/remote-kernels). Inspect that remote
machine instead of interpreting the CoCalc host's measurements as remote usage.

## Inspect current and recent metrics from the CLI

Use the [CLI authentication guide](/docs/cli/authentication-and-targets) to
select the correct site and account. Metrics history requires the host owner,
a host manager, or a site administrator. Membership in a project alone does
not grant that host-level access. Replace HOST_ID with an existing host you
are authorized to inspect:

~~~sh
cocalc --json host metrics HOST_ID --window 1h --points 60
~~~

The JSON success response wraps the host identity and metric results in
**data**. Check **data.current.collected_at** and the timestamps in
**data.history.points**. **data.current** can be null, history points can be
empty, and returned points can be compacted to the requested maximum.
Requesting more points does not create measurements that were never collected.
**data.derived** summarizes sampled storage risk and can be null. It is not a
benchmark or a promise about future capacity.

When **data.current.io_containment** is present, check **capability**,
**capability_reason**,
**sampling_error**, **sampled_project_count**, **total_project_count**, and
**truncated** before interpreting **top_projects**. An unsupported collector
or a partial sample is not evidence of no I/O load.

Command syntax was checked with CoCalc CLI 1.0.3 on 2026-09-11. This reference
does not include an observed host measurement or a before/after performance
comparison.

Record the input size, command or notebook, machine, concurrent work, sample
timestamps, elapsed time, and output check for a representative run. Use those
observations to choose one change, then compare the same input and verified
result. Keep raw host output private when it includes identifiers for other
projects. If the data does not identify a constraint, retain that uncertainty
and inspect the application before changing capacity.

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
4. Use \`cocalc host logs HOST_ID --tail 200\` for a focused first pass.
5. Route host inspection to the host-owning bay; do not assume the browser's
   current project bay owns the host.
`;
