# (wont do) Rootfs Bootstrap Plan

**NOT going to do this, because we should just lean into users explicitly customizing and publishing images from within cocalc itself.**

Goal: support a practical range of glibc-based container images without
requiring every image to already contain the exact CoCalc/Codex runtime
prerequisites.

This is a follow-up track to the Codex runner work, not part of the current
app-server switchover.

## Product Decision

Keep two tiers:

- first-class supported default image:
  - `buildpack-deps:noble-scm`
  - chosen because it is an official Docker image and already includes key
    basics such as `git`, `curl`, and `ca-certificates`
- experimental compatibility path:
  - arbitrary glibc images
  - bootstrapped on first use
  - fail fast with a clear `image not supported` error if bootstrap cannot make
    them usable

This avoids pretending that every random image is already ready for Codex, git,
TLS, terminals, and other CoCalc runtime expectations.

## Why Bootstrap

Mounting a few host files into arbitrary images is not enough.

What we already observed:

- missing `ca-certificates` can break Codex even when basic networking works
- a bare image may also lack tools like `git`, `curl`, `ps`, or shell
  conveniences that CoCalc and Codex expect
- trying to special-case all of this with mounts becomes brittle quickly

So the compatibility layer should be:

- explicit
- idempotent
- cached
- capability-based

## Cache Model

Do not key bootstrap only by project-local sentinel state.

Prefer a host-level cache keyed by:

- base image digest
- bootstrap script version/hash
- optional architecture / platform

Output:

- a derived, bootstrapped local image or rootfs artifact

That means:

- the first project using an image pays the bootstrap cost
- later projects on the same host reuse the derived artifact
- changing the base image or bootstrap logic naturally invalidates the cache

Future extension:

- store/share these derived rootfs artifacts across hosts, e.g. as btrfs send
  streams on R2

## Bootstrap Execution Model

Recommended flow:

1. Resolve and pull the requested base image.
2. Compute bootstrap cache key from `(image digest, bootstrap version)`.
3. If cached derived artifact exists, use it immediately.
4. Otherwise run a one-shot bootstrap container/rootfs mutation pass.
5. Commit/cache the bootstrapped result.
6. Use that result for project startup.

This is better than re-running package-manager setup on every project start.

## Bootstrap Script Requirements

The script should be:

- POSIX `sh`, not bash-specific
- idempotent
- small and auditable
- strict about failure

Detect one of:

- `apt-get`
- `dnf`
- `yum`
- `zypper`

Install only hard prerequisites, not the entire world.

Initial target set:

- `ca-certificates`
- `curl` or `wget`
- `git`
- `procps` / `ps`
- `tar`
- `gzip`
- `xz`
- `unzip`
- basic shell/coreutils expectations

Optional later additions can be versioned separately.

## Failure Policy

If bootstrap cannot establish a usable runtime, stop early and tell the user:

- `image not supported`

Examples:

- no supported package manager
- package manager unavailable due to permissions
- bootstrap dependency install fails
- image is not glibc-based and current runner assumptions do not hold

This is better than starting a project that appears to work but fails later in
hard-to-debug ways.

## Sentinels

If a project-local sentinel is used at all, it should be secondary metadata,
not the primary cache key.

If present, it should include at least:

- bootstrap version
- base image digest
- timestamp

But the authoritative reuse mechanism should still be the host-level cached
derived artifact.

## Relationship To Codex Runner Work

This bootstrap track exists to make the project runtime reliably usable for the
app-server-based Codex runner and the general Launchpad developer experience.

It should be revisited after:

- project-container app-server execution is fully locked down
- auth strategy is settled
- remaining ACP lifecycle hardening is done