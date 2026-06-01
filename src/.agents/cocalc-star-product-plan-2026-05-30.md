# CoCalc Star Product Plan, 2026-05-30

Status: `active implementation plan`

Implementation status as of 2026-06-01:

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
- The first real upgrade attempt exposed two important release-path bugs:
  root-run upgrades must preserve the existing Star runtime user instead of
  switching to `root`, and failed installs must restore mutable Star service
  config as well as release symlinks. Both are fixed in the current installer.
- Current implementation is still a source/tarball install, not a final
  marketplace image or SEA binary.

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

## Current Validated Implementation

The current working implementation is deliberately simple:

- Build a Star release artifact from a CoCalc checkout.
- The artifact contains `install.sh`, `cocalc-star-src.tar.gz`,
  `release.json`, and `SHA256SUMS`.
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
- Build/cache a default RootFS from `ubuntu:26.04` with Jupyter and LaTeX.
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
- Conservative simultaneous-running-project limit derived from RAM.
- No external project-host creation.
- One local project-host only.

The installer must explicitly warn:

> This machine will be dedicated to CoCalc Star. The installer will create
> users, systemd services, directories, container/runtime state, local database
> state, and firewall/reverse-proxy configuration. Do not run it on a shared
> machine.

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

V1 should include HTTPS automation.

Recommendation:

- Use Caddy or another standard small reverse proxy for automatic Let's Encrypt
  when the admin provides a DNS name that resolves to the VM.
- Keep TLS out of the CoCalc Node.js processes; terminate at the proxy.
- Support LAN/private HTTP as an explicit local-only mode, but do not make
  public remote HTTP the default onboarding path.
- Keep Cloudflare out of Star V1 to preserve the product promise.

Reasoning:

- Remote HTTP-only WebSockets are fragile in real browsers and networks.
- Expecting users to SSH-forward ports to use a shared appliance is not a viable
  product experience.
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
- Max running projects = floor(project memory budget / default per-project
  memory), capped by product/license account limits.

Examples:

| VM RAM | Reserved | Project budget | Default active projects |
| ------ | -------- | -------------- | ----------------------- |
| 16 GiB | 6 GiB    | 10 GiB         | 5                       |
| 32 GiB | 6.4 GiB  | 25.6 GiB       | 12                      |
| 64 GiB | 12.8 GiB | 51.2 GiB       | 25                      |

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
14. Print admin registration link.

The first visible user experience should be:

```text
CoCalc Star is running.

Open this link to create the first admin account:
http://<host>:<port>/auth/sign-up?token=<registration-token>

Admin setup:
- Create account.
- Enable 2FA.
- Optionally configure email.
- Create or import a RootFS.
- Start a smoke-test project.
```

## Star Onboarding UI

Star should have a separate setup profile from Launchpad/Rocket cloud setup.

Hard gates:

1. Admin account exists.
2. Admin has 2FA.
3. Local project-host is healthy.
4. Shared `/scratch` is mounted, bounded, and visible to projects.
5. Default RootFS exists or a bundled default is installed.
6. Smoke-test project starts and can read/write `/scratch`.

Optional:

- Email provider.
- Public URL / TLS.
- External backup target.

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

If public HTTPS is needed, handle it later via:

- operator-provided reverse proxy,
- Caddy/Let's Encrypt,
- marketplace public IP + manual DNS,
- or an optional Star Pro feature.

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
- Tell user: copy this master key and periodically copy this rustic directory somewhere, and that's your backups. Of course restore from master key + rustic must be a part of our workflow and plan. It's important and good to test.

V2:

- Optional external backup target.
- Health check warns if no off-machine backup exists.

### What Makes This Marketplace-Friendly?

Star avoids cloud-specific APIs. Marketplace integration only needs:

- Ubuntu image or install script.
- VM sizing recommendations.
- Firewall/security-group defaults.
- First-boot service that prints or exposes the admin registration link.

This makes AWS/Azure/GCP/Nebius marketplaces all mostly packaging/business work,
not provider feature development.

## Product Decisions Needed

1. Final name:
   - working name: `CoCalc Star`.
   - CLI/package: `cocalc-star`.
2. License/account cap:
   - free/trial cap - 2 accounts,
   - paid cap - 25 accounts,
   - enforcement location - (not sure).
3. Public URL/TLS:
   - defer,
   - Caddy &lt;-- this,
   - or operator-managed.
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
- Smoke after rollback has not yet been run on the full VM.
- Hard reset after rollback starts the selected release. Not yet validated on a
  full VM.

### Phase 3: Star Setup Profile In UI

Deliverable:

- Setup wizard profile `star`.
- No Cloudflare/provider gates.
- Shows local host health, resource budget, rootfs, smoke test, optional email.
- Star installer sets `COCALC_SETUP_PROFILE=star` while preserving
  `COCALC_PRODUCT=launchpad` for existing server/runtime behavior.

Status: initial implementation in progress.

Validation:

- Star users never see GCP/Nebius/Cloudflare as required setup.
- Launchpad/Rocket users still see cloud setup.
- Star setup readiness is derived from admin 2FA, local project-host health,
  and a configured default project image; manual smoke test and backups are
  shown as non-blocking follow-up checks.

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

- Tarball install works without source checkout.
- Upgrade preserves data.

### Phase 5: SEA Installer

Deliverable:

- `cocalc-star` SEA binary.
- Commands:
  - `install`
  - `status`
  - `logs`
  - `restart`
  - `upgrade`

Validation:

- Single binary on fresh Ubuntu can install Star.
- Compressed size target roughly 200 MiB if realistic.
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

Manual:

- Fresh Ubuntu 24.04 x86_64 VM.
- Fresh Ubuntu 24.04 arm64 VM if SEA/build supports it. (USER: it definitely does)
- Reboot recovery.
- Upgrade/rollback.
- Low-memory pressure behavior.
- Disk-full behavior.
- Admin email disabled.
- Admin email configured.
- Local/LAN-only access.
- Public IP HTTP access.
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

Current recommended next step:

1. Automate full-VM two-release validation so it can run regularly:
   - release A installs and passes doctor/smoke,
   - release B installs and passes doctor/smoke,
   - rollback to release A passes doctor/smoke,
   - hard reset after rollback still boots release A.
2. After automated rollback is boring, make the tarball smaller and more release-like so
   installs no longer need a full source build on the target VM.
3. Then build the local source deploy lane:
   - put a CoCalc checkout on the same VM,
   - build a Star-compatible release from that checkout,
   - deploy it through the same versioned release/rollback mechanism,
   - confirm `star.sh status` reports the custom build fingerprint.

That proves Star is not only an appliance, but also a safe single-VM development
and customer-customization target.
