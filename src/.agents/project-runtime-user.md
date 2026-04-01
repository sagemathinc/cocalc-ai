# Project Runtime User Migration Plan

Last refreshed: March 31, 2026

Status: phase 0 complete; phase 1/2 implementation in progress

This document is the concrete plan for changing launchpad project runtimes from
the current:

- default interactive user: `root`
- home directory: `/root`

to the target model:

- default interactive user: `user`
- home directory: `/home/user`
- explicit privilege escalation via passwordless `sudo`

The intent is to make CoCalc AI projects feel normal to users and coding
agents, while preserving the parts of the control plane that legitimately need
root.

## Executive Summary

I recommend that launchpad projects move to a non-root default user now, while
this is still effectively greenfield.

The main reason is not container security. In a rootless Podman setup, `root`
inside the container is less alarming than on a VM. The real problem is product
behavior:

- many programs behave differently or refuse to run as `root`,
- tutorials and upstream docs assume a normal user plus `sudo`,
- coding agents are more likely to make sensible choices in a normal-user
  environment,
- `/root` as the canonical "my files" directory feels strange to users.

However, this is a real platform change, not a one-line tweak. The codebase
currently assumes `/root` and uid `0` in multiple subsystems, including:

- [podman.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/podman.ts)
- [sandbox-exec.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/sandbox-exec.ts)
- [startup-scripts.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/startup-scripts.ts)
- [home-directory.ts](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/home-directory.ts)
- [codex-project.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/codex/codex-project.ts)

The migration is still worth doing, but only if treated as a deliberate runtime
model change.

## Recommended Decision

Adopt this model for launchpad projects:

- user-facing shells, terminals, editors, Jupyter kernels, app servers, and
  coding agents run as `user`
- the canonical home directory is `/home/user`
- `user` has passwordless `sudo`
- the platform still uses root in narrowly-scoped places:
  - host-side bootstrap and runtime wrappers
  - container startup/setup work that must run as root
  - explicit in-container privileged commands

### Explicit Non-Goals

This plan does not aim to:

- remove root entirely from the system
- silently auto-elevate ordinary file browser writes
- respect arbitrary OCI image `USER` directives as the main runtime user
- keep `/root` as the primary home path

## Why This Change Is Worth It

### Benefits

- Better compatibility with real software
  - `postgres` is the obvious example
  - package managers, language toolchains, and daemons often dislike `root`
- Better agent ergonomics
  - agents default to least privilege
  - `sudo` becomes an explicit signal of system-level intent
- Better user expectations
  - "my files" under `/home/user`
  - ordinary commands behave more like a local Linux machine
- Better product parity
  - [https://cocalc.com](https://cocalc.com) already uses `user`

### Costs

- many runtime paths currently assume `/root`
- Codex and app-server defaults assume `/root`
- SSH and startup scripts assume `/root/.ssh`
- copy-path and frontend path defaults assume `/root`
- file ownership semantics become a first-class design question

## Current State

### Current Container Runtime Assumptions

The project runtime currently makes an explicit choice to run containers as
root:

- [podman.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/podman.ts)
  - sets `HOME: "/root"`
  - uses `--user 0:0`

Sandbox and helper execution also assume `/root`:

- [sandbox-exec.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/sandbox-exec.ts)

Startup scripts assume root-owned SSH configuration:

- [startup-scripts.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/startup-scripts.ts)

The frontend assumes launchpad home is `/root`:

- [home-directory.ts](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/home-directory.ts)

Codex integration is heavily root-oriented:

- [codex-project.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/codex/codex-project.ts)

### Current Rootfs / Overlay Layout

Writable rootfs overlay state is stored relative to the project home directory:

- [rootfs.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/rootfs.ts)
- [defaults.ts](/home/wstein/build/cocalc-lite2/src/packages/util/db-schema/defaults.ts)

Today that effectively means:

- `/root/.local/share/cocalc/rootfs/...`

Under the new model, this should become:

- `/home/user/.local/share/cocalc/rootfs/...`

That is a good fit conceptually, but it means file ownership and mount
semantics must be correct for the new user.

## Target Runtime Model

### Canonical User Model

Every launchpad project runtime should expose:

- username: `user`
- uid: `1000`
- gid: `1000`
- home directory: `/home/user`
- default shell: `/bin/bash` if available, otherwise `/bin/sh`
- passwordless `sudo`

The platform should expose these as project capabilities so the frontend and
automation stop inferring them from `/root`.

Recommended capability fields:

- `homeDirectory: "/home/user"`
- `runtimeUser: "user"`
- `runtimeUid: 1000`
- `runtimeGid: 1000`
- `sudoAvailable: true`

### Process Model

These should run as `user` by default:

- interactive terminal sessions
- Jupyter kernels
- file browser initiated commands
- app servers
- Codex / agent processes
- `sandboxExec` default path

These may still run as root:

- container init/setup phase
- SSH server startup
- explicit privileged platform helper commands
- explicit `sudo ...` requested by the user or an agent

### Permission Model

The default behavior should be ordinary Unix behavior:

- writing files in `/home/user` and `/scratch` works normally
- writing privileged files such as `/etc/bash.bashrc` fails unless the command
  is explicitly elevated
- the file browser/editor must not silently save privileged files as root

This is important for product trust. A normal UI save should never secretly
become a privileged write.

## Critical Design Choice: Ownership Mapping

This is the most important technical issue in the migration.

The goal is:

- user-visible files should appear owned by `user` inside the container
- host-side project storage must remain manageable by the project-host service
- the platform must avoid recursive ownership rewrites on every startup

### Preferred Approach

Use a rootless Podman user namespace mapping that makes the host service uid
appear as container uid `1000`, then run the project container as `1000:1000`.

In practice this likely means some flavor of:

- `--userns=keep-id:uid=1000,gid=1000`
- plus `--user 1000:1000`

The exact Podman spelling and compatibility need validation on the project-host
images we deploy.

Why this is preferred:

- avoids recursive `chown`
- keeps host storage owned by the service account
- makes container-visible file ownership look normal
- preserves explicit root inside the container when needed via `sudo`

### Fallback Approach

If the idmap / keep-id approach is not robust enough across our kernels and
hosts, the fallback is:

- perform a one-time ownership initialization for new project volumes
- never perform recursive ownership changes on every project startup

This is less attractive and should be avoided if possible, but it is still far
better than per-start recursive `chown`.

### Things We Should Not Do

- do not leave the project tree effectively root-owned inside the container
  while only changing the shell prompt to `user`
- do not add recurring recursive `chown -R` at startup
- do not silently run editor writes as root

## OCI Image Strategy

OCI images will vary wildly:

- some define `USER root`
- some define another user
- many have no `user` account at all

CoCalc should standardize the interactive runtime user regardless of image
defaults.

### Recommended Policy

Ignore the image's default `USER` for the normal interactive experience and
always present:

- username `user`
- home `/home/user`

This keeps the product consistent across:

- Ubuntu-style images
- Debian-style images
- language-toolchain images
- custom OCI images

### Account Bootstrap Requirements

For images that do not already define `user`, startup must ensure:

- `/home/user` exists
- `/etc/passwd` contains a `user` entry
- `/etc/group` contains a `user` group
- `sudo` is configured for passwordless elevation for `user`
- ownership and writable paths are correct for `user`

This should happen during controlled runtime setup, not by asking end users to
repair their image.

The preferred implementation is to materialize these changes in the writable
overlay, not mutate the shared base image.

## SSH Model

The current startup path assumes `/root/.ssh` and root-managed SSH config.

Under the new model:

- the SSH daemon may still start as root
- the login shell should land as `user`
- authorized keys should be managed for `/home/user/.ssh`

This means [startup-scripts.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/startup-scripts.ts)
must be redesigned rather than superficially edited.

## Codex / Agent Model

Coding agents should run as `user` by default.

This is one of the strongest reasons to make the change:

- many dev tools behave better under a normal user
- `sudo` becomes explicit and auditable
- config/state under `~/.codex`, `~/.config`, `~/.npm`, `~/.cargo`, etc. end
  up in a normal-looking home directory

Implications:

- [codex-project.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/codex/codex-project.ts)
  needs a full `/root` to `/home/user` audit
- PATH bootstrapping must prepend `/home/user/.local/bin`
- shared Codex auth and mounts must remain secure when the runtime user changes

## Frontend Semantics

The frontend should stop assuming `/root` for non-lite projects.

Instead it should rely on capabilities:

- `homeDirectory`
- `runtimeUser`
- `sudoAvailable`

Areas that need auditing:

- [home-directory.ts](/home/wstein/build/cocalc-lite2/src/packages/frontend/project/home-directory.ts)
- path normalization and explorer defaults
- copy-path defaults and destination normalization
- workspace process summaries
- app-server presets
- new-thread / agent default working directories

### File Browser and Editor Semantics

Recommended behavior:

- `Home` means `/home/user`
- opening `/etc/...` is allowed if readable
- saving `/etc/...` as a normal browser action should fail with a normal
  permission error
- later, we may add explicit elevated editing, but not as part of this
  migration

This avoids surprising privilege escalation in the UI.

## Backups, Rootfs Overlay, and Storage

The project home tree and overlay state should move from:

- `/root/...`

to:

- `/home/user/...`

This includes:

- home files
- `.local/share/cocalc/rootfs`
- per-user caches
- Codex state

The recent overlayfs xattr work remains compatible with this migration, but the
mount path and ownership assumptions must change together.

## Concrete Migration Phases

### Phase 0: Capability Plumbing

Add explicit runtime user/home capability fields and make the frontend prefer
them over hardcoded `/root`.

Deliverables:

- backend capability fields for home/user/sudo
- frontend home-directory lookup no longer hardcodes non-lite `/root`
- tests for path normalization against `/home/user`

Status:

- complete

### Phase 1: Runtime Account Bootstrap

Make project startup guarantee the existence of:

- `user`
- `/home/user`
- passwordless sudo

Deliverables:

- startup/setup code that materializes the runtime account in the writable
  overlay when needed
- explicit tests against OCI images without a preexisting `user`

Status:

- in progress

### Phase 2: Container Launch Semantics

Switch the actual project container runtime from:

- `--user 0:0`
- `HOME=/root`

to the new model based on the preferred ownership mapping strategy.

Deliverables:

- validated Podman idmap / keep-id configuration
- no recurring recursive `chown`
- project processes run as `user`

Status:

- in progress

### Phase 3: SSH and Startup Scripts

Redesign SSH/bootstrap scripts so that:

- the daemon can still start correctly
- login lands as `user`
- SSH keys live under `/home/user/.ssh`

### Phase 4: Frontend Path Migration

Audit and update all user-facing path defaults:

- explorer
- flyouts
- copy-path UI
- workspaces
- app-server presets
- agent defaults

### Phase 5: Codex / Agent Migration

Move Codex defaults from `/root` to `/home/user`:

- runtime home
- mounted auth/config paths
- default working directory
- PATH assumptions

### Phase 6: File and Permission UX

Make normal file operations reflect normal-user semantics:

- no silent elevation
- clear errors for privileged paths
- optional future explicit elevated-edit workflow

### Phase 7: Rollout

Recommended rollout order:

1. feature flag on dev hosts only
2. new fresh projects first
3. targeted real workloads
   - PostgreSQL
   - apt-based installs
   - pnpm / node builds
   - Codex
   - Jupyter
4. only then broader rollout

Because this is still greenfield, it is acceptable to avoid in-place migration
for older dev projects and instead reprovision or recreate them.

## Test Matrix

The following must pass before switching the default:

### Basic Runtime

- `whoami` returns `user`
- `echo $HOME` returns `/home/user`
- `pwd` after login lands in `/home/user`

### Sudo / Privilege

- `sudo -n true` succeeds
- `sudo apt-get update` works
- `sudo` writes to `/etc/...` work

### Software Compatibility

- PostgreSQL can initialize and run without patching around `root`
- pnpm-based CoCalc builds work
- Python package installs work
- app servers work

### Frontend / File UX

- explorer `Home` opens `/home/user`
- copy-path defaults use `/home/user`
- editing `/etc/bash.bashrc` fails normally without elevation
- no UI path still assumes `/root`

### Coding Agent UX

- Codex runs with `HOME=/home/user`
- agent-created files are owned by `user`
- agent `sudo` actions work when explicit

### Storage / Overlay

- rootfs overlay state lands under `/home/user/.local/share/cocalc/rootfs`
- backups and restores preserve overlayfs xattrs
- disk usage surfaces still classify `Home`, `Scratch`, and `Environment`
  correctly

## Open Questions

### 1. Exact Podman User Namespace Configuration

The preferred solution is clear in spirit, but the exact supported Podman flags
must be validated on our deployment kernels and images.

### 2. Best Way To Materialize `user`

We need to decide whether account bootstrap is done by:

- overlaying generated passwd/group/sudoers files
- running a root setup step inside the container
- or another minimal mechanism

### 3. SSH Product Surface

We should decide whether the UI should expose:

- only normal `user` shells
- or also an explicit "root shell" affordance

My recommendation is:

- default to `user`
- keep root available only through explicit elevation

### 4. Backward Compatibility Window

We should decide whether to carry temporary `/root` compatibility shims for:

- frontend path normalization
- Codex home fallback
- app presets

My recommendation is:

- keep them minimal and temporary
- avoid building new behavior on top of `/root`

## Recommendation Summary

The recommended end state is:

- default runtime user: `user`
- default home: `/home/user`
- passwordless `sudo`
- root retained for explicit privileged operations
- no silent elevation in the UI
- no recurring recursive ownership changes

This is the right product direction, and now is the right time to do it.

The main technical challenge is not shell UX; it is ownership mapping between
host-side project storage and a normal in-container user. That is the design
point that must be solved cleanly before implementation.
