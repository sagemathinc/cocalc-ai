# CoCalc Star Docker Preview Spec

Date: 2026-06-18

## Goal

Provide a one-command Docker-based way to try CoCalc Star without creating a
VM, cloud marketplace instance, or full production install.

This is a preview/evaluation appliance, not the preferred production
deployment target. The purpose is to let a user quickly see the Star product
experience, create projects, run notebooks/terminals, and evaluate the admin
UI. If they like it, steer them to the normal VM, marketplace, or supported
self-host install.

## Non-Goals

- Do not present privileged Docker as a production security boundary.
- Do not split Star into a multi-container Compose architecture for the first
  version.
- Do not support Docker Desktop on macOS/Windows as a first-class target until
  nested cgroups and podman behavior are proven.
- Do not proxy project data through the hub just because the system is running
  in Docker. Project traffic should still use the Star/project-host path.

## Supported Host Matrix

Initial supported target:

- Ubuntu Linux host.
- Docker Engine, rootful mode.
- cgroup v2 enabled.
- Host allows privileged containers.
- Enough memory and disk for Star plus project containers.

Explicitly best-effort or unsupported initially:

- Docker Desktop on macOS.
- Docker Desktop on Windows/WSL.
- Rootless Docker.
- Locked-down Linux hosts that block cgroup delegation, nested containers,
  kernel keyrings, loop devices, or required mounts.

## User Experience

Primary command should be close to:

```bash
docker run --privileged \
  --cgroupns=host \
  --security-opt seccomp=unconfined \
  --tmpfs /run \
  --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v cocalc-star-data:/var/lib/cocalc \
  -p 443:443 \
  cocalc/star:preview
```

Optional constrained preview:

```bash
docker run --privileged \
  --cgroupns=host \
  --security-opt seccomp=unconfined \
  --memory=16g \
  --cpus=8 \
  --tmpfs /run \
  --tmpfs /run/lock \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  -v cocalc-star-data:/var/lib/cocalc \
  -p 443:443 \
  cocalc/star:preview
```

The container should print a clear startup banner with:

- URL to open.
- Admin/bootstrap credential instructions.
- Whether project cgroup limits are enabled.
- Whether nested project containers are enabled.
- Persistent data volume path/name.
- A warning that this is a privileged preview appliance.

## Architecture

Use one large appliance image.

Inside the container:

- systemd runs as PID 1.
- CoCalc Star services run under systemd.
- Local Postgres runs inside the appliance.
- Star hub/control services run inside the appliance.
- The project-host service runs inside the appliance.
- Project workloads still run as nested podman containers.
- Persistent state lives under `/var/lib/cocalc`.

The Docker image should be built from the same artifacts used by Star/Launchpad
where possible, rather than creating a separate snowflake install path.

## Cgroups And Project Isolation

This mode should fully use cgroups for project resource accounting when the
host supports it.

Expected model:

- The outer Docker container owns the appliance runtime.
- The outer container may itself have an overall memory/CPU cap.
- Inner project podman containers are placed in cgroups below the appliance.
- Project memory, CPU, and PID limits are enforced using cgroup v2.
- Project-to-project isolation comes from the existing project container
  boundary plus per-project cgroups.

Important distinction:

- Project-to-project isolation can be meaningful.
- Outer Docker-to-host isolation is weak because the appliance is privileged.

The UI and logs must not imply that `docker run --privileged` is equivalent to a
VM security boundary.

## Preflight Requirements

On startup, run a preflight before starting the hub/project-host stack.

Required checks:

- Process 1 is systemd.
- cgroup v2 is mounted.
- `/sys/fs/cgroup` is writable enough for systemd and nested podman.
- The container has the capabilities needed by podman/project containers.
- Podman can start a trivial nested container.
- Memory cgroup control is available.
- PID cgroup control is available.
- CPU cgroup control is available.
- Required filesystem features are available for the selected storage mode.
- Persistent volume `/var/lib/cocalc` is writable.

Preflight outcomes:

- `ok`: start Star normally.
- `degraded`: start only if the missing feature is explicitly allowed by an
  environment variable such as `COCALC_STAR_DOCKER_ALLOW_DEGRADED=1`.
- `failed`: refuse to start and print concrete remediation instructions.

Do not silently disable project limits.

## Storage

Persist all durable state in:

```text
/var/lib/cocalc
```

The image should tolerate this being:

- A Docker named volume.
- A bind mount on an ext4/xfs/btrfs filesystem.

Avoid depending on Docker overlayfs for durable project data. If loopback btrfs
is used inside the appliance, document the tradeoff clearly and validate it in
preflight.

Backups/snapshots for preview mode can be local-only initially, but the UI
should make it clear that production backup configuration is separate.

## Networking

Minimum preview networking:

- Expose HTTPS on container port 443.
- Support localhost/self-signed mode for first boot.
- Support a configured external hostname if provided.

Optional later:

- Managed Cloudflare tunnel mode.
- Local HTTP port for development-only quickstart.

Project app/server proxy and project-host browser traffic should follow the
same project-host data-plane model as normal Star where practical.

## Image Build

Add a build target for a Star Docker preview image.

Expected outputs:

- `cocalc/star:preview` local image.
- Optionally a pushed image under the existing software artifact system.

Image contents:

- Base OS with systemd support.
- CoCalc Star runtime artifacts.
- Node runtime.
- Postgres.
- podman and required container networking/storage helpers.
- bootstrap/preflight scripts.
- A default systemd unit graph for Star services.

The build should be reproducible from repo artifacts and should record:

- Git revision.
- Dirty state.
- Build timestamp.
- Star artifact versions included.

## Configuration

Primary configuration should be environment variables plus persistent state.

Useful variables:

- `COCALC_STAR_HOSTNAME`
- `COCALC_STAR_ADMIN_EMAIL`
- `COCALC_STAR_DOCKER_ALLOW_DEGRADED`
- `COCALC_STAR_INITIAL_PASSWORD` or bootstrap-token alternative
- `COCALC_STAR_PROJECT_MEMORY_DEFAULT`
- `COCALC_STAR_PROJECT_MEMORY_MAX`
- `COCALC_STAR_PROJECT_CPU_DEFAULT`

Avoid requiring users to hand-edit files inside the container for first boot.

## CLI And Docs

Add a documented command or script such as:

```bash
cocalc star docker run-preview
```

or a generated one-liner in docs.

Documentation must clearly state:

- This is preview/evaluation mode.
- It requires privileged Docker.
- It is supported first on native Linux.
- Persistent data is in the Docker volume.
- How to stop/start/remove the preview.
- How to export data or migrate to a real Star install.

## Validation Plan

Automated smoke on a native Linux CI/VM:

1. Build the image.
2. Run the container with the documented flags.
3. Wait for preflight and Star health to pass.
4. Create a project.
5. Open a terminal.
6. Run a memory-limit test and verify project cgroup enforcement.
7. Start two projects and verify separate cgroups.
8. Restart the Docker container and verify project/data persistence.
9. Stop/remove the container without deleting the volume, then recreate it and
   verify data remains.

Manual validation:

- Browser first-run flow.
- Admin login/setup.
- Notebook kernel start.
- Terminal start.
- Project stop/start.
- Project memory limit UI behavior.
- Clear warning messaging about privileged preview mode.

## Open Questions

- Should preview use `--cgroupns=host`, or can we support a safer private
  cgroup namespace with explicit delegation on current Docker releases?
- Should the first image use the same Star bootstrap scripts as VM installs or
  a container-specific bootstrap path? (ANS: we have a new "rootfs recipe" cli subcommand -- see src/packages/rootfs-recipes which should likely be used INSTEAD of what we do now; it's more flexible and easy to maintain!)
- Do we want Cloudflare tunnel support in v1, or keep v1 localhost/explicit
  hostname only?  (ANS: v1 localhost only; not cloudflare tunnel; it should be like the lima version)
- How much migration tooling is needed before public preview?   (ans: none)
- Should the image be published publicly, or generated locally by the CLI first?  (ans: I think public is fine, but we should have a candidate tag before a stable or whatever tag.  NO need to keep anything secret.)

## Acceptance Criteria For V1

- One documented Docker command starts Star on a supported Linux host.
- Startup fails loudly when project cgroup enforcement cannot work.
- At least one project can start and run a terminal/notebook.
- Project memory limits are enforced by cgroups.
- Two projects run in separate cgroups.
- Data persists across container restart.
- Docs label the mode as privileged preview/evaluation, not production.

