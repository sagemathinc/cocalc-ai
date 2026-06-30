# Project Host Podman Resource Hardening Plan

Status: Phase 0, Phase 1, Phase 2 metrics, and gated Phase 3 direct-offender
enforcement landed. Quarantine and account aggregate enforcement remain.

Date: 2026-06-29

## Goal

No one project or account should be able to indefinitely degrade or bring down a
project host through resource-isolation attacks or mistakes. A malicious or
broken workload should be stopped quickly, cooled down, and quarantined after
repeated violations.

This plan focuses on project containers run by project-host through rootless
Podman. It does not attempt to solve heavyweight tenant isolation with separate
VMs or per-project host users.

## Density Constraint

Project hosts must be designed for very high project density:

- normal high-density target: up to `500` active projects on one host.
- observed density: `150` running projects on one host with low CPU use.
- stress-test density: up to `2000` active projects on larger hosts.

This materially constrains the sampler design:

- no normal-mode scan may walk every project, every process, and every file
  descriptor every `15s`.
- host-pressure must consume the latest available resource snapshot instead of
  synchronously scanning `/proc` during stop-candidate selection.
- sampler output must explicitly report stale or partial data so operators do
  not confuse rolling estimates with an exact instant-wide measurement.
- clear direct offenders should trigger pressure as soon as they are sampled;
  generic host pressure should use rolling aggregate snapshots.
- emergency mode may temporarily spend more scan budget, but even emergency
  scans must be bounded and interruptible.

## Current State

Project containers currently get:

- cgroup CPU controls through `--cpus` or fair CPU shares.
- cgroup memory controls through `--memory`, `--memory-reservation`,
  `memory.high`, and optional swap.
- cgroup process controls through `--pids-limit`, defaulting to `4096`.
- disk and scratch quotas before container startup.
- `/tmp` as either project scratch or a bounded tmpfs.

Project-host already has several resource-control paths that this plan should
reuse instead of duplicating:

- `src/packages/project-host/host-pressure.ts` samples host memory pressure,
  ranks stop candidates using stop policy, priority, recent activity, startup
  protection, and admin `protect`/`deprioritize` overrides, then stops projects.
- `src/packages/project-host/sqlite/stop-policy.ts` stores the host-local stop
  policy and pressure-stop state used by that ranking.
- `src/packages/project-host/cpu-usage.ts` samples managed CPU usage and lets
  hub policy request a project stop for CPU/abuse cases.
- project-host heartbeats already publish current host metrics and pressure
  state to the registry for operator visibility and placement decisions.

Target shared host-side kernel limits are:

- `fs.inotify.max_user_instances = 8192`
- `fs.inotify.max_user_watches = 2097152`
- `fs.inotify.max_queued_events = 65536`
- `kernel.keys.maxkeys = 20000`
- `kernel.keys.maxbytes = 25000000`

However, a read-only production check on `us-south-1` on 2026-06-29 showed the
target is not reliably applied everywhere:

- active project containers: `64`.
- host load: about `1`.
- host memory: `62 GiB` total, `41 GiB` available.
- sysctls:
  - `fs.inotify.max_user_instances = 128`.
  - `fs.inotify.max_user_watches = 507604`.
  - `fs.inotify.max_queued_events = 16384`.
  - `kernel.keys.maxkeys = 20000`.
  - `kernel.keys.maxbytes = 25000000`.
- no matching persisted `/etc/sysctl.d` inotify/key config was found.
- `systemd-sysctl` was failed on that boot, with no retained journal details.
- representative project containers already had:
  - `PidsLimit = 4096`.
  - `ShmSize = 65536000`.
  - `RLIMIT_NOFILE = 1048576`.
  - `RLIMIT_NPROC = 256923`.
- a bounded full scan of the 64 project containers took `359ms` and found:
  - `262` project pids.
  - `2993` threads.
  - `7284` file descriptors.
  - `2106` socket descriptors.
  - `5` inotify instances.
  - `18` inotify watches.

This means the first implementation step is not the sampler. It is making
project-host bootstrap set, persist, and report the intended host sysctls, then
making drift visible in host metrics.

The major gaps are:

- target inotify sysctls are not reliably applied or persisted on production
  project hosts.
- no explicit Podman `--ulimit nofile=...` for project containers.
- no per-project or per-account accounting for inotify instances and watches.
- no enforcement action when a project consumes a large fraction of shared
  per-UID host resources.
- no quarantine path tied to repeated project-host resource violations.
- no restart admission block for repeated resource-limit violations beyond the
  existing short host-pressure cooldown.
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

- `--ulimit=nofile=8192:8192`
- `--ulimit=core=0:0`
- `--pids-limit=4096`, already present
- `--shm-size=64m`, unless a project entitlement explicitly raises it later

Keep these configurable through project-host environment variables, not through
normal user-facing project settings:

- `COCALC_PROJECT_NOFILE_LIMIT`, default `8192`
- `COCALC_PROJECT_CORE_LIMIT`, default `0`
- `COCALC_PROJECT_SHM_SIZE`, default `64m`
- `COCALC_PROJECT_PIDS_LIMIT`, default `4096`

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
resource-pressure sampler below handles aggregate resource abuse that static
limits cannot represent cleanly.

## Resource Pressure Accounting

Add a resource-pressure sampler that feeds the existing host-pressure
controller. It should not be a separate stop scheduler. The sampler's job is to
attribute shared host-kernel resource usage to projects and accounts, then
publish pressure signals such as `inotify_watches`, `inotify_instances`,
`file_descriptors`, `sockets`, and `kernel_keys`.

Tick every `15s` by default, but scan only a bounded shard of projects per
tick:

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
- Maintain a round-robin queue of active projects, with priority boosts for
  projects that recently started, previously violated limits, or have stale
  samples.
- In normal mode, scan at most a small batch per tick, e.g. `10-25` projects or
  until the scan time budget is exhausted.
- Target a full rolling sweep in about `5` minutes for `500` active projects.
  For `2000` active projects, stale data is acceptable in normal mode as long
  as clear direct offenders are caught on their next shard scan.
- For each pid in the selected project shard, scan `/proc/<pid>/fd`.
- Only open `/proc/<pid>/fdinfo/<fd>` when the fd symlink resolves to
  `anon_inode:inotify`.
- Count inotify watches by counting `inotify wd:` lines in fdinfo.
- Bound each scan by elapsed time and max entries so the sampler cannot itself
  become a host load problem.
- Emit metrics and structured logs with scan duration and truncated-scan flags.
- Keep the last sample per project in memory with `sampled_at`, counts, scan
  status, and truncation flags.
- Build host/account aggregate metrics from the rolling sample cache and expose
  how many running projects have fresh, stale, missing, or truncated samples.

Integration points:

- Extend `HostCurrentMetrics` with aggregate resource-pressure counters and
  largest-offender summaries.
- Extend `classifyHostPressure` so memory is one pressure input rather than the
  only pressure input.
- Keep `HostPressureZone` as the common `normal | observe | pressure |
  emergency` state machine.
- Extend `buildStopCandidates` to accept an optional direct-offender map. A
  direct project offender should rank before generic victims, while generic
  host pressure should keep the existing priority/recent-activity ordering.
- Reuse `project_stop_policy` and `project_stop_state` for cooldown/ranking
  state so memory pressure and shared-kernel-resource pressure do not diverge.
- Reuse `reportProjectPressureAction` for durable project log entries, adding
  resource type, measured value, threshold, and sample timestamp.

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

If a host later changes `fs.inotify.*`, the thresholds should adapt.

Snapshot freshness:

- fresh sample target: project sampled within `5` minutes.
- stale warning: project sample older than `10` minutes.
- missing warning: running project has no sample after `10` minutes.
- aggregate metrics should include freshness counts and should not claim to be
  exact when many samples are stale or truncated.
- direct project enforcement should only use a fresh or just-collected project
  sample. Host-level observe/pressure state may use stale aggregate data, but
  emergency stop decisions should prefer freshly sampled direct offenders.

## Enforcement

Enforcement should be staged through the existing host-pressure controller:

1. Metrics-only mode for the first deployment.
2. Pressure-signal mode: publish observe/pressure/emergency states without
   stopping for new resource types.
3. Stop-project mode after metrics look sane on staging.
4. Cooldown and quarantine mode after stop-project behavior is validated.

Stop behavior:

- Prefer stopping a direct offender when the sampler identifies one.
- In the first stop-project rollout, resource-only pressure without a clear
  project-level offender only publishes host pressure state. It does not stop a
  generic lower-priority project based on rolling aggregate resource data.
- Mixed memory pressure and resource pressure still uses the existing
  host-pressure candidate ranking: stop lower-priority, older, less-protected
  projects first.
- Stop the selected project through the same `stopProjectForPressure` path used
  by memory pressure.
- If clean stop times out, force-remove the container using the same fallback
  mechanism used for other project-host stop failures.
- Record a project-host pressure event with resource type, measured value,
  threshold, and sample timestamp.
- Add a user-visible project status note: "Stopped because it exhausted project
  host resource limits."

Cooldown behavior:

- First violation: use the existing host-pressure cooldown, defaulting to 10-15
  minutes depending on final configuration.
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
- inotify instances and watches through resource-pressure measurement and
  host-pressure enforcement.
- sockets through fd scan and `nofile`.
- kernel keys through host pressure metrics and likely seccomp deny.

Do not add `ulimit -u` as a primary control. In this rootless Podman model it is
per host user, which risks turning one project's limit into an accidental shared
limit for every project on the host.

## Low-Load Monitoring Design

The resource sampler must not create meaningful host load, and it must not make
the existing host-pressure loop expensive.

Rules:

- Default tick interval: 15 seconds.
- Normal-mode batch target: `10-25` projects per tick, configurable.
- Normal-mode scan budget: at most `500ms-1000ms` per tick by default.
- Pressure-mode scan budget: at most `2s` per tick by default.
- Skip a project if it was sampled less than 60 seconds ago unless it is being
  rescanned for an active violation or emergency.
- Stop a scan cycle when the time budget is exhausted and mark it truncated.
- Never run more than one scan concurrently.
- Use backoff if the previous scan was slow.
- Record scan duration histogram.
- Cap log volume by logging normal samples at debug level and only warning on
  threshold crossings.
- Keep all `/proc` scanning off the synchronous stop-candidate ranking path.

The scan should be cheap in normal cases because most projects have far fewer
than the `4096` pids limit and only a small number of inotify descriptors. The
host-pressure controller should consume the most recent sampler snapshot instead
of synchronously scanning `/proc` during candidate selection.

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
- `inotify-watches` should trigger host-pressure stop before host-wide
  exhaustion.
- `inotify-instances` should trigger host-pressure stop before host-wide
  exhaustion.
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
- resource sampler scan duration.
- resource sampler scan truncation count.
- stop/cooldown/quarantine counts by reason.
- host keyring pressure.

Expose recent violations in:

- project-host logs.
- admin host page.
- project admin page.
- support diagnostic bundle.

## Rollout Plan

Phase 0:

- Add a project-host bootstrap sysctl step that writes a managed config file,
  e.g. `/etc/sysctl.d/90-cocalc-project-host.conf`.
- Apply and verify:
  - `fs.inotify.max_user_instances = 8192`.
  - `fs.inotify.max_user_watches = 2097152`.
  - `fs.inotify.max_queued_events = 65536`.
  - `kernel.keys.maxkeys = 20000`.
  - `kernel.keys.maxbytes = 25000000`.
- Surface the current sysctl values in host metrics and operator UI.
- Add a host health warning when actual values are below target.
- Add a bootstrap/startup log entry that records the actual values and whether
  persistence succeeded.
- Roll this out before enabling any sampler enforcement; otherwise the sampler
  thresholds are calibrated against limits the host may not actually have.

Phase 1:

- Add `nofile`, `core`, and `shm-size` Podman launch limits.
- Add unit tests for generated Podman args.
- Deploy to staging and verify normal project workflows.

Phase 2:

- Add resource-pressure metrics-only mode feeding host metrics.
- Implement round-robin sharded sampling with freshness/truncation metrics.
- Use and maintain the dangerous project-side stress harness at
  `src/.agents/project-host-resource-stress-test.mjs`.
- Deploy to staging and run the stress harness.
- Tune thresholds against real sample data.

Phase 3:

- Extend host-pressure classification and candidate ranking to consume
  resource-pressure signals.
- Enable stop-project enforcement for clear project-level resource violations
  with `COCALC_PROJECT_HOST_RESOURCE_PRESSURE_MODE=enforce`.
- Use `COCALC_PROJECT_HOST_RESOURCE_PRESSURE_MODE=signal` first when validating
  staging or production host behavior. The default remains `metrics`.
- Add user-visible stopped reason and restart cooldown.
- Validate repeated `inotify-watches` and `inotify-instances` tests.

Phase 4:

- Add durable quarantine state and admin unquarantine UI.
- Add account aggregate enforcement.
- Add keyring seccomp deny if key pressure is observed or if testing confirms it
  is safe for normal workloads.

## Resolved Decisions

- Ship project-only cooldown/quarantine first. It is local, simpler, and likely
  the right response for accidental recursive watchers or broken language
  servers.
- Design for `500` active projects per host, with stress-test awareness up to
  `2000` active projects on larger hosts. This requires sharded sampling and
  forbids full project/fd sweeps on every tick.
- Prefer host-level configuration for higher `nofile` or inotify thresholds.
  Dedicated-host and self-hosted deployments can safely own the blast radius for
  higher limits. Per-project overrides are out of scope for the first pass.
- Prefer implementing the sampler inside the existing project-host daemon path.
  Adding another long-running process increases upgrade, supervision, and
  operational complexity. If profiling shows Node event-loop impact, use a
  bounded worker thread or short-lived helper before introducing a new daemon.

## Open Questions

- Do any supported workloads require kernel keyring syscalls inside project
  containers? Current expectation is no; web development, Jupyter notebooks, and
  LaTeX should not normally need `add_key`, `keyctl`, or `request_key`. Validate
  on staging before enabling a seccomp deny rule.
