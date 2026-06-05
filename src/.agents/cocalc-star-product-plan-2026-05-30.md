# CoCalc Star Product Plan, 2026-05-30

Status: `active implementation plan`

Implementation status as of 2026-06-05:

- Phase 1 is substantially proven on fresh Ubuntu 24.04 x86_64 GCP VMs.
- A tarball installer path exists and has been validated from a clean VM.
- The validated install path is `/opt/cocalc-star/source`, with persistent data
  under `/var/lib/cocalc/star`.
- Local Postgres is the Star control-plane database.
- The local project-host starts projects from a bundled default RootFS with
  Jupyter and LaTeX installed.
- Hard-reset recovery has been validated after fixing project-host tools and
  Conat port collisions.
- Versioned release layout and symlink rollback have been implemented in the
  tarball installer/operator script.
- A real Star VM was upgraded from an older release to a newer release artifact,
  then validated with `doctor`, `smoke`, rollback to the previous release,
  `doctor`, roll-forward to the latest release, and `doctor`.
- Full two-release GCE validation is automated by
  `src/scripts/star/validate-gce-release-upgrade.sh`. The successful run
  validated release A install + smoke, release B upgrade + smoke, rollback to
  release A + smoke, hard-reset boot into release A, and final restore to
  release B + doctor.
- Built-runtime release artifacts now exist via `STAR_RELEASE_MODE=runtime`.
- Runtime artifacts now use ncc/runtime bundles instead of copying the full
  workspace `node_modules` tree. The first validated ncc runtime artifacts were
  about 234 MiB compressed each and skip the target-VM source build by setting
  `STAR_BUILD=0`.
- The same GCE two-release validator has passed against ncc runtime artifacts:
  runtime A install + smoke, runtime B upgrade + smoke, rollback to A + smoke,
  hard-reset boot validation, and final restore to B + doctor.
- The ncc runtime artifact includes bundled Launchpad/control-plane,
  project-host, project, tools, CLI, Star seed/rootfs-cache helpers, and a
  bundled api/v2 route manifest. This keeps the release small while preserving
  the versioned installer and rollback contract.
- The first real upgrade attempt exposed two important release-path bugs:
  root-run upgrades must preserve the existing Star runtime user instead of
  switching to `root`, and failed installs must restore mutable Star service
  config as well as release symlinks. Both are fixed in the current installer.
- Hard-reset validation exposed a normal boot readiness race: SSH and systemd
  can be available before local Postgres, the customize endpoint, and Conat
  health checks are ready. The GCE validator now retries `star.sh doctor` after
  reset and after final release restore.
- Phase 3 setup profile now uses the zero-conf appliance contract: the only
  required setup gates are the first admin account and a working smoke-test
  path. Email, TLS/public URL, backups, license entry, 2FA, resource tuning, and
  custom RootFS images are supported follow-up checks, not first-run blockers.
- The public GitHub-release installer path works on fresh GCP, Lambda Cloud, and
  Hyperstack VMs in the current testing cycle. Install time is typically about
  2-5 minutes after the VM is ready.
- The public install command still needs a stable short URL before public
  release; the long GitHub release URL form is for internal validation.
- GPU passthrough works on tested Lambda Cloud GPU VMs: `nvidia-smi`, PyTorch,
  and TensorFlow all detected the GPU inside projects after Star project-host
  GPU auto-detection was enabled.
- The default RootFS is now an official managed Star RootFS built from the
  selected base image with Jupyter and LaTeX installed. The installer
  caches/publishes it so project backups work without asking the operator to
  publish the launch image first, and project creation should use this managed
  RootFS by default across browser, CLI, API, and course paths.
- Raw installer and `star.sh status` access instructions now print
  copy/pasteable SSH tunnel guidance, the local bootstrap URL, and alternate
  local-port guidance while the bootstrap URL remains valid.
- Caddy/Let's Encrypt over a public VM IP has been validated as the preferred
  zero-config public-VM access path when ports 80/443 are reachable. SSH tunnel
  access remains the private/LAN fallback, not the primary public-VM story.
- The temporary web-onboarding path has been validated on a real public GCP VM:
  Caddy/Let's Encrypt proved public reachability first, the browser page
  continued the install, the admin bootstrap URL worked, and a project could be
  created and used over HTTPS.
- The installer must keep the onboarding output unambiguous: print the
  temporary HTTPS URL once, and immediately explain that failure to open it
  means the VM is not exposing port 443 publicly or DNS/IP routing is wrong.
- Public-VM installs on GCP and Lambda exposed two cloud-realism requirements:
  handle `apt`/`dpkg` locks from unattended upgrades by waiting with clear
  status, and fail early when the project-host data path cannot support btrfs
  subvolumes.
- Lambda Cloud Ubuntu 24.04 GPU validation succeeded, including GPU detection
  inside projects.
- GCP Ubuntu 26.04 on the tested default disk layout failed first project start
  with `Could not create subvolume: Inappropriate ioctl for device`; Ubuntu
  26.04 and non-btrfs data layouts are not in the V1 support envelope until the
  installer either provisions a correct btrfs data path or blocks with precise
  remediation.
- Star now seeds the local project-host as a shared pool host so non-admin users
  can create projects on the appliance.
- Star now publishes and uses an official managed default RootFS image for
  ordinary project creation. CLI/API-created projects must use the same
  official Star RootFS instead of falling back to a generic OCI image and doing
  package bootstrap work at start time.
- A 100-student course workflow was validated on a large Lambda VM: create
  course, add 100 students, provision projects, assign files with copy-on-write,
  and start the projects.
- A 946-running-project stress test on a 224 GiB RAM Lambda VM did not hit the
  obvious hardware limit; it hit the single Star hub/control-plane usability
  limit. The browser became unreliable while the single hub node process and
  bulk start waiters were overloaded.
- The scale test establishes a product requirement: Star V1 needs a
  conservative global running-project cap and bulk-start throttling that
  protects interactive usability. Star should not advertise "RAM times 10"
  running projects until the control plane is scaled or isolated.
- Star now enforces a global running/starting project cap in runtime-slot
  admission. The default is intentionally conservative and can be overridden by
  `COCALC_STAR_MAX_RUNNING_PROJECTS`.
- The Star installer now fails early when the project data path is mounted on a
  filesystem that cannot support btrfs subvolumes, instead of letting the first
  project start fail later.
- Star upgrades now run runtime-state reconciliation to clear stale project
  states, active operations, and runtime slots when containers disappeared
  during upgrade/restart.
- Star seed/bootstrap now creates a normal reusable invite registration token
  and exposes a copy/paste signup URL in the bootstrap result, terminal access
  output, and web onboarding completion page.
- Current implementation is a validated tarball + installer deployment, not a
  final marketplace image or SEA binary. SEA is now optional rather than a hard
  product requirement.

Purpose: define a concrete single-VM CoCalc product that sits between CoCalc
Plus and CoCalc Launchpad, using the existing Launchpad control plane and
project-host runtime without requiring Cloudflare, GCP, Nebius, or any other
cloud-provider integration.

## Product Positioning

`CoCalc Star` is the small-team self-hosted appliance.

Product ladder:

- `CoCalc Plus`: local/personal enhancement and distribution funnel.
- `CoCalc Star`: one dedicated VM, full multi-user collaboration, local project
  execution, no cloud-provider setup.
- `CoCalc Launchpad`: one control plane that creates and manages external
  project-host VMs.
- `CoCalc Rocket`: supported production/multi-bay self-hosted control plane.
- `cocalc.ai`: hosted SaaS.

Star should prevent Launchpad from trying to be both a simple appliance and a
cloud control plane. The products should share architecture and code paths, but
their setup promises are different.

## Product Promise

An operator rents or provides one Ubuntu VM dedicated to CoCalc Star, runs one
installer/binary, creates the first admin account from a registration-token
link, and gets a working multi-user CoCalc site for a small group.

Star intentionally does not support:

- Cloudflare setup.
- GCP/Nebius/AWS/Azure project-host creation.
- multi-bay scaling.
- arbitrary external project-host providers.

Those are upsells to Launchpad/Rocket.

## Current Product Goal: Zero-Config Public VM Appliance

The immediate Star product target is a public-VM appliance proof of concept that
feels genuinely zero-config for a user or agent who can create an Ubuntu VM with
ports 80/443 open.

Target user story:

1. Create a fresh public Ubuntu VM.
2. Paste one install command.
3. The installer asks for the public IP/host to use, or accepts it via an
   option/environment variable for agent-driven installs.
4. The installer sets up Caddy/Let's Encrypt first and prints a temporary
   nonce-protected onboarding URL.
5. The user opens that temporary HTTPS onboarding page to prove public DNS/IP,
   ports 80/443, TLS, and browser access all work.
6. The installer continues the full Star install and streams progress to that
   web page.
7. The final web page and terminal output show the HTTPS bootstrap URL.
8. The user opens the bootstrap URL and creates the first admin account.
9. Creating a project immediately gives working terminal, Jupyter, and LaTeX.
10. Codex works once the user links their Codex/OpenAI subscription.
11. The admin can invite another user through a copy/paste signup URL without
    manually creating and sending a separate registration token.
12. The invited user creates a project and/or collaborates on an existing
    project.

Primary public-VM access path:

- Caddy + Let's Encrypt with a user-provided public DNS name, or an automatic
  `sslip.io`-style hostname for early testing when the VM has a stable public
  IP.
- Human interactive installs should use a temporary web onboarding page as the
  public reachability proof and progress UI.
- The installer should make this path obvious and should output the exact
  working HTTPS bootstrap URL in both the web page and terminal.

Headless/agent public-VM path:

- The same install must support non-interactive operation via env/CLI input.
- Agents should be able to disable the web-confirmation gate with a flag such
  as `STAR_WEB_ONBOARDING=0`, while still configuring Caddy and printing
  machine-readable final URLs.
- In headless mode, public reachability should be checked automatically and
  reported in terminal/status output.

Fallback/private access path:

- SSH tunnel to `127.0.0.1:9100`.
- This remains essential for private VMs, firewalled environments, laptop-local
  VMs, and cases where ports 80/443 are unavailable.

Non-goals for this proof of concept:

- Cloudflare tunnel as the default.
- CoCalc-managed DNS as the default.
- Multi-bay or high availability.
- Marketplace automation beyond what is needed to validate the same install
  story on a marketplace-like VM.

Release-blocking gaps for this story:

- Stable, short public install command that hides release-asset details from
  the user. The long GitHub release URL form is acceptable for internal testing
  but not for first public release.
- Installer option/env var for public URL/IP/hostname, with interactive prompt
  only when not provided.
- Web onboarding mode:
  - install/configure Caddy first,
  - serve a nonce-protected temporary public HTTPS page,
  - require a human to open it before continuing by default,
  - stream install progress and final URLs to that page,
  - expose no secrets or command execution controls through that page.
- Web onboarding terminal output that prints the temporary URL exactly once and
  explicitly says: if this URL cannot be opened, inspect the VM firewall,
  security group, public IP, DNS, and port 443 exposure.
- Web onboarding page that feels like a standard installer:
  - no decorative gradient-heavy marketing page,
  - clear list of what will happen,
  - "Continue install" button,
  - approximate five-minute time estimate,
  - horizontal progress indicator,
  - final admin bootstrap and invite URLs.
- Headless/agent bypass for web onboarding, with deterministic terminal/status
  output.
- First-class Caddy/Let's Encrypt install/config/status path in `install.sh` and
  `star.sh status`.
- Robust package-install behavior:
  - wait for unattended-upgrades/apt locks with useful progress,
  - restore/enable ordinary unattended-upgrades behavior after install,
  - never leave the VM in a surprising package-management state.
- Early filesystem/runtime preflight:
  - Ubuntu 24.04 is the supported V1 target,
  - unsupported Ubuntu 26.04/non-btrfs layouts must fail before the expensive
    install or project-start path,
  - follow-up: optionally provision a dedicated btrfs data volume when the VM
    root filesystem is not already suitable.
- Bootstrap/status output that prints the HTTPS bootstrap URL and clearly
  distinguishes it from SSH-tunnel fallback instructions.
- Codex subscription-link UI should show the linking panel immediately with a
  loading state while waiting for the OpenAI/device code instead of leaving the
  user wondering whether anything is happening.
- Throttled bulk-start queue, so a course or stress-test action cannot make the
  appliance unusable even when the global cap has spare capacity.

## Current Validated Implementation

The current working implementation is deliberately simple:

- Build a Star release artifact from a CoCalc checkout.
- Source artifacts contain `install.sh`, `cocalc-star-src.tar.gz`,
  `release.json`, and `SHA256SUMS`.
- Runtime artifacts contain `install.sh`, `cocalc-star-runtime.tar.gz`,
  `release.json`, and `SHA256SUMS`.
- Runtime artifacts include only the Star installer scripts plus required
  compressed/bundled runtime artifacts: Launchpad/control-plane, project-host,
  project, tools, CLI, Star helper bundles, api/v2 route bundle, frontend
  assets, and bootstrap support files. They reuse the same versioned installer
  but skip the target-VM source build.
- Copy the release artifact to a fresh Ubuntu 24.04 VM.
- Extract it and run `sudo STAR_ASSUME_YES=1 ./install.sh`.
- `install.sh` verifies checksums when possible and delegates to
  `src/scripts/star/install-from-tarball.sh`, so VM mutation still has one
  installer path.
- Install source under `/opt/cocalc-star/releases/<release-id>/source`.
- Keep `/opt/cocalc-star/source` as a stable symlink to the active release.
- Install runtime state under `/var/lib/cocalc/star`.
- Run Launchpad/hub under systemd on `127.0.0.1:9100`.
- Run a local project-host under systemd on `127.0.0.1:9002`.
- Run the project-host managed Conat router on `127.0.0.1:9112`.
- Run the project-host Conat persist health endpoint on `127.0.0.1:9212`.
- Use local Postgres for the hub/control-plane database.
- Build/cache/publish an official managed Star RootFS from the selected base
  image with Jupyter and LaTeX installed.
- Use that official Star RootFS as the server-side default for browser, CLI,
  API, and course-created projects unless the caller explicitly selects another
  RootFS.
- Mount the backend tools bundle into project containers so tools such as
  `dropbear` come from the CoCalc tools bundle, not from the RootFS image.

Validated smoke path:

- Create first admin via bootstrap token.
- Create project.
- Start project.
- List project files.
- Execute a command in the project.
- Verify `jupyter`, `latexmk`, and project SSH info.
- Hard-reset the VM.
- Verify doctor and smoke still pass after reboot.

## Supported Envelope

V1 should be narrow.

Supported OS:

- Ubuntu 24.04 LTS only.
- Fresh or effectively dedicated VM.

Minimum VM:

- 4 vCPU.
- 16 GiB RAM.
- 100 GiB SSD.

Recommended VM:

- 8 vCPU.
- 32 GiB RAM.
- 250+ GiB SSD.

Hard product limits:

- Small account limit, e.g. 5-25 accounts depending on pricing/licensing.
- Conservative simultaneous-running-project limit derived from both RAM and
  control-plane usability.
- No external project-host creation.
- One local project-host only.

The installer must explicitly warn:

> This machine will be dedicated to CoCalc Star. The installer will create
> users, systemd services, directories, container/runtime state, local database
> state, and firewall/reverse-proxy configuration. Do not run it on a shared
> machine.

## Public VM And Scale Test Findings, 2026-06-05

The first serious public-VM and scale tests materially changed the V1 product
definition.

Validated:

- The Caddy/Let's Encrypt plus `sslip.io` public-VM path is the right default
  zero-config story when a VM has ports 80/443 open.
- The temporary web-onboarding page is a useful reachability proof. If the user
  cannot open it, the problem is outside CoCalc Star: firewall, cloud security
  group, public IP, DNS, or port 443 routing.
- Lambda Cloud Ubuntu 24.04 worked cleanly, including GPU detection inside
  projects.
- A 100-student course setup and bulk file assignment is viable and compelling
  on a large single VM.
- Copy-on-write local assignment makes course file distribution nearly instant
  in the single-host Star model.

Problems exposed:

- GCP's current default Ubuntu 26.04 path is not yet supported. The tested VM
  failed at project start because the data path was not a btrfs filesystem and
  project start attempted to create btrfs subvolumes.
- Fresh Ubuntu VMs can have unattended upgrades holding the `apt`/`dpkg` lock.
  The installer should wait with clear progress and only fail after a long,
  explicit timeout.
- Star upgrades can leave stale control-plane runtime state if project
  containers disappear during an upgrade. This is now handled by Star
  runtime-state reconciliation, but the path should remain covered by upgrade
  tests.
- Under very high bulk-start load, independent CLI waiters and the single hub
  process can make the UI unusable even when the project-host and VM still have
  plenty of CPU/RAM headroom.
- Long-running-operation polling must tolerate transient hub busy/timeouts,
  because a polling failure is not the same as an operation failure.

Scale-test result:

- On a 224 GiB RAM Lambda VM, Star reached about 946 running project containers
  using under half the available RAM.
- The failure mode was not memory exhaustion. The failure mode was
  control-plane saturation and poor human usability: the browser saw connection
  errors and ordinary UI interactions degraded badly.
- Many scale-test projects had been created without the official Star RootFS,
  causing avoidable package bootstrap work during startup. This made the test
  harsher than a correctly-configured Star install, but it also proved that
  Star must set the server-side default RootFS for every creation path.

Product conclusion:

- Star V1 should optimize for a reliable small-team appliance experience, not
  maximum container density.
- Default running-project limits should be conservative, visible, and
  configurable by an admin who accepts the risk. The backend cap now exists;
  follow-up UI/status work should make the cap obvious to admins before they
  hit it.
- Course/bulk operations must use a central queue with throttled concurrency
  and one status stream rather than launching many independent client waiters.
- "This VM could fit 1000 containers" is not a public product promise until the
  Star control plane supports multiple hub workers or otherwise isolates
  interactive traffic from bulk operations.

## Source-Code Findings

The current source already contains most of the pieces.

### Launchpad Control Plane

Source:

- `src/packages/launchpad/README.md`
- `src/packages/launchpad/bin/start.js`
- `src/packages/launchpad/sea/cocalc-template.js`
- `src/packages/launchpad/lib/onprem-config.js`

Relevant facts:

- Launchpad runs the CoCalc hub control plane in one process.
- It defaults to PGlite, `COCALC_PRODUCT=launchpad`, and nextless/api-v2
  routing.
- The SEA template already extracts a compressed `cocalc.tar.xz` asset into
  a versioned cache directory.
- Launchpad auto-selects a base HTTP port and uses the adjacent port as its
  `COCALC_SSHD_PORT`.
- Default fixed fallback is HTTP `9001` and SSHD `9002`.

Star should reuse the compact Launchpad control-plane shape, but not the
desktop/local-user defaults. Star is a system appliance, so data/config should
live under `/opt/cocalc-star`, `/var/lib/cocalc/star`, and `/etc/cocalc/star`.
Unlike desktop/local Launchpad, Star should force local Postgres instead of
PGlite.

### Local Postgres Decision

Star should use local Postgres as its control-plane database. This is no longer
an open question for V1.

Reasons:

- Hard-reboot testing with PGlite raised stability and durability concerns that
  are unacceptable for a production multi-user appliance. Losing or corrupting
  user/project/account state after a VM reset is not an acceptable Star failure
  mode.
- Star runs in a controlled Linux-only server environment. We already install
  many Ubuntu packages for Podman, btrfs, Caddy, build tooling, and project-host
  support, so installing `postgresql` and `postgresql-client` is not a product
  burden.
- Postgres has mature crash recovery, WAL, backup tooling, introspection, and
  operational behavior that match the rest of CoCalc's backend assumptions.
- Performance and concurrency should be materially better for a small multi-user
  site than a single-process embedded database path.
- The normal CoCalc server/database code paths are better exercised with
  Postgres, reducing Star-specific database behavior and making future
  Launchpad/Rocket migration cleaner.
- Local Postgres makes support/debugging easier because `psql`, systemd logs,
  WAL/archive behavior, and ordinary database inspection tools all apply.

Implementation policy:

- Star installs a local Postgres cluster under `/var/lib/cocalc/star/launchpad`.
- Star disables the distro default Postgres service and manages its own local
  database through the hub service environment.
- Star `doctor` must verify that the hub is using Postgres and that `select 1`
  succeeds.

### Project Host Runtime

Source:

- `src/packages/project-host/README.md`
- `src/packages/project-host/bin/start.js`
- `src/packages/project-host/daemon.ts`
- `src/packages/project-host/main.ts`
- `src/packages/project-host/hub/projects.ts`

Relevant facts:

- `project-host` is already the multi-project worker/runtime node.
- `cocalc-project-host daemon start` starts the host-agent supervisor.
- The host-agent supervises project-host plus managed local conat-router and
  conat-persist daemons.
- It reads `/etc/cocalc/project-host.env` and
  `/etc/cocalc/project-host.local.env` when present.
- Default `MASTER_CONAT_SERVER` is `http://localhost:9001`.
- Default `PROJECT_HOST_PUBLIC_URL` and `PROJECT_HOST_INTERNAL_URL` are
  `http://localhost:${9002 + index}`.
- Default project-host public HTTP port is `9002 + index`.
- Managed router defaults to public ingress on the project-host port, app port
  `basePort + 1`, router port `basePort + 100`, and persist health port
  `basePort + 200`.
- Project containers get `run_quota.memory_limit` mapped into podman/project
  runner memory and tmpfs limits.

Important consequence:

- Launchpad's fallback SSHD port `9002` conflicts with project-host index `0`
  public HTTP port `9002`.
- Star must explicitly set ports instead of relying on defaults.

### Provider Model

Source:

- `src/packages/cloud/local.ts`
- `src/packages/cloud/self-host/provider.ts`
- `src/packages/cloud/registry.ts`
- `src/packages/frontend/hosts/providers/registry.ts`

Relevant facts:

- A `local` provider already exists, but it is an in-memory dev/test provider.
  It does not persist or provision real VM state.
- A `self-host` provider exists for hosts controlled through connectors.
- Several server paths already treat `local` and `self-host` differently from
  managed cloud providers.

Star should not expose the existing frontend "Local (manual setup)" provider as
the user-facing model. It should create one local project-host record
automatically during install/bootstrap and hide cloud-provider host creation
from normal Star admins.

### Runtime Admission And Resource Pressure

Source:

- `src/packages/server/projects/runtime-slots.ts`
- `src/packages/server/inter-bay/project-control.ts`
- `src/packages/project-host/host-pressure.ts`
- `src/packages/project-host/hub/projects.ts`

Relevant facts:

- Runtime-slot admission already limits active projects by sponsor membership
  using `max_sponsored_running_projects`.
- Project starts reserve a runtime slot and heartbeats keep it live.
- The project-host pressure controller observes memory pressure and can stop
  running/starting projects under pressure/emergency conditions.
- Default pressure thresholds are:
  - observe at 85% memory used or 2 GiB available,
  - pressure at 90% memory used or 1 GiB available,
  - emergency at 95% memory used or 512 MiB available.
- Project stop priority is based on stop policy, startup protection, cooldown,
  project priority, and projected memory limit.

Star should use these mechanisms rather than inventing a separate scheduler. The
main Star-specific work is deriving stricter local defaults and limits.

### Shared Scratch

Source:

- `src/packages/project-host/file-server.ts`
- `src/packages/project-host/file-server-sandbox-policy.ts`
- `src/packages/project-host/storage-metrics.ts`
- `src/packages/project-host/storage-info-service.ts`
- `src/packages/server/cloud/bootstrap-host.ts`
- `src/packages/server/conat/api/hosts-shared-scratch.ts`

Relevant facts:

- Project-host already supports host-level shared scratch via:
  - `COCALC_SHARED_SCRATCH_ENABLED=1`
  - `COCALC_SHARED_SCRATCH_HOST_MOUNT=/mnt/cocalc-scratch`
  - project-visible mount path `/scratch`
- When enabled, sandboxed project filesystem operations route `/scratch` to
  the host shared scratch mount.
- Storage metrics already report `shared_scratch_total_bytes`,
  `shared_scratch_used_bytes`, and `shared_scratch_available_bytes`.
- Project storage overview already surfaces "Host shared scratch" at
  `/scratch`.
- Existing cloud host bootstrap wires shared scratch as a provider disk when
  `shared_disk_gb` is set.

Star should enable shared `/scratch` by default, but make it admin-managed local
storage on the Star VM rather than a provider-managed disk. The simplest and
most flexible model is:

- `/mnt/cocalc-scratch` on the VM is mounted into every project as `/scratch`.
- Project users map to the existing project UID/GID model, so the admin can use
  Unix ownership and permissions to decide what is visible or writable.
- Bind propagation should allow the VM admin to mount additional resources under
  `/mnt/cocalc-scratch`, e.g. an S3/FUSE mount at
  `/mnt/cocalc-scratch/my-bucket`, and have projects see it at
  `/scratch/my-bucket`.
- The default can be empty and not writable by project users, which makes it a
  safe publish-only surface until the admin deliberately changes permissions.

This is more valuable for small research groups than a fixed-size shared temp
area. It lets the VM admin publish local datasets, mounted object-store buckets,
and course materials without building a separate data distribution feature.

## Architecture

Star is:

- one Launchpad-style hub/control-plane process,
- one local project-host daemon stack,
- one local storage root,
- one local database mode,
- systemd-managed services configured so that on reboot everything automatically starts,
- one local host row pre-registered in the control plane.

It should behave like "Launchpad with exactly one local project host", not like
a separate project runtime architecture.

### Authority Model

Star should keep the same control/data-plane boundary:

- Launchpad/hub authorizes users, projects, memberships, and project placement.
- The local project-host runs projects, files, terminals, Jupyter, previews, and
  project app/proxy traffic.
- The browser should still talk directly to the project-host data plane when
  interacting with projects, even though hub and project-host are on the same
  VM.

Avoid unauthenticated local shortcuts. The local project-host should still
register, heartbeat, and receive scoped project-host auth material. This keeps
the path compatible with Launchpad/Rocket and future migration.

## Service Layout

Current filesystem layout:

```text
/opt/cocalc-star/
  source -> releases/<release-id>/source
  current -> releases/<release-id>
  releases/<release-id>/
    source/
    release.json

/etc/cocalc/star/
  hub.env

/etc/cocalc/
  project-host.env

/var/lib/cocalc/star/
  launchpad/
  project-host/
  backup/
  bootstrap-result.json

/mnt/cocalc/
  data/
  shared-scratch/

/mnt/cocalc-scratch -> bind mount of /mnt/cocalc/shared-scratch

/var/log/cocalc/star/
```

Notes:

- `/opt/cocalc-star/source` remains the stable operator/developer path.
- Versioned releases live below `/opt/cocalc-star/releases`.
- Rollback flips `/opt/cocalc-star/source` and `/opt/cocalc-star/current`, then
  restarts the Star systemd services.
- Runtime data is not stored in release directories.

Suggested systemd units:

- `cocalc-star.target`
- `cocalc-star-hub.service`
- `cocalc-star-project-host.service`
- optionally `cocalc-star-reverse-proxy.service` if we ship our own proxy
- optionally `cocalc-star-update.service` / timer later

The project-host unit can initially call:

```sh
cocalc-project-host daemon start 0
```

using a Star-generated `/etc/cocalc/project-host.env` or
`/etc/cocalc/star/project-host.env`.

## Port Map

Do not rely on current Launchpad and project-host defaults because they collide.

Validated internal defaults:

| Purpose                           | Bind                     | Port   |
| --------------------------------- | ------------------------ | ------ |
| Star public HTTP/reverse proxy    | `0.0.0.0`                | `80`   |
| Star public HTTPS/reverse proxy   | `0.0.0.0`                | `443`  |
| Launchpad/hub HTTP                | `127.0.0.1`              | `9100` |
| Launchpad SSHD/onprem helper      | `127.0.0.1`              | `9101` |
| Hub/local Conat                   | `127.0.0.1`              | `9102` |
| Project-host public ingress       | `127.0.0.1`              | `9002` |
| Project-host conat-router         | `127.0.0.1`              | `9112` |
| Project-host conat-persist health | `127.0.0.1`              | `9212` |
| Project SSH ingress               | `0.0.0.0` or `127.0.0.1` | `2222` |

Important validated issue:

- Do not let project-host derive its managed Conat router as `PORT + 100` when
  project-host `PORT=9002`. That collides with the hub's local Conat port
  `9102` after reboot. Star must set `COCALC_PROJECT_HOST_CONAT_ROUTER_PORT`
  explicitly.

V1 should make private first-run access completely explicit, and should support
HTTPS automation as an optional follow-up.

Recommendation:

- For initial install, bind the hub to loopback and print a complete SSH
  `-L <local-port>:127.0.0.1:9100` command plus the matching localhost
  bootstrap URL.
- Use Caddy or another standard small reverse proxy for automatic Let's Encrypt
  when the admin provides a DNS name that resolves to the VM.
- Keep TLS out of the CoCalc Node.js processes; terminate at the proxy.
- Support LAN/private HTTP as an explicit local-only mode, but do not make
  public remote HTTP the default onboarding path.
- Keep Cloudflare out of Star V1 to preserve the product promise.

Reasoning:

- Remote HTTP-only WebSockets are fragile in real browsers and networks.
- Expecting users to invent SSH-forwarding commands is not a viable product
  experience. Printing the exact command is acceptable for the initial private
  testing path, but Star still needs a first-class public URL story for broad
  non-technical adoption.
- Caddy-style HTTPS is a standard solved problem and should be easier than
  debugging many insecure-transport edge cases.

## Local Host Registration

Star needs a deterministic bootstrap path that creates exactly one host row and
connects the local project-host.

Options:

1. Create a host row directly during Star bootstrap with `machine.cloud="local"`
   and runtime URLs pointing at the local project-host.
2. Build a Star-specific "local host bootstrap" Conat API that registers the
   project-host after it starts.
3. Reuse self-host connector logic.

Recommendation:

- Implement a Star-specific bootstrap action that is explicit but uses the same
  host table/runtime fields as normal project hosts.
- Do not rely on `cloud/local.ts` in-memory provider state.
- Do not use `self-host` connector UX for the first local host.

Desired host row shape:

```json
{
  "name": "star-local-0",
  "status": "running",
  "machine": {
    "cloud": "local",
    "storage_mode": "persistent",
    "metadata": {
      "product": "star",
      "local": true
    }
  },
  "provider_instance_id": null
}
```

The project-host should report heartbeat and health through existing host
registry paths so admin/host UI and project placement do not need a fork.

## Resource Model

Star shares one VM between:

- hub/control plane,
- local Postgres for hub/control-plane state,
- project-host daemons and their local runtime state,
- containers/projects,
- rootfs/build/cache,
- backup/rustic jobs.

The user remembered an existing "total RAM - 3 GiB for projects" style policy.
For Star, reserve more for the control plane and OS.

Recommended V1 resource defaults:

- Reserve at least 6 GiB for hub/database/OS/project-host daemons.
- If RAM <= 16 GiB, reserve 6 GiB.
- If RAM > 16 GiB, reserve `max(6 GiB, 20% RAM)`.
- Project memory budget = total RAM - reserve.
- Default per-project memory = 2 GiB.
- Memory-derived running projects = floor(project memory budget /
  default-per-project memory).
- V1 default max running projects = min(memory-derived running projects,
  control-plane usability cap).
- Initial control-plane usability cap should be conservative, e.g.
  `min(100, max(5, floor(total_ram_gb * 2)))`, until bulk-start and hub scaling
  measurements justify a higher default.
- Admins may raise the cap, but the UI should warn that this can make the
  appliance sluggish or temporarily unusable during bulk project starts.

Examples:

| VM RAM  | Reserved | Project budget | Default active projects |
| ------- | -------- | -------------- | ----------------------- |
| 16 GiB  | 6 GiB    | 10 GiB         | 5                       |
| 32 GiB  | 6.4 GiB  | 25.6 GiB       | 12                      |
| 64 GiB  | 12.8 GiB | 51.2 GiB       | 25                      |
| 224 GiB | 44.8 GiB | 179.2 GiB      | 100 initial cap         |

Do not use `(RAM in GB) * 10` as a V1 product default. The 2026-06-05 Lambda
test suggests the project-host/container layer may eventually support that
density on large machines, but the single Star hub/control plane became the
dominant usability bottleneck first.

Use existing controls:

- Set account/membership `max_sponsored_running_projects` to the derived cap.
- Set default project `run_quota.memory_limit` from Star defaults.
- Let runtime-slot admission reject starts above the cap.
- Let host-pressure stop projects under real memory pressure.

Star-specific pressure defaults should be more conservative:

- observe when memory available <= 4 GiB,
- pressure when memory available <= 2 GiB,
- emergency when memory available <= 1 GiB,
- keep percent thresholds close to current defaults.

Environment overrides:

```text
COCALC_STAR_RESERVED_MEMORY_GB=6
COCALC_STAR_DEFAULT_PROJECT_MEMORY_GB=2
COCALC_STAR_MAX_RUNNING_PROJECTS=<derived or licensed>
COCALC_PROJECT_HOST_PRESSURE_OBSERVE_MEMORY_AVAILABLE_BYTES=4294967296
COCALC_PROJECT_HOST_PRESSURE_MEMORY_AVAILABLE_BYTES=2147483648
COCALC_PROJECT_HOST_EMERGENCY_MEMORY_AVAILABLE_BYTES=1073741824
```

Product decision:

- Should Star limits be enforced by license/membership rows, by a Star product
  setting, or both? Membership rows should be important because they give admins
  a normal CoCalc mechanism for controlling what users can do. Star should also
  have product-level caps for account count and active project count so the
  appliance cannot be configured far outside its supported envelope.

Recommendation:

- Use membership/runtime-slot limits for actual enforcement.
- Use Star settings for derived defaults and UI display.
- License gates can cap the derived value.
- Add a global Star running-project cap in addition to per-account sponsorship
  limits, so course/bulk starts cannot overload the whole appliance even if one
  admin account has a high sponsorship limit.
- Course "start all" and similar bulk actions should enqueue work against this
  global cap and report progress from one bulk operation rather than creating a
  stampede of independent project-start waiters.

## Storage Model

V1 storage:

- One local filesystem root.
- Btrfs/podman/project-host runtime under `/var/lib/cocalc/star/project-host`
  or `/mnt/cocalc`.
- Host-level shared `/scratch` enabled by default for all projects.
- Rustic backups to local disk by default.

### Shared `/scratch`

Star should include a shared `/scratch` area that is visible to every project on
the local project-host.

Why:

- It gives the VM admin a simple way to publish datasets, course files, sample
  notebooks, and other shared material to all users.
- Without it, sharing local data between projects requires much more complex
  account/project/file workflows.
- It makes Star feel like a real shared machine, not just many isolated project
  homes.

Implementation target:

- Enable existing project-host shared scratch by default:
  - `COCALC_SHARED_SCRATCH_ENABLED=1`
  - `COCALC_SHARED_SCRATCH_HOST_MOUNT=/mnt/cocalc-scratch`
  - `COCALC_SHARED_SCRATCH_PROJECT_MOUNT=/scratch`
- Treat `/mnt/cocalc-scratch` as an admin-owned mount point.
- Prefer a btrfs subvolume with quota when using one physical VM disk, because
  it reduces the chance of `/scratch` consuming the entire disk while still
  allowing admin
  enlargement later.
- If the VM has a separate data disk, optionally mount a dedicated partition or
  filesystem at `/mnt/cocalc-scratch`.
- Use mount propagation so admin-mounted resources below
  `/mnt/cocalc-scratch` are visible inside projects.

Default sizing:

- Minimum: 10 GiB.
- Recommended default: `min(100 GiB, max(10 GiB, 20% of available data disk))`.
- Expose the chosen size in the Star setup/admin page.

Permissions:

- V1 should default to admin-writable and project-readable or project-invisible
  until the admin explicitly changes permissions.
- This avoids accidental cross-user writes while still making the feature useful
  immediately as a data publishing mechanism.
- If the admin wants a writable shared workspace, they can grant access using
  Unix permissions against the project UID/GID model.

Recommendation:

- Do not add a custom Star permissions UI in V1.
- Document the exact host path, project path, UID/GID behavior, and a few common
  `chown`/`chmod` recipes.
- Add a UI later only if real users cannot manage the Unix-level model.

Operations:

- The setup health page should show shared scratch size/free space.
- The installer should create the mount/subvolume and fail if it cannot enforce
  a bound.
- Upgrade must preserve `/mnt/cocalc-scratch`.
- Backup docs must be explicit: shared `/scratch` is local VM state and may be
  excluded from normal project backup semantics unless we explicitly include it.

Installer responsibilities:

- Detect whether btrfs is available or create/format a btrfs volume/file-backed
  loop device if that is the chosen project-host requirement.
- Create and mount the shared scratch subvolume/filesystem.
- Enforce the initial shared scratch size/quota.
- Create required Linux users/groups without colliding with existing IDs.
- Validate podman/overlay/btrfs support before starting services.
- Fail early on dirty/non-dedicated machines.

Backup V1:

- "Snapshot the VM/disk" is the primary operational backup story.
- Local rustic backups can be available, but they are not sufficient if the
  whole VM/disk is lost unless copied elsewhere.
- Admin guide will suggest: "(1) the site master encryption key is here - back this up somewhere, and (2) make regularly copies of the rustic backups using something rsync or rclone." It's far smaller/cheaper to backup the rustic directory than everything. But that's entirely up to the admin. Obviously this is an upsell point for Rocket.

Backup V2:

- Optional external S3/R2/backblaze backup target.
- This can become an upsell or support feature, but should not be required for
  first install.

## Security Model

Star has a larger blast radius than Launchpad with remote project hosts because
the control plane and project execution share one VM.

V1 acceptance:

- This is acceptable for small trusted teams if documented clearly.
- Do not market Star as a high-isolation enterprise/multi-tenant product.

Hardening:

- Dedicated Unix users:
  - `cocalc-star` for hub/control plane.
  - `cocalc-host` or existing project-host runtime users for project-host.
- systemd service isolation:
  - conservative `Restart=always`,
  - explicit `WorkingDirectory`,
  - limited writable paths where possible,
  - separate logs.
- Firewall defaults:
  - expose only HTTP/HTTPS and optional SSH/project SSH ports.
  - keep hub/project-host internal ports bound to loopback.
- Preserve project-host scoped auth. Do not bypass because it is local.

Open decision:

- Should the installer configure `ufw` automatically? (I agree with recommendation.)

Recommendation:

- Yes, but only after explicit confirmation.
- Marketplace images can preconfigure provider firewalls instead.

## Packaging Strategy

Milestone 0 should not start with SEA perfection.

Current sequence:

1. Build from source on a fresh Ubuntu VM. Done.
2. Write an installer script that mutates the VM and makes it work. Done.
3. Build a Star source tarball and install from it. Done.
4. Add versioned release layout and rollback while keeping
   `/opt/cocalc-star/source` as the stable path. Done.
5. Build a first-class Star release artifact with `install.sh`, source tarball,
   manifest, and checksums. Done.
6. Split out a reusable Star systemd/release scaffold.
7. Build a smaller Star runtime tarball that does not require a full source
   checkout build on the target VM.
8. Wrap the tarball in a SEA installer/launcher if it still improves the
   operator experience.
9. Publish marketplace images only after the tarball/script path is boring.

SEA target:

- A compressed single-file `cocalc-star` artifact.
- It extracts versioned assets, installs/stages systemd units, writes config,
  and starts the target.
- It should support:
  - `cocalc-star install`
  - `cocalc-star status`
  - `cocalc-star logs`
  - `cocalc-star restart`
  - `cocalc-star upgrade`
  - `cocalc-star uninstall` eventually

Do not make normal operation depend on running the SEA binary as a long-lived
process. Use systemd services for long-running processes.

Uninstall should become a first-class command before broad non-technical
testing:

- Stop and disable Star systemd units.
- Remove Star-owned systemd unit files and mutable service config.
- Remove `/opt/cocalc-star` and `/var/lib/cocalc/star` only after an explicit
  confirmation because they contain releases, database state, project data,
  rootfs caches, backups, and secrets.
- Remove Star-created users/groups only when no remaining files need them.
- Print exactly what was left behind if the uninstall is conservative.

This matters for trust. Star is intentionally a full appliance that takes over a
dedicated VM, but users will sometimes test on the wrong machine. A clear
uninstall path makes the warning less terrifying without weakening the
dedicated-VM requirement.

## CoCalc Plus Star Manager Path

CoCalc Plus should provide an optional Star manager/install path, distinct from
the primary `curl | sudo bash` Star installer.

Target CLI:

```sh
cocalc-plus star ubuntu@1.2.3.4
```

Later non-blocking CLI polish:

```sh
cocalc star ubuntu@1.2.3.4
```

The `cocalc` CLI already has product-shortcut plumbing for commands such as
`cocalc plus ...` and `cocalc launchpad ...`. A future `cocalc star ...`
shortcut should delegate to the same `cocalc-plus star ...` implementation
rather than reimplementing SSH probing, Star install, status polling, tunnel
management, or bootstrap URL handling. This is useful for agents and CLI-first
users, but it is not a release blocker; the primary supported paths remain the
public Star installer and the Plus Star manager path.

Behavior:

1. SSH to the target.
2. Check reachability, OS/arch, and passwordless sudo via `sudo -n true`.
3. Check whether CoCalc Star is already installed.
4. If not installed, run the same public Star installer as the manual path:
   `curl ... | sudo bash`.
5. Poll Star install/status logs until the hub is ready.
6. Read the bootstrap result from the remote machine.
7. Set up an SSH local port forward automatically.
8. Print and/or open the local bootstrap URL.

Target UI:

- Extend the existing Plus remote SSH sessions modal with a "Run remotely"
  choice:
  - `CoCalc Plus`: normal-user install, lightweight, does not take over the
    machine.
  - `CoCalc Star`: requires passwordless sudo, provisions a full multi-user
    appliance, and should be run only on a dedicated VM.
- The Star option must show a strong explicit warning before Create. The warning
  should say that Star creates users, systemd services, project/runtime data,
  container/rootfs caches, and a local database, and that it is intended for a
  dedicated VM.
- After Create, show install progress, the active tunnel, and the admin
  bootstrap link.
- Reuse the existing Plus remote SSH session plumbing as much as possible:
  target parsing, identity/proxy-jump/extra SSH arguments, reachability checks,
  local tunnel lifecycle, recent-connection state, and status/progress display.
  The Star-specific backend should remain the shared `cocalc-plus star` command
  path so the graphical UI is a management surface, not another installer.

This path is especially valuable for Windows and non-Unix laptop users once
Plus has a reliable desktop/Electron distribution. It should reuse the same Star
installer and lifecycle commands rather than becoming a separate install
implementation.

## Developer Source Deployments

Star should also be a practical developer and customer-customization target.
This is distinct from normal appliance operation: ordinary Star installs should
run from versioned release artifacts, while developer mode provides a controlled
way to build a local CoCalc checkout and deploy that build onto the same VM.

Use cases:

- Employees need a one-VM path to test and deploy Codex development work without
  also configuring Cloudflare, GCP, Nebius, or a Rocket cluster.
- Customers with license permission may want to customize their CoCalc
  environment, add local features, or carry private patches.
- Support can produce a bug-fix branch and give the customer a safe way to
  build, deploy, smoke test, and roll back.

Design rule:

- Do not run the production Star services directly from a mutable source
  checkout by default.
- A source checkout should build a normal Star release directory, stage it under
  `/opt/cocalc-star/releases/<build-id>`, run health checks, then flip
  `/opt/cocalc-star/current` and `/opt/cocalc-star/source`.
- Rollback should be the same path as artifact-based upgrades.

Recommended paths:

```text
/opt/cocalc-star/
  current -> releases/<build-id>
  source -> releases/<build-id>/source
  releases/<build-id>/
    source/
    release.json
  source-builds/

/var/lib/cocalc/star/
  build-cache/

/home/cocalc-dev/cocalc-ai/
  src/
```

Recommended CLI:

```sh
cocalc-star dev init-source --path /home/cocalc-dev/cocalc-ai
cocalc-star dev status
cocalc-star dev build --path /home/cocalc-dev/cocalc-ai/src
cocalc-star dev deploy --path /home/cocalc-dev/cocalc-ai/src
cocalc-star dev rollback
```

`dev deploy` should:

1. Refuse by default if the source checkout is dirty, unless
   `--allow-dirty` is passed.
2. Record source commit, branch, dirty state, build time, builder version, and
   Star product version.
3. Build the control-plane, frontend/static assets, project-host runtime, and
   any Star-specific scripts needed by the release.
4. Produce a release artifact or release directory with the same shape as
   packaged Star.
5. Run pre-deploy checks:
   - database backup/export exists,
   - migrations are known,
   - service ports are available,
   - disk space is sufficient,
   - current release remains available for rollback.
6. Stop/restart services through systemd, not ad-hoc process killing.
7. Run health checks:
   - hub health,
   - local project-host health,
   - login/admin page reachable,
   - project start smoke test if requested.
8. Leave a visible build fingerprint in `cocalc-star status` and the admin UI.

Optional fast path:

- `cocalc-star dev run-from-source` can exist for employees only, but should be
  clearly marked non-production.
- It is useful for quick iteration, but it should not be the path used by
  customer bug-fix deployments.

Support boundary:

- A source-deployed Star instance should be marked as a custom build.
- Support tooling should show the exact source commit and whether there are
  uncommitted patches.
- Product/licensing needs an explicit decision: customer source customization
  may be allowed by the public source license, but supported custom deployment
  should likely be a paid/support-eligible tier.

Security boundary:

- Developer deploy access is stronger than Star admin UI access.
- It should require shell/root or a dedicated `cocalc-dev` Unix account with
  explicit sudoers entries, not just a CoCalc admin account.
- The web admin UI can display build status, but should not execute arbitrary
  source builds in V1.

## Installer Flow

V1 interactive flow:

1. Detect OS, CPU arch, RAM, disk, virtualization/container support.
2. Print a destructive/dedicated-machine warning.
3. Ask for confirmation.
4. Install OS packages:
   - Node runtime if not embedded for services,
   - podman,
   - btrfs tools,
   - systemd unit dependencies,
   - optional reverse proxy.
5. Create users/groups.
6. Create directories.
7. Generate secrets:
   - site master key,
   - project-host auth keys/tokens,
   - local conat credentials,
   - registration token.
8. Install Star release.
9. Install systemd units.
10. Start hub.
11. Register local project-host.
12. Start project-host.
13. Wait for health.
14. Print admin registration link and the exact access instructions.

For a public VM with ports 80/443 open, the first visible user experience should
be:

```text
CoCalc Star public onboarding is ready.

Open this temporary HTTPS page to verify public access and continue install:
https://<public-hostname>/star-install/<nonce>

The page will stream install status and show the final bootstrap URL.
```

After the install finishes, both the web onboarding page and terminal should
show:

```text
CoCalc Star is running.

Public URL:
https://<public-hostname>/

Create the first admin account:
https://<public-hostname>/auth/sign-up?registrationToken=<registration-token>&bootstrap=1

Invite other users after admin setup:
https://<public-hostname>/auth/sign-up?registrationToken=<invite-registration-token>

Fallback private access is also available over SSH:
ssh -L 9100:127.0.0.1:9100 <ssh-user>@<vm-ip-or-hostname>
http://127.0.0.1:9100/auth/sign-up?registrationToken=<registration-token>&bootstrap=1
```

For a private VM, laptop-local VM, or public VM without ports 80/443 open, the
first visible user experience should be:

```text
CoCalc Star is running.

From your laptop, open a tunnel to this VM:
ssh -L 9100:127.0.0.1:9100 <ssh-user>@<vm-ip-or-hostname>

Then open this local URL to create the first admin account:
http://127.0.0.1:9100/auth/sign-up?registrationToken=<registration-token>&bootstrap=1

If port 9100 is already in use on your laptop, use a different local port:
ssh -L 9500:127.0.0.1:9100 <ssh-user>@<vm-ip-or-hostname>
http://127.0.0.1:9500/auth/sign-up?registrationToken=<registration-token>&bootstrap=1

Admin setup:
- Create account.
- Enable 2FA.
- Optionally configure email.
- Start a smoke-test project.
```

The installer should avoid ambiguous hostnames in this output. If the installer
can infer the SSH user and public IP, it should print a complete tunnel command.
If not, it should print placeholders with a short explanation.

The public-VM path should prefer Caddy/Let's Encrypt when a public hostname is
available. For early testing, an `sslip.io`-style hostname derived from the
public IP is acceptable if the operator understands that the URL changes when
the VM's public IP changes. For production-like use, recommend a real DNS name
or a reserved/static cloud IP.

The web onboarding page should be:

- served by Caddy over the same public HTTPS path that will serve CoCalc,
- protected by an unguessable one-time nonce in the URL,
- read-only from the browser's perspective,
- limited to status/progress/final URLs and sanitized logs,
- disabled by explicit non-interactive/agent flags.

## Star Onboarding UI

Star should have a separate zero-conf setup profile from Launchpad/Rocket cloud
setup.

Required:

1. Admin account exists.
2. Smoke-test path is ready and the operator can create/start a project, open a
   terminal, and open Jupyter.

Supported but optional:

- Admin 2FA, recommended before inviting real users.
- Local project-host health details.
- Default RootFS status.
- Shared `/scratch` status.
- VM resource budget and recommended operating envelope.
- Email provider for password resets, invites, and notifications.
- Public URL / TLS, preferably Caddy plus Let's Encrypt once DNS points at the
  VM.
- SSH port-forwarding guidance for private first-run access, including a way to
  re-display the bootstrap URL and tunnel command from `star.sh status`.
- License code entry, deferred until it unlocks limits/functionality/upgrades
  or support.
- Custom RootFS images, including GPU-specific images for GPU VMs.
- Backups, with VM/disk snapshots as the V1 recommendation.

The cloud-backed Launchpad/Rocket wizard should not ask Star users for
Cloudflare, GCP, or Nebius.

Implementation implication:

- Setup status needs a product/profile dimension:
  - `star-single-vm`
  - `launchpad-cloud`
  - `rocket-cloud`

## Technical Difficulties Answered

### Can Launchpad And Project-Host Run On One VM?

Yes. The existing source already supports nearly all required behaviors, but
Star must provide explicit config.

Main required fixes:

- Avoid the Launchpad `9002` SSHD and project-host `9002` HTTP default conflict.
- Create/register the local host row automatically.
- Ensure project-host auth keys/tokens are provisioned locally.
- Bind internal services to loopback.
- Set Star-specific resource defaults.

### Is A Local Project Host A Special Case?

It should be a deployment special case, not an architecture special case.

Use the same project-host registration, heartbeat, routing, and scoped auth
paths as external hosts. Only the installer/bootstrap should know this host is
local and preinstalled.

### Does Star Need Cloudflare?

No. Star's core value is avoiding Cloudflare/cloud-provider setup.

The default public-VM path should be:

- Caddy + Let's Encrypt,
- user-provided DNS name when available,
- `sslip.io`-style public-IP hostname for zero-config testing,
- SSH tunnel fallback when public ports are unavailable.

Cloudflare reverse tunnels are useful later for users behind NAT, changing IPs,
or restrictive firewalls, but they are not the first/default Star experience
because they add an external account, product dependency, and trust boundary.

Future option:

- `cocalc.ai` can offer an opt-in registration service that gives Star users a
  managed subdomain and reverse tunnel. This would make public access easier,
  provide a registration/support funnel, and avoid forcing operators to learn
  DNS/TLS immediately. It is explicitly post-initial-release work, not required
  for the public-VM proof of concept.

### Does Star Need A Cloud Provider Adapter?

Not in the normal UI.

The existing `local` provider is useful as a conceptual fit but currently
in-memory/dev oriented. Star should create the local host directly or through a
dedicated Star bootstrap API, not expose a "create local host" provider form.

### How Are Updates Handled?

Use versioned releases and rollback semantics while preserving
`/opt/cocalc-star/source` as the stable operational path.

Plan:

- `/opt/cocalc-star/releases/<release-id>/source`
- `/opt/cocalc-star/releases/<release-id>/release.json`
- `/opt/cocalc-star/source -> releases/<release-id>/source`
- `/opt/cocalc-star/current -> releases/<release-id>`
- pre-upgrade DB backup/export
- stage new release
- run migrations
- restart services
- rollback symlink on failure where safe

Do not overwrite a live install in place.

### How Are Backups Handled?

V1:

- Recommend provider VM/disk snapshots.
- Provide local export/check commands.
- Tell user: copy this master key and periodically copy this rustic directory
  somewhere, and that's your backups. Restore from master key + rustic must be
  part of the supported workflow and test plan.

V2:

- Optional external backup target.
- Health check warns if no off-machine backup exists.

### What Makes This Marketplace-Friendly?

Star avoids cloud-specific APIs. Marketplace integration only needs:

- Ubuntu image or install script.
- VM sizing recommendations.
- Firewall/security-group defaults.
- First-boot service that prints or exposes the admin registration link.
- Clear private bootstrap access instructions when the image has no DNS/TLS yet.

This makes AWS/Azure/GCP/Nebius marketplaces all mostly packaging/business work,
not provider feature development.

Marketplace DNS/TLS expectation:

- VM image marketplaces usually provide a VM image, public IP, firewall/security
  group guidance, SSH access, and product documentation. They generally do not
  provide automatic DNS names and trusted TLS certificates for arbitrary
  self-hosted VM web apps.
- Some higher-level platform products provide managed domain workflows, but
  those are not the same thing as a raw VM appliance marketplace image.
- Therefore Star should assume marketplace users initially access the appliance
  through one of:
  - private SSH tunnel to `127.0.0.1:9100`,
  - public IP over HTTP only for short-lived setup/testing,
  - user-provided DNS plus Caddy/Let's Encrypt,
  - future CoCalc-managed DNS/reverse-tunnel service.
- The marketplace image should expose the admin bootstrap path through first-run
  instructions, `star.sh status`, and provider documentation. It should not
  depend on a marketplace-specific DNS hook.

Packaging options to evaluate after the script installer is boring:

- Marketplace appliance images for the main lead-generation path.
- `.deb` package and optional apt repository for operators who prefer normal
  Linux lifecycle tooling.
- GitHub release tarball + `curl | sudo bash` for early testing and direct
  installs.

The marketplace appliance is the strategic product surface. The `.deb` is a
distribution convenience, not a substitute for a focused appliance experience.

## Product Decisions Needed

1. Final name:
   - working name: `CoCalc Star`.
   - CLI/package: `cocalc-star`.
2. License/account cap:
   - free/trial cap - 2 accounts,
   - paid cap - 25 accounts,
   - enforcement location - (not sure).
3. Public URL/TLS:
   - immediate public-VM path: Caddy + Let's Encrypt with a public hostname,
   - zero-config testing path: `sslip.io`-style hostname from public IP,
   - private fallback: SSH tunnel instructions printed by installer,
   - later opt-in: CoCalc-managed subdomain/reverse tunnel or Cloudflare-style
     tunnel for NAT/changing-IP environments,
   - operator-managed reverse proxy remains supported.
4. Email:
   - optional &lt;-- this; not part of onboarding, but the functionality exists,
   - hidden email-verification UI when disabled,
   - admin password reset links still available.
5. Default RootFS:
   - ship a small prebuilt default,
   - build on first run &lt;-- this; it would make the onboarding a little slower but it would also 100% prove that the full podman/rustic/rootfs lifecycle is working here which is very valuable. It should be pretty fast if tiny.,
   - or guide admin to create one &lt;-- still do this.
6. Backup:
   - document VM snapshots as V1 &lt;-- this for sure, and just document (you can rsync/rclone rustic somewhere; up to you),
   - or require external backup setup before "ready".
7. Marketplace support level:
   - image only &lt;-- initially this (paid and managed is more of a rocket product for good leads),
   - paid support,
   - or managed updates.
8. Developer/source deployments:
   - employee-only &lt;-- initially this (below will be important later),
   - available to customers but unsupported,
   - or supported as a paid/customization tier.
9. Custom-build support boundary:
   - what changes void standard support,
   - what build fingerprint must be provided,
   - and whether support can request rollback to an official release before
     debugging.
10. Product focus:

- hide or disable SaaS/cloud-provider features that do not make sense in a
  single-VM appliance, including Stripe sales flows, Cloudflare setup, cloud
  host creation, and provider-specific launch flows,
- keep the underlying code paths where they are shared with Launchpad/Rocket,
  but give Star a focused admin/product profile instead of exposing every
  technically possible control-plane feature,
- discuss and decide the exact disabled feature list before the initial
  public/product demo.

## Implementation Phases

### Phase 1: Prove It Manually On Fresh Ubuntu

Deliverable:

- Documented commands that turn a fresh Ubuntu VM into Star.
- Launchpad hub running under systemd.
- Local project-host running under systemd.
- One local host row healthy.
- Admin registration token printed.
- Project creation/start works.

Status: substantially complete.

Validation:

- Fresh VM install. Done.
- Reboot/hard-reset VM and verify services recover. Done.
- Create admin, project, file listing, project exec, project SSH info. Done.
- Jupyter executable is present in the default RootFS. Done.
- Browser-level Jupyter UI validation remains to do.

### Phase 2: Star Bootstrap Script

Deliverable:

- `src/scripts/star/` installer entry points.
- `src/scripts/star-poc/` reusable bootstrap implementation.
- Explicit port map.
- Local host registration command/API.
- Local Postgres initialization.
- Default RootFS build/cache.
- `doctor` and `smoke` commands.

Validation:

- Repeatable clean VM setup. Done.
- Hard-reset durability. Done after fixing project-host tools and Conat ports.
- Idempotent rerun behavior. Partially done; needs more explicit tests.
- Clear failure if machine is not suitable. Not done.

### Phase 2.5: Versioned Release And Rollback

Deliverable:

- Keep `/opt/cocalc-star/source` as the stable source path.
- Store releases under `/opt/cocalc-star/releases/<release-id>/source`.
- Store release metadata in `/opt/cocalc-star/releases/<release-id>/release.json`.
- Maintain `/opt/cocalc-star/current`.
- Add `star.sh releases`, `star.sh current-release`, and
  `star.sh rollback [release-id]`.
- Ensure systemd services use the stable source symlink rather than a
  one-off extracted directory.

Status: implemented for the tarball installer path.

Validation:

- Fresh install creates a release and points `/opt/cocalc-star/source` at it.
  Done on a clean GCP VM.
- Release metadata is written to
  `/opt/cocalc-star/releases/<release-id>/release.json`. Done.
- Installing a second tarball creates a second release. Done in local release
  harness validation.
- Rollback flips `/opt/cocalc-star/source` and `/opt/cocalc-star/current`, then
  restarts services. Done in local release harness validation.
- Doctor and smoke pass after installing a later release on a full VM. Done.
- Doctor passes after rollback to the previous release on a full VM. Done.
- Doctor passes after rolling forward again to the latest release on a full VM.
  Done.
- Smoke after rollback passes on a full VM. Done.
- Hard reset after rollback starts the selected release and `doctor` passes
  after readiness retry. Done.
- Automated artifact-driven GCE validation exists:
  `src/scripts/star/validate-gce-release-upgrade.sh`. Done.

### Phase 3: Star Setup Profile In UI

Deliverable:

- Setup wizard profile `star`.
- No Cloudflare/provider gates.
- Shows local host health, resource budget, rootfs, smoke test, optional email.
- Star installer sets `COCALC_SETUP_PROFILE=star` while preserving
  `COCALC_PRODUCT=launchpad` for existing server/runtime behavior.

Status: initial zero-conf implementation complete.

Validation:

- Star users never see GCP/Nebius/Cloudflare as required setup.
- Launchpad/Rocket users still see cloud setup.
- Star setup readiness is derived from the first admin account and a working
  local smoke-test path. The smoke path currently means local project-host and
  default project image readiness; a follow-up should persist the most recent
  browser smoke-test result.
- Admin 2FA, local project-host health, default RootFS, email, TLS/public URL,
  license entry, backups, resource budget, and custom RootFS are shown as
  optional/manual follow-up checks, not blockers.

### Phase 3.5: Public VM HTTPS And Invite Flow

Deliverable:

- Installer accepts `STAR_PUBLIC_URL`, `STAR_PUBLIC_HOSTNAME`, or equivalent
  CLI/env input for agent-friendly installs.
- Interactive installer prompts for the public IP/hostname only when not
  provided.
- Installer can run a preflight reachability smoke test for ports 80/443 before
  doing the expensive install.
- Installer configures Caddy + Let's Encrypt for the public URL when requested.
- Human interactive installer starts a temporary HTTPS web onboarding page
  before the full install, then waits for the user to open it before
  continuing.
- Web onboarding page streams sanitized install progress and final URLs.
- Web onboarding page is nonce-protected and read-only; it must not expose
  secrets or browser-triggered command execution.
- Non-interactive/agent mode can disable the web-confirmation gate while still
  configuring public HTTPS and printing deterministic final URLs.
- `star.sh status` reports:
  - hub/project-host health,
  - public HTTPS URL,
  - admin bootstrap URL while valid,
  - invite/signup URL while valid,
  - SSH tunnel fallback instructions.
- Admin setup/profile UI shows the public URL/TLS state as a first-class Star
  appliance status item.
- First admin sees or can regenerate a copy/paste invite URL for additional
  users without manually creating a registration token elsewhere.
- Codex subscription-link UI renders immediately with a loading state while
  waiting for the external/device code.

Status: partially implemented and validated.

Validated:

- GCP public VM with ports 80/443 open can serve the temporary HTTPS onboarding
  page through Caddy/Let's Encrypt.
- Opening the onboarding URL proves public reachability and can continue the
  install.
- Final HTTPS bootstrap worked in the browser, and the admin could create
  projects and use the server.
- Lambda Cloud public VM install worked cleanly on Ubuntu 24.04, including GPU
  visibility inside projects.

Remaining:

- Replace the long GitHub release command with a stable short public command.
- Print the temporary onboarding URL only once, with explicit port-443/firewall
  troubleshooting text.
- Keep the onboarding page visually plain and installer-like: no decorative
  gradient, clear steps, continue button, five-minute estimate, progress bar.
- Wait for `apt`/`dpkg` locks instead of failing on unattended upgrades.
- Re-enable or preserve normal unattended-upgrades behavior after install.
- Block or remediate unsupported filesystem layouts before project start.
- Ensure `star.sh status` can re-display public URL, bootstrap URL while valid,
  invite URL while valid, and SSH fallback.
- Add the admin invite URL flow and Codex loading-state polish.

Validation:

- Fresh public GCP VM with ports 80/443 open installs with a single command and
  first yields a working temporary HTTPS onboarding page, then a working HTTPS
  bootstrap URL.
- Human install refuses or clearly pauses until the onboarding URL is opened,
  unless web onboarding is explicitly disabled.
- Same install can run non-interactively by passing public URL/hostname input.
- Caddy/Let's Encrypt failure leaves SSH tunnel fallback usable and prints a
  clear next step.
- First admin creates a project; terminal, Jupyter, and LaTeX work immediately.
- Admin invite URL creates a second non-admin user.
- Second user creates a project and can collaborate on an existing project.
- Codex link flow visibly enters a loading state immediately, then shows the
  actual code when available.

### Phase 3.6: Star Scale And Usability Guardrails

Deliverable:

- Global Star running-project cap, separate from per-account sponsorship caps.
- Conservative default derived from RAM and control-plane usability, not just
  theoretical container density.
- Admin UI/status display for:
  - configured global running cap,
  - currently running projects,
  - queued/starting bulk operations,
  - warning when the cap is raised beyond the recommended default.
- Course "start all" and similar bulk actions run through one throttled queue
  and one bulk progress stream.
- CLI/API bulk start paths avoid spawning many independent waiters against the
  hub.
- Star upgrade/restart reconciles missing containers, stale active operations,
  stale long-running operations, and expired runtime slots.
- Project start admission fails quickly and clearly when the global cap is
  reached, instead of queuing indefinitely or overloading the hub.

Status: required for first public release.

Validation:

- On a recommended 8 vCPU / 32 GiB VM, start projects up to the default cap and
  verify the browser remains responsive.
- On a large VM, create a 100-student course, provision projects, assign files,
  and start all projects without making the admin UI unusable.
- Re-run the large Lambda-style test after the official RootFS default and bulk
  throttling are in place. The target is not 1000 running projects for V1; the
  target is predictable behavior, clear caps, and no browser-breaking
  stampedes.
- Upgrade while projects are running, then verify runtime state reconciles with
  actual containers.
- Kill the hub during a bulk start and verify active operations either resume
  safely or fail with actionable status.

### Phase 4: Packaged Runtime

Deliverable:

- `packages/star` package (YES, do create packages/star) or `packages/launchpad` Star build target.
- Runtime tarball includes:
  - control-plane bundle,
  - project-host bundle,
  - bootstrap scripts,
  - systemd scaffold.
- Versioned release install under `/opt/cocalc-star`.

Validation:

- Runtime tarball installs without a target-VM source build. Done.
- Runtime A to runtime B upgrade passes doctor and smoke. Done.
- Runtime rollback passes doctor and smoke. Done.
- Runtime hard-reset recovery passes after doctor readiness retry. Done.
- Upgrade preserves data. Basic control-plane/project-host preservation is
  validated by smoke; deeper user-data migration tests remain to do.

Status: implemented and validated for the tarball installer path.

Completed packaging work:

- The broad source/runtime artifact was replaced by an ncc-based runtime
  artifact. It packages the control-plane bundle, project-host bundle, project
  bundle, tools bundles, CLI bundle, Star bootstrap helper bundles, the bundled
  api/v2 route manifest, frontend assets, and required bootstrap support files.
- The ncc runtime artifact keeps the same `cocalc-star-runtime.tar.gz`,
  `STAR_BUILD=0`, and `/opt/cocalc-star/releases/<release-id>` semantics, so
  install, upgrade, rollback, and hard-reset recovery stay on the same operator
  path.
- Full two-release GCE validation passed against the ncc runtime artifacts:
  release A install + smoke, release B upgrade + smoke, rollback to A + smoke,
  hard-reset boot into A + doctor, and final restore to B + doctor.

Remaining packaging work:

- Decide whether to wrap the tarball installer in a `.deb`, apt repository, or
  SEA convenience wrapper. This is packaging ergonomics, not a blocker for the
  core Star appliance contract.
- Add clearer published artifact naming, retention, and checksum/signature
  policy before external distribution.

### Phase 5: SEA Installer

Deliverable:

- `cocalc-star` SEA binary.
- Commands:
  - `install`
  - `status`
  - `logs`
  - `restart`
  - `upgrade`

Status: optional/deferred.

Validation:

- Single binary on fresh Ubuntu can install Star if SEA remains the chosen
  convenience wrapper.
- Current tarball artifact size is already in the same rough range as the old
  SEA target, so SEA should only be pursued if it improves install UX or
  marketplace packaging.
- TARGETS: Linux x86_64 and arm64 as two separate binaries. arm64 matters, e.g., VM's on any macOS machine.

### Phase 6: Developer Source Deploy Lane

Deliverable:

- `cocalc-star dev init-source`.
- `cocalc-star dev build`.
- `cocalc-star dev deploy`.
- `cocalc-star dev rollback`.
- Build fingerprint surfaced in CLI and admin UI.
- Release staging from local source checkout without overwriting the live
  install in place.

Validation:

- Dirty checkout is refused unless explicitly allowed.
- Clean checkout builds and deploys to a new versioned release.
- Failed health check rolls back or leaves the previous release untouched.
- Rollback from a custom build to the prior official release works.
- Reboot after source deploy starts the selected release.

### Phase 7: Marketplace Images

Deliverable:

- Cloud-init or first-boot wrapper.
- Marketplace VM image for one provider first.
- Clear firewall and sizing docs.

Validation:

- Marketplace user can launch VM and get registration link without reading
  source code.

## Testing Plan

Automated:

- Unit tests for Star port-map generation.
- Unit tests for Star resource-budget calculation.
- Unit tests for setup profile gating.
- Integration test for local host row bootstrap.
- Unit tests for source-build release metadata and dirty-check behavior.
- GCE artifact validation via `src/scripts/star/validate-gce-release-upgrade.sh`:
  release A install + smoke, release B upgrade + smoke, rollback smoke,
  hard-reset boot validation, and final restore doctor. Done on an Ubuntu 24.04
  GCE VM.

Manual:

- Fresh Ubuntu 24.04 x86_64 VM.
- Fresh Ubuntu 24.04 arm64 VM if SEA/build supports it. (USER: it definitely does)
- Fresh Ubuntu 26.04 VM should fail early or be explicitly remediated before
  project start if the data path does not support btrfs subvolumes.
- Fresh public VM with ports 80/443 open and Caddy/Let's Encrypt configured.
- Public-URL install using interactive hostname/IP prompt.
- Public-URL install using non-interactive env/CLI input for agents.
- Temporary HTTPS web onboarding page opens before the full install continues.
- Web onboarding page streams install progress and final bootstrap/invite URLs.
- Headless install bypasses web onboarding and still prints deterministic final
  URLs.
- Public HTTPS bootstrap via generated URL.
- SSH-tunnel fallback when public HTTPS setup is skipped or fails.
- Reboot recovery.
- Upgrade/rollback.
- Low-memory pressure behavior.
- Disk-full behavior.
- Admin email disabled.
- Admin email configured.
- Local/LAN-only access.
- Public IP HTTP access.
- Public IP HTTPS access through Caddy.
- `sslip.io`-style hostname behavior when public IP changes.
- Admin invite URL creates a second user without manual token creation.
- Codex subscription-link UI shows immediate loading state and then the code.
- 100-student course:
  - add 100 students,
  - provision projects,
  - assign files,
  - start projects through the bulk queue,
  - verify the browser remains usable throughout.
- Running-project cap:
  - starts above the cap fail or queue with clear status,
  - admin UI/status shows current running count and configured cap,
  - raising the cap displays a usability warning.
- Large-VM exploratory stress test:
  - verify project-host/container capacity separately from interactive hub
    usability,
  - do not treat maximum container count as a V1 product promise.
- Upgrade/restart reconciliation:
  - missing containers are marked stopped,
  - stale active operations and runtime slots are cleared or failed
    deterministically.
- Source checkout build/deploy.
- Source deploy rollback.
- Custom-build fingerprint visible in status/admin UI.

Smoke:

- Create first admin.
- Enable 2FA.
- Create project.
- Start project.
- Open terminal.
- Open Jupyter.
- Build/check LaTeX availability.
- Link Codex subscription and start a minimal Codex interaction.
- Invite second user.
- Second user creates a project.
- First and second user collaborate in one project.
- Stop/start project.
- Reboot VM while project is stopped and while project is running.

## Non-Goals For V1

- Multi-bay.
- External project-host providers.
- Cloudflare.
- Kubernetes.
- High-availability database or even a separate database server.
- Enterprise-grade hostile multi-tenant isolation.
- Automated cross-cloud marketplace publishing.
- Managed service through CoCalc cloud accounts.

## Recommended Next Step

The old recommended next step, "prove the basic appliance on a throwaway Ubuntu
VM", is complete.

Current recommended finish plan for first public release:

1. Make the install command public-release quality:
   - provide one short stable command instead of a long GitHub release URL,
   - keep an explicit release override for agents and internal tests,
   - accept public URL/hostname/IP via env/CLI for agents,
   - prompt interactively only when not provided.
2. Finish public web onboarding:
   - configure Caddy/Let's Encrypt first,
   - print the temporary HTTPS onboarding URL exactly once,
   - explain that failure to open it means port 443/firewall/DNS/public-IP
     exposure is wrong,
   - serve a nonce-protected read-only installer page,
   - make the page plain and installer-like with clear steps, a continue
     button, five-minute estimate, progress bar, and final URLs,
   - support a deterministic headless bypass for agents.
3. Harden install preflight and failure behavior:
   - wait for unattended-upgrades/apt locks with useful progress,
   - preserve or re-enable normal unattended-upgrades behavior after install,
   - support Ubuntu 24.04 as the V1 target,
   - block Ubuntu 26.04/non-btrfs project-host data layouts until they are
     explicitly supported,
   - verify bundle completeness before publishing a release,
   - keep rollback/release-directory restoration on any failure.
4. Make Star usable by a small team immediately:
   - seed the local host as a shared pool host for all accounts,
   - use the official managed Star RootFS for every project creation path,
   - keep the create-project host selector hidden in the Star profile when
     there is only one host,
   - show/copy an invite signup URL without manual admin token creation,
   - make the Codex subscription-link UI show a loading state immediately.
5. Add V1 scale guardrails:
   - implement a global running-project cap,
   - use a conservative default such as `min(100, max(5, floor(RAM_GB * 2)))`,
   - expose the cap and current running count in status/admin UI,
   - throttle course/bulk starts through one server-side queue,
   - make start failures at the cap immediate and understandable,
   - reconcile stale runtime state after upgrade/restart.
6. Validate the first-release story end to end:
   - fresh GCP Ubuntu 24.04 public VM with ports 80/443 open,
   - fresh Lambda Ubuntu 24.04 public VM, including one GPU VM,
   - fresh private VM using SSH tunnel fallback,
   - admin bootstrap, project create/start, terminal, Jupyter, LaTeX,
   - invite second user and collaborate,
   - 100-student course provision/assign/start within the cap,
   - reboot recovery,
   - upgrade and rollback with running-project reconciliation.

Suggested first public-release acceptance criterion:

- A non-developer can create a fresh Ubuntu 24.04 public VM, paste one command,
  open the temporary HTTPS onboarding page, create the first admin account,
  create a project, open terminal/Jupyter/LaTeX, invite one collaborator, and
  keep using the appliance without seeing cloud-provider setup, Launchpad/Rocket
  controls, or unexplained resource-limit failures.

Post-release follow-up:

- Build the local source deploy lane:
  - put a CoCalc checkout on the same VM,
  - build a Star-compatible release from that checkout,
  - deploy it through the same versioned release/rollback mechanism,
  - confirm `star.sh status` reports the custom build fingerprint.
- Decide the external packaging surface:
  - tarball + `install.sh`,
  - `.deb`/apt repository,
  - SEA wrapper,
  - marketplace image.
- Keep using `src/scripts/star/validate-gce-release-upgrade.sh` as the release
  gate for any packaging or installer change.

That proves Star can later become a safe single-VM development and
customer-customization target, but it should not distract from the first public
appliance release.

## Rocket Lifecycle Alignment

The Star release work should directly inform Rocket/multi-bay lifecycle work.
The artifact and rollback contract should be shared as much as possible:

- immutable versioned release directories,
- `current` symlink switch,
- manifest/checksum metadata,
- health/doctor/smoke gates before and after switch,
- first-class rollback,
- separate control-plane and project-host software artifacts,
- automated install/upgrade/rollback/reboot validation.

Rocket adds orchestration complexity rather than a fundamentally different
artifact model: rolling hub-worker upgrades, migration ordering, bay
compatibility checks, project-host fleet rollout policy, and multi-bay routing
must be layered on top of the same boring release mechanics.
