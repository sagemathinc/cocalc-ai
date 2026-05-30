# CoCalc Star Product Plan, 2026-05-30

Status: `draft`

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

Star should reuse the compact Launchpad bundle and SEA machinery, but not the
desktop/local-user defaults. Star is a system appliance, so data/config should
live under `/opt/cocalc/star`, `/var/lib/cocalc/star`, and `/etc/cocalc/star`.

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

## Architecture

Star is:

- one Launchpad-style hub/control-plane process,
- one local project-host daemon stack,
- one local storage root,
- one local database mode,
- systemd-managed services,
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

Suggested filesystem layout:

```text
/opt/cocalc/star/
  current -> releases/<version>
  releases/<version>/
  bin/

/etc/cocalc/star/
  star.env
  star-secrets.env
  project-host.env

/var/lib/cocalc/star/
  launchpad/
  pglite/
  project-host/
  projects/
  rootfs/
  rustic/
  backups/

/var/log/cocalc/star/
```

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

Recommended internal defaults:

| Purpose                           | Bind                     | Port               |
| --------------------------------- | ------------------------ | ------------------ |
| Star public HTTP/reverse proxy    | `0.0.0.0`                | `80`               |
| Star public HTTPS/reverse proxy   | `0.0.0.0`                | `443`              |
| Launchpad/hub HTTP                | `127.0.0.1`              | `9100`             |
| Launchpad SSHD/onprem helper      | `127.0.0.1`              | `9120` or disabled |
| Project-host public ingress       | `127.0.0.1`              | `9200`             |
| Project-host app/upstream         | `127.0.0.1`              | `9201`             |
| Project-host conat-router         | `127.0.0.1`              | `9300`             |
| Project-host conat-persist health | `127.0.0.1`              | `9400`             |
| Project SSH ingress               | `0.0.0.0` or `127.0.0.1` | `2222`             |

Open decision:

- Should V1 include HTTPS automation?

Pragmatic V1 answer:

- Support plain HTTP and private/LAN deployment first.
- Allow operator-provided TLS/reverse proxy later.
- Marketplace images can rely on cloud security-group/firewall and public HTTP
  initially if acceptable.

Better V2:

- Include Caddy or another small reverse proxy for automatic Let's Encrypt when
  a DNS name is provided.
- Keep Cloudflare out of Star V1 to preserve the product promise.

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
- database,
- project-host daemons,
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
  setting, or both?

Recommendation:

- Use membership/runtime-slot limits for actual enforcement.
- Use Star settings for derived defaults and UI display.
- License gates can cap the derived value.

## Storage Model

V1 storage:

- One local filesystem root.
- Btrfs/podman/project-host runtime under `/var/lib/cocalc/star/project-host`
  or `/mnt/cocalc`.
- Rustic backups to local disk by default.

Installer responsibilities:

- Detect whether btrfs is available or create/format a btrfs volume/file-backed
  loop device if that is the chosen project-host requirement.
- Create required Linux users/groups without colliding with existing IDs.
- Validate podman/overlay/btrfs support before starting services.
- Fail early on dirty/non-dedicated machines.

Backup V1:

- "Snapshot the VM/disk" is the primary operational backup story.
- Local rustic backups can be available, but they are not sufficient if the
  whole VM/disk is lost unless copied elsewhere.

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

- Should the installer configure `ufw` automatically?

Recommendation:

- Yes, but only after explicit confirmation.
- Marketplace images can preconfigure provider firewalls instead.

## Packaging Strategy

Milestone 0 should not start with SEA perfection.

Recommended sequence:

1. Build from source on a fresh Ubuntu VM.
2. Write a `star-bootstrap-host.sh` script that mutates the VM and makes it work.
3. Split out a reusable Star systemd scaffold.
4. Build a Star runtime tarball.
5. Wrap the tarball in a SEA installer/launcher.
6. Publish marketplace images only after the script path is boring.

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
4. Default RootFS exists or a bundled default is installed.
5. Smoke-test project starts.

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

Use Rocket-style versioned releases and rollback semantics.

Plan:

- `/opt/cocalc/star/releases/<version>`
- `/opt/cocalc/star/current`
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
   - free/trial cap,
   - paid cap,
   - enforcement location.
3. Public URL/TLS:
   - defer,
   - Caddy,
   - or operator-managed.
4. Email:
   - optional,
   - hidden email-verification UI when disabled,
   - admin password reset links still available.
5. Default RootFS:
   - ship a small prebuilt default,
   - build on first run,
   - or guide admin to create one.
6. Backup:
   - document VM snapshots as V1,
   - or require external backup setup before "ready".
7. Marketplace support level:
   - image only,
   - paid support,
   - or managed updates.

## Implementation Phases

### Phase 1: Prove It Manually On Fresh Ubuntu

Deliverable:

- Documented commands that turn a fresh Ubuntu VM into Star.
- Launchpad hub running under systemd.
- Local project-host running under systemd.
- One local host row healthy.
- Admin registration token printed.
- Project creation/start works.

Validation:

- Fresh VM install.
- Reboot VM and verify services recover.
- Create admin, project, terminal, Jupyter.

### Phase 2: Star Bootstrap Script

Deliverable:

- `src/scripts/star-systemd/` scaffold.
- `star-bootstrap-host.sh`.
- `star-bootstrap-release.sh`.
- Explicit port map.
- Local host registration command/API.

Validation:

- Repeatable clean VM setup.
- Idempotent rerun behavior.
- Clear failure if machine is not suitable.

### Phase 3: Star Setup Profile In UI

Deliverable:

- Setup wizard profile `star-single-vm`.
- No Cloudflare/provider gates.
- Shows local host health, resource budget, rootfs, smoke test, optional email.

Validation:

- Star users never see GCP/Nebius/Cloudflare as required setup.
- Launchpad/Rocket users still see cloud setup.

### Phase 4: Packaged Runtime

Deliverable:

- `packages/star` package or `packages/launchpad` Star build target.
- Runtime tarball includes:
  - control-plane bundle,
  - project-host bundle,
  - bootstrap scripts,
  - systemd scaffold.
- Versioned release install under `/opt/cocalc/star`.

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

### Phase 6: Marketplace Images

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

Manual:

- Fresh Ubuntu 24.04 x86_64 VM.
- Fresh Ubuntu 24.04 arm64 VM if SEA/build supports it.
- Reboot recovery.
- Upgrade/rollback.
- Low-memory pressure behavior.
- Disk-full behavior.
- Admin email disabled.
- Admin email configured.
- Local/LAN-only access.
- Public IP HTTP access.

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
- High-availability database.
- Enterprise-grade hostile multi-tenant isolation.
- Automated cross-cloud marketplace publishing.
- Managed service through CoCalc cloud accounts.

## Recommended Next Step

Create a throwaway Ubuntu 24.04 VM and manually run the smallest version of this
stack:

1. Launchpad under systemd with explicit ports.
2. Project-host daemon under systemd with non-conflicting explicit ports.
3. Manual/local host row registration.
4. One project start.

Only after that works should we introduce `packages/star` or SEA packaging.
