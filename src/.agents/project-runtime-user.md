# Project Runtime User Migration Plan

Last refreshed: April 2, 2026

Status: phases 0-5 are substantially implemented for launchpad dev hosts.
The remaining work is rollout validation, final `/root` compatibility cleanup,
and RootFS normalizer hardening/performance work.

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

OCI images will vary widely:

- some define `USER root`
- some define another user
- many have no `user` account at all
- some are extremely minimal and omit basic admin/user-management tooling

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
- RHEL-compatible images
- SLES-compatible images
- language-toolchain images
- custom OCI images that meet the CoCalc contract

### Rootfs Contract

This is the concrete minimum contract for a RootFS image to be considered
usable for CoCalc interactive projects.

#### Hard Requirements

- Linux userspace with `glibc`
- a working `node` runtime compatible with the project bundle
- writable `/etc`
- writable `/home`
- writable `/tmp`
- writable `/var/tmp`
- a shell available at `/bin/bash` or `/bin/sh`
- CA certificates installed and usable for TLS
- a functioning `user` account with:
  - username `user`
  - uid `1000`
  - gid `1000`
  - home `/home/user`
- passwordless `sudo` for `user`
- NSS identity lookups for `user` must work
  - `getent passwd user` or equivalent lookup behavior
  - `id user` must succeed
- the image must tolerate running the main project workload as uid/gid `1000`
- the image must tolerate explicit privileged commands through `sudo`

#### Nice-To-Have But Not Required

- `curl`
- `git`
- `procps`
- `psmisc`
- distro package manager metadata already initialized

These are useful for product quality, but only `sudo`, CA certs, and the
runtime user are part of the core contract.

#### Explicitly Unsupported

- musl-only images such as Alpine
- distroless images with no package/user-management tooling
- images where `/etc` or `/home` cannot be modified during normalization
- images where `sudo` cannot be installed or configured
- images where uid/gid `1000` is fundamentally incompatible with the runtime

Rationale:

- CoCalc already ships a glibc-based Node runtime
- scientific/computing images are overwhelmingly Debian/Ubuntu/RHEL/SLES-like
- compatibility and predictability matter more than minimal image size

### Rootfs Normalization Policy

We should go all-in on one-time RootFS normalization now.

The normalization step runs once when an image is first accepted into CoCalc as
a usable RootFS. It is not a per-project startup action.

The normalized RootFS must satisfy the contract above before any project is
allowed to use it.

#### What Normalization Must Do

Normalization must, at minimum:

- ensure `user` exists with uid/gid `1000`
- ensure `/home/user` exists and is owned by `1000:1000`
- ensure `sudo` is installed
- install a passwordless sudoers entry for `user`
- ensure CA certificates are present and initialized
- optionally install `curl` if we decide it is part of the launchpad baseline
- validate the result with explicit checks

Minimum post-normalization validation:

- `id user`
- `getent passwd user` or a robust fallback check
- `su - user -c 'whoami'` returns `user`
- `su - user -c 'echo $HOME'` returns `/home/user`
- `su - user -c 'sudo -n true'` succeeds
- `node -e 'console.log(process.getuid())'` can run in the image
- TLS validation works using system CA certs

If any of these fail, the image is rejected as unusable for CoCalc.

#### Supported Distro Families

The normalizer should explicitly support:

- Debian / Ubuntu
- RHEL / Rocky / Alma / Fedora / UBI
- SLES / openSUSE Leap

Detection should be by `/etc/os-release` plus package-manager presence.

Initial package-manager support:

- `apt-get`
- `dnf`
- `yum`
- `microdnf`
- `zypper`

If no supported family is detected, the image is rejected.

### Normalization Script Requirements

The normalization script should be:

- minimal
- deterministic
- idempotent when run on a fresh or already-normalized image of the same
  contract version
- conservative about what it installs

It should not:

- do full system upgrades
- replace arbitrary base packages
- rewrite unrelated config files
- depend on project-specific state

It is acceptable to install only the smallest set of packages needed to meet
the contract.

### Mutation Policy

This is the one place where the product needs to be opinionated.

The normalizer is allowed to mutate the image snapshot that CoCalc has decided
to use as the RootFS lower layer. It is not required to preserve a pristine
"original upstream image" if doing so would create substantial storage or
performance overhead.

What must be true:

- normalization happens before the image is put into use by projects
- once a normalized RootFS is in use as a lower layer, we do not re-run the
  rootfs normalizer in place
- if the contract ever changes later, that must be handled by:
  - a new normalized RootFS version for future projects, or
  - a separate runtime migration step executed inside projects that already
    depend on the old lower layer

This avoids breaking existing overlays while still allowing us to keep the
normalization path simple and fast.

### Versioning Rule

The RootFS normalizer must have its own explicit version, for example:

- `rootfs_normalizer_version = 1`

That version becomes part of the meaning of a cached/managed RootFS.

If the normalizer changes incompatibly in the future:

- do not re-run it against already-in-use RootFS lower layers
- instead produce a new managed RootFS version for new projects
- use explicit per-project startup migrations only for additive follow-up fixes
  that are safe on an existing overlay

This is the key rule that keeps future changes from corrupting old projects.

## SSH Model

The runtime SSH model is now implemented around `/home/user/.ssh`.

Under the new model:

- the SSH daemon may still start as root
- the login shell should land as `user`
- authorized keys should be managed for `/home/user/.ssh`

Implemented in:

- [startup-scripts.ts](/home/wstein/build/cocalc-lite2/src/packages/project-runner/run/startup-scripts.ts)
- project SSH settings and authorized-key plumbing

## Codex / Agent Model

Coding agents should run as `user` by default.

This is one of the strongest reasons to make the change:

- many dev tools behave better under a normal user
- `sudo` becomes explicit and auditable
- config/state under `~/.codex`, `~/.config`, `~/.npm`, `~/.cargo`, etc. end
  up in a normal-looking home directory

Implemented / verified:

- [codex-project.ts](/home/wstein/build/cocalc-lite2/src/packages/project-host/codex/codex-project.ts)
  now uses `/home/user` as the canonical runtime home
- PATH bootstrapping now prefers `/home/user/.local/bin`
- shared Codex auth/config mounts work with the runtime user change
- Codex runs successfully in launchpad projects with `HOME=/home/user`

## Frontend Semantics

The frontend now prefers explicit runtime capabilities instead of assuming
launchpad projects live under `/root`.

Instead it should rely on capabilities:

- `homeDirectory`
- `runtimeUser`
- `sudoAvailable`

Areas audited / updated:

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

Introduce a one-time RootFS normalization step that guarantees the existence
of:

- `user`
- `/home/user`
- passwordless sudo

Deliverables:

- rootfs normalizer that enforces the RootFS contract before an image is
  accepted for project use
- explicit validation against OCI images without a preexisting `user`
- package-manager support for the supported distro families
- clear rejection of unsupported images

Status:

- complete for supported launchpad RootFS flows

### Phase 2: Container Launch Semantics

Switch the actual project container runtime from:

- `--user 0:0`
- `HOME=/root`

to the new model based on the preferred ownership mapping strategy.

Deliverables:

- validated Podman idmap / keep-id configuration
- no recurring recursive `chown`
- project processes run as `user`
- a temporary compatibility path for images that are already normalized and in
  use

Status:

- complete for greenfield launchpad projects; still being exercised across
  more images

### Phase 3: SSH and Runtime Cleanup

Redesign SSH/bootstrap scripts so that:

- the daemon can still start correctly
- login lands as `user`
- SSH keys live under `/home/user/.ssh`

Status:

- complete for launchpad dev hosts

### Phase 4: Frontend Path Migration

Audit and update all user-facing path defaults:

- explorer
- flyouts
- copy-path UI
- workspaces
- app-server presets
- agent defaults

Status:

- substantially complete; remaining work is final compatibility cleanup and
  regression testing

### Phase 5: Codex / Agent Migration

Move Codex defaults from `/root` to `/home/user`:

- runtime home
- mounted auth/config paths
- default working directory
- PATH assumptions

Status:

- complete for launchpad dev hosts

### Phase 6: File and Permission UX

Make normal file operations reflect normal-user semantics:

- no silent elevation
- clear errors for privileged paths
- optional future explicit elevated-edit workflow

Status:

- core runtime semantics are complete; explicit elevated-edit UX remains out
  of scope

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

Status:

- in progress

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

### RootFS Normalization

- a supported Debian-family image normalizes successfully
- a supported RHEL-family image normalizes successfully
- a supported SLES-family image normalizes successfully
- an Alpine/musl image is rejected clearly
- an image without a supported package manager is rejected clearly
- rerunning the normalizer on an already-normalized image is idempotent
- already-in-use normalized lower layers are not mutated by later contract
  changes

## Remaining Follow-Up Work

The user-facing runtime migration is working. The remaining work is mostly
around RootFS normalization quality and rollout confidence, not the core
runtime model.

### 1. Broaden the normalization matrix

Test the normalizer on more than current Ubuntu OCI images, including:

- older Ubuntu releases
- Debian
- RHEL / Rocky / Alma / UBI
- SLES / openSUSE

This should produce a small compatibility matrix of known-good and
known-rejected images.

### 2. Reject obviously unsupported images early

We already reject unsupported images during normalization, but we should add
earlier cheap checks when possible, especially for:

- musl / Alpine-style images
- images without a supported package manager

The goal is to fail quickly before an expensive normalization attempt.

### 3. Profile and reduce normalizer cost

Normalization currently dominates startup time for some small images. We need
to answer, with measurements, whether the current package-manager-based
approach is the minimum safe option or whether some work can be replaced with
direct file edits for already-compatible images.

This should explicitly check:

- whether any recursive ownership or mode rewrites scale poorly on large images
- whether the slow path is package-manager I/O, ownership remap, validation, or
  all three
- whether a safe fast-path exists for images that already satisfy most of the
  contract

### 4. Improve normalization progress reporting

If normalization remains materially slower than pull/extract, startup progress
needs better detail so users understand what is happening.

At minimum we should surface:

- package-manager update/install stage
- ownership remap stage
- validation stage
- whether the image was already normalized or required the full slow path

### 5. Harden shell-based validation in the wrapper

One remaining field issue was:

- `rootfs contract failed: sudo su is not working for user environment: line 21: pop_var_context: head of shell_variables not a function context`

This needs a focused wrapper fix so validation does not depend on fragile shell
invocation details across images.

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
