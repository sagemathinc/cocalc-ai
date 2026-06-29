# Project Host Podman Resource Hardening Plan

Status: proposed implementation plan

Date: 2026-06-29

## Goal

No one project or account should be able to indefinitely degrade or bring down a
project host through resource-isolation attacks or mistakes. A malicious or
broken workload should be stopped quickly, cooled down, and quarantined after
repeated violations.

This plan focuses on project containers run by project-host through rootless
Podman. It does not attempt to solve heavyweight tenant isolation with separate
VMs or per-project host users.

## Current State

Project containers currently get:

- cgroup CPU controls through `--cpus` or fair CPU shares.
- cgroup memory controls through `--memory`, `--memory-reservation`,
  `memory.high`, and optional swap.
- cgroup process controls through `--pids-limit`, defaulting to `4096`.
- disk and scratch quotas before container startup.
- `/tmp` as either project scratch or a bounded tmpfs.

Project hosts currently raise shared host-side kernel limits:

- `fs.inotify.max_user_instances = 8192`
- `fs.inotify.max_user_watches = 2097152`
- `fs.inotify.max_queued_events = 65536`
- `kernel.keys.maxkeys = 20000`
- `kernel.keys.maxbytes = 25000000`

The major gaps are:

- no explicit Podman `--ulimit nofile=...` for project containers.
- no per-project or per-account accounting for inotify instances and watches.
- no enforcement action when a project consumes a large fraction of shared
  per-UID host resources.
- no cooldown/quarantine path tied to project-host resource violations.
- no regular metrics that show how close a host is to shared kernel limits.

## Threat Model

The realistic attacks and mistakes are:

- A project creates many `fs.watch` or language-server watchers and exhausts
  `fs.inotify.max_user_watches`.
- A project creates many inotify instances and exhausts
  `fs.inotify.max_user_instances`.
- A project opens many file descriptors or sockets.
- A project forks many processes or threads.
- A project consumes memory, `/tmp`, shared scratch, or disk until other work is
  affected.
- A project consumes kernel keyring quota if keyring syscalls are available.
- One account runs several projects that are individually below thresholds but
  collectively harm the host.

`ulimit` helps, but it is not sufficient:

- `nofile` caps file descriptors per process, so it reduces single-process
  inotify instance, socket, and file descriptor abuse.
- `nofile` does not cap inotify watches because one inotify file descriptor can
  hold many watches.
- `nofile` is per process, so many processes can multiply the limit unless
  cgroup `--pids-limit` is also enforced.
- `nproc` is the wrong primitive here because it is per real host user and all
  rootless project containers share the same host user model.

## Static Podman Limits

Add explicit defaults to project container launch:

- `--ulimit=nofile=4096:4096`
- `--ulimit=core=0:0`
- `--pids-limit=4096`, already present
- `--shm-size=64m`, unless a project entitlement explicitly raises it later

Keep these configurable through project-host environment variables, not through
normal user-facing project settings:

- `COCALC_PROJECT_NOFILE_LIMIT`, default `4096`
- `COCALC_PROJECT_CORE_LIMIT`, default `0`
- `COCALC_PROJECT_SHM_SIZE`, default `64m`
- `COCALC_PROJECT_PID_LIMIT`, default `4096`

Implementation points:

- Extend `Configuration` in
  `src/packages/conat/project/runner/types.ts` with `nofile`, `core`, and
  `shmSize` fields.
- Populate defaults in `runnerConfigFromQuota` in
  `src/packages/project-host/hub/projects.ts`.
- Emit Podman args in `podmanLimits` in
  `src/packages/project-runner/run/limits.ts`.
- Add unit tests in `src/packages/project-runner/limits.test.ts`.

These defaults are deliberately conservative but not tiny. They should not break
normal Jupyter, terminal, VS Code language server, or browser preview use. The
watchdog below handles aggregate resource abuse that static limits cannot
represent cleanly.

## Watchdog Accounting

Add a project-host resource watchdog that samples running project containers and
records per-project resource usage.

Sample every `15s` by default:

- running project containers from Podman labels `role=project` and `project_id`.
- container process ids.
- file descriptor count per project.
- socket descriptor count per project.
- inotify instance count per project.
- inotify watch count per project.
- process/thread count per project.
- host-level keyring usage from `/proc/key-users`.

Recommended implementation:

- Prefer direct `/proc` inspection over invoking `podman top` for every
  project.
- Build a pid-to-project map from `/proc/<pid>/cgroup` or Podman inspect output.
- For each pid, scan `/proc/<pid>/fd`.
- Only open `/proc/<pid>/fdinfo/<fd>` when the fd symlink resolves to
  `anon_inode:inotify`.
- Count inotify watches by counting `inotify wd:` lines in fdinfo.
- Bound each scan by elapsed time and max entries so the watchdog cannot itself
  become a host load problem.
- Emit metrics and structured logs with scan duration and truncated-scan flags.

Initial limits with current bootstrap sysctls:

- warn project at `512` inotify instances or `131072` inotify watches.
- stop project at `1024` inotify instances or `262144` inotify watches.
- warn account aggregate at `1024` inotify instances or `262144` inotify
  watches.
- stop newest/largest offending project for an account at `2048` inotify
  instances or `524288` inotify watches.
- host pressure warning at `70%` of either global inotify limit.
- host emergency mode at `85%`: stop the largest clear offender.
- host critical mode at `95%`: stop largest offenders until below `75%`.

These thresholds are intentionally percentages of the current host global limit,
not fixed forever. The implementation should compute:

- project warn threshold: min(configured value, 6.25% of host global)
- project stop threshold: min(configured value, 12.5% of host global)
- account warn threshold: min(configured value, 12.5% of host global)
- account stop threshold: min(configured value, 25% of host global)

If a host later changes `fs.inotify.*`, the watchdog thresholds should adapt.

## Enforcement

Enforcement should be staged:

1. Metrics-only mode for the first deployment.
2. Stop-project mode after metrics look sane on staging.
3. Cooldown and quarantine mode after stop-project behavior is validated.

Stop behavior:

- Stop the offending project cleanly first.
- If clean stop times out, force-remove the container.
- Record a project-host resource violation event with resource type, measured
  value, threshold, and sample timestamp.
- Add a user-visible project status note: "Stopped because it exhausted project
  host resource limits."

Cooldown behavior:

- First violation: block restart for 10 minutes.
- Second violation within 24 hours: block restart for 1 hour.
- Third violation within 24 hours: quarantine the project until admin review.
- Account aggregate violations should quarantine at account resource level only
  after multiple projects from the same account violate limits.

Quarantine behavior:

- Persist host-local quarantine state so project-host restarts do not
  immediately clear it.
- Replicate an authoritative project/account resource-quarantine event to the
  owning bay when possible.
- Show a clear UI message with support instructions.
- Allow admin override/unquarantine with audit log.

Do not immediately quarantine on the first offense. Many real cases will be
misconfigured language servers, recursive file watchers, or accidental scripts.

## Kernel Key Quotas

Key quotas are harder to attribute per project using only cheap `/proc` scans.
Recommended first step:

- Monitor `/proc/key-users` for host-level pressure.
- Emit warnings when the project-host user exceeds 70% of configured
  `kernel.keys.maxkeys` or `kernel.keys.maxbytes`.
- If key pressure is observed in practice, add a seccomp profile that denies
  `add_key`, `keyctl`, and `request_key` inside project containers unless a
  concrete workload requires them.

The seccomp deny approach is cleaner than trying to infer key ownership after
the fact.

## Similar Limits To Include

The first pass should explicitly track and cap:

- pids and threads through `--pids-limit`.
- file descriptors through `--ulimit nofile`.
- core dumps through `--ulimit core=0`.
- shared memory through `--shm-size`.
- memory through existing cgroup controls.
- tmp through existing tmpfs/scratch limits.
- disk through existing btrfs quota enforcement.
- inotify instances and watches through watchdog measurement and enforcement.
- sockets through fd scan and `nofile`.
- kernel keys through host pressure metrics and likely seccomp deny.

Do not add `ulimit -u` as a primary control. In this rootless Podman model it is
per host user, which risks turning one project's limit into an accidental shared
limit for every project on the host.

## Low-Load Monitoring Design

The watchdog must not create meaningful host load.

Rules:

- Default interval: 15 seconds.
- Skip a project if it was sampled less than 10 seconds ago.
- Stop a scan cycle after 2 seconds by default and mark it truncated.
- Never run more than one scan concurrently.
- Use backoff if the previous scan was slow.
- Record scan duration histogram.
- Cap log volume by logging normal samples at debug level and only warning on
  threshold crossings.

The scan should be cheap in normal cases because most projects have far fewer
than the `4096` pids limit and only a small number of inotify descriptors.

## Stress Test Harness

Add and maintain a project-side stress harness:

`src/.agents/project-host-resource-stress-test.mjs`

Run it only inside a disposable test project. It intentionally tries to exhaust
resources. It requires:

```sh
export COCALC_RESOURCE_STRESS_ACK=I_UNDERSTAND_THIS_IS_DANGEROUS
node project-host-resource-stress-test.mjs --mode inotify-watches --target 300000 --duration-sec 600
```

Required modes:

- `fds`: open `/dev/null` until `EMFILE` or target.
- `processes`: spawn sleeping children until cgroup pids limit or target.
- `sockets`: open loopback sockets until `EMFILE` or target.
- `inotify-watches`: create files and watch them with `fs.watch`.
- `inotify-instances`: spawn child processes that each hold an inotify watcher.
- `tmp`: write to `/tmp` until tmpfs/scratch limit.
- `memory`: allocate memory until cgroup memory limit.
- `cpu`: start CPU-burning workers.
- `keyrings`: optionally call `keyctl add` until denied or target.

Expected validation:

- `fds` should hit per-process `nofile` without harming other projects.
- `processes` should hit `--pids-limit`.
- `inotify-watches` should trigger watchdog stop before host-wide exhaustion.
- `inotify-instances` should trigger watchdog stop before host-wide exhaustion.
- repeated violations should produce cooldown, then quarantine.
- normal project start, terminal, Jupyter, and language server workloads should
  stay below warning thresholds.

## Metrics And Operator Visibility

Expose these metrics per host:

- total running project containers.
- total project pids.
- total project file descriptors.
- total project inotify instances.
- total project inotify watches.
- largest project inotify instances and watches.
- largest account aggregate inotify instances and watches.
- watchdog scan duration.
- watchdog scan truncation count.
- stop/cooldown/quarantine counts by reason.
- host keyring pressure.

Expose recent violations in:

- project-host logs.
- admin host page.
- project admin page.
- support diagnostic bundle.

## Rollout Plan

Phase 1:

- Add `nofile`, `core`, and `shm-size` Podman launch limits.
- Add unit tests for generated Podman args.
- Deploy to staging and verify normal project workflows.

Phase 2:

- Add watchdog metrics-only mode.
- Deploy to staging and run the stress harness.
- Tune thresholds against real sample data.

Phase 3:

- Enable stop-project enforcement for clear project-level violations.
- Add user-visible stopped reason and restart cooldown.
- Validate repeated `inotify-watches` and `inotify-instances` tests.

Phase 4:

- Add durable quarantine state and admin unquarantine UI.
- Add account aggregate enforcement.
- Add keyring seccomp deny if key pressure is observed or if testing confirms it
  is safe for normal workloads.

## Open Questions

- Should cooldown/quarantine be project-only first, or should account aggregate
  quarantine ship at the same time?
- What is the expected maximum active project count per host for sizing host
  global inotify limits?
- Do any supported workloads require kernel keyring syscalls inside project
  containers?
- Should advanced projects be allowed higher `nofile` or inotify thresholds as
  an admin-only override?
- Should the watchdog be part of the existing project-host daemon or a separate
  process supervised by the host bootstrap watchdog?
