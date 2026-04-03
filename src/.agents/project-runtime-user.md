# Launchpad Runtime User Design Note

Last refreshed: April 2, 2026

Status: accepted direction for the next implementation pass.

This note replaces the earlier plan that favored heavy RootFS normalization,
ownership remapping, and a fully prepared `user` runtime before project
startup. That approach did prove the product goal is viable, but it also
introduced too much complexity into a security-sensitive layer.

The new preferred design is simpler:

- start the container as root
- perform a minimal first-start initialization inside the container
- create or repair the standard runtime user
- drop privileges to that user
- run the project runtime there

The interactive environment still becomes:

- username: `user`
- uid: `2001`
- gid: `2001`
- home: `/home/user`
- privilege escalation: passwordless `sudo`

The difference is when and where this contract is enforced.

## Executive Summary

We should stop pushing more complexity into host-side RootFS normalization and
uid/gid canonicalization.

Instead:

1. raw OCI images should be initialized in-place at first start
2. published RootFS artifacts should be treated as internal Launchpad artifacts
3. host configuration should be pinned tightly enough that mapped ownership is
   stable across hosts
4. the required runtime contract should be minimal:
   - `user`
   - `sudo`
   - system CA certificates

`curl` should not be a required part of the contract.

This design is less elegant than a perfectly pre-normalized `user` runtime, but
it is dramatically easier to reason about, easier to secure, and likely fast
enough for the real workload mix, where most users start from already-published
RootFS images rather than raw OCI images.

## Final Decision

Adopt this runtime model for Launchpad projects:

- the container starts as container root
- first-start initialization runs as container root
- the project daemon then runs as `user:2001:2001`
- terminals, Jupyter, Codex, app servers, and ordinary user commands inherit
  that dropped-privilege model
- `sudo` is explicit elevation back to container root

The platform should expose these runtime capabilities explicitly:

- `homeDirectory = /home/user`
- `runtimeUser = user`
- `runtimeUid = 2001`
- `runtimeGid = 2001`
- `sudoAvailable = true`

### Explicit Non-Goals

This design does not aim to:

- remove root from the container entirely
- preserve arbitrary image `USER` directives as the main interactive user
- make published RootFS artifacts portable across arbitrary Linux hosts
- silently elevate ordinary UI or editor writes
- require `curl` in every runtime

## Why We Are Pivoting

The previous direction did prove several important things:

- a normal non-root runtime user is feasible
- `sudo` and even `sudo su` can work in rootless Podman
- the performance of id remapping is acceptable
- the product behavior is much better when users land in `/home/user`

However, the implementation cost was too high:

- multiple ownership remap passes
- host-specific repair logic for published RootFS trees
- complicated normalization rules for OCI and managed RootFS images
- brittle interactions between package managers, shell startup behavior, user
  namespace mappings, and setuid helpers
- more security-sensitive code than we want in the bootstrap/runtime layer

That complexity is not justified when a simpler design gets us most of the same
user-visible behavior.

## Why `2001` Instead of `1000`

We should use:

- `uid = 2001`
- `gid = 2001`

instead of `1000`.

Reasons:

- many common images already use uid/gid `1000`
  - e.g. Ubuntu often has `ubuntu:1000:1000`
- using `2001` makes it much less likely that first-start init has to rename or
  mutate an existing upstream user
- CoCalc already has precedent for `2001`
- it reduces avoidable conflicts while keeping the runtime contract simple

There are no current Launchpad projects or images to preserve, so this is the
right time to make the switch once.

## Minimal Runtime Contract

The required runtime contract should be:

- glibc-based userspace
- usable shell: `/bin/bash` or `/bin/sh`
- runtime user `user:2001:2001` with home `/home/user`
- passwordless `sudo`
- working system CA certificates

The contract should not require:

- `curl`

`curl` is convenient, but it is not fundamental to the platform. CA
certificates are fundamental because TLS failures are confusing and can break
Codex and other HTTPS-dependent tools in ways that are hard to debug.

## RootFS Strategy

There are two distinct cases.

### Raw OCI Images

Raw OCI images are an advanced feature. They should pay the first-start
initialization cost.

Recommended first-start flow:

1. create an overlay from the base RootFS
2. start a rootless Podman container as container root
3. run a small init script inside the container that:
   - ensures the runtime user exists as `user:2001:2001`
   - ensures `sudo` is installed and configured
   - ensures CA certificates are installed
4. drop privileges to `user`
5. start the project daemon as `user`

Important constraints:

- this init script must be minimal
- it must not write root-owned files into `/home/user`
- it should only mutate system paths needed for the runtime contract

### Published RootFS Images

Published RootFS images should be treated as CoCalc internal artifacts, not
generic portable RootFS trees.

That means:

- they are allowed to preserve the host's mapped ownership form
- they assume a standardized Launchpad host contract
- they do not need to be canonicalized to generic `0:0` ownership for arbitrary
  future hosts

For published RootFS images, startup should usually be cheap:

- verify artifact metadata
- verify host mapping compatibility
- run a very small sanity check
- skip heavy package-manager work unless the artifact is missing required
  runtime components

This is the main reason the simpler design remains performant enough in
practice.

## Host Contract

This design depends on standardized project hosts.

Every Launchpad host must agree on:

- the rootless Podman service account
- the host uid/gid of that account
- `/etc/subuid` and `/etc/subgid` ranges
- the user namespace strategy used to start project containers
- the runtime user identity inside the container: `user:2001:2001`

Bootstrap should enforce this contract, and hosts should fail readiness if they
do not match it exactly.

This is acceptable because Launchpad project hosts are dedicated CoCalc VMs, not
arbitrary multi-user Linux systems.

## Artifact Contract

Published RootFS artifacts should carry explicit metadata such as:

- runtime model version
- host mapping version
- runtime user name
- runtime uid/gid
- runtime home
- whether the artifact is already Launchpad-prepared

For example:

- `runtime_model = launchpad-root-start-v1`
- `mapping_version = <pinned host mapping version>`
- `runtime_user = user`
- `runtime_uid = 2001`
- `runtime_gid = 2001`
- `runtime_home = /home/user`

That metadata lets us reject mismatches early without a large normalization
pipeline.

## Security Posture

This design is safer than the previous preferred direction.

Why:

- less code runs in privileged bootstrap/normalization paths
- we avoid complicated rootful normalization logic over untrusted images
- we reduce the number of ownership-repair and remap edge cases
- the runtime contract is enforced by a small init script and host invariants,
  not a large transformation pipeline

The remaining privileged code still matters, but it is much easier to audit if
it only ensures:

- `user`
- `sudo`
- CA certificates

instead of trying to canonicalize and rewrite an arbitrary RootFS tree.

## Performance Expectations

This design is slightly slower on the first start of a raw OCI image because it
performs initialization inside the project overlay instead of pre-normalizing a
cache entry.

That is acceptable because:

- raw OCI images are an advanced workflow
- most users will start from already-published RootFS images
- once a prepared RootFS is published, later starts should be cheap
- the initialization contract is intentionally small

This means we should optimize for:

- fast verification of prepared artifacts
- minimal first-start init work
- clear progress messages during raw OCI first start

not for building a large general-purpose normalization system.

## What The Prototype Already Proved

A contained prototype on a real project host showed that this simpler model
works:

- start the container as root in rootless Podman
- ensure minimal runtime requirements
- drop to `user`
- run commands successfully as `user`
- `sudo` still works afterward

The prototype also made the host-storage behavior explicit:

- files created by container root land on the host in mapped/subuid-owned form
- files created by the runtime user land on the host as the project-host service
  user

That is fine under the internal-artifact model, as long as host mapping remains
a strict platform contract.

## Recommended Implementation Order

1. Update shared runtime constants to:
   - `user`
   - `2001`
   - `/home/user`
2. Remove `curl` from the required runtime contract.
3. Add a small first-start init script for raw OCI images.
4. Change project startup to:
   - start as root
   - run init if needed
   - drop privileges to `user`
   - start the project daemon
5. Define and enforce a host mapping/version contract in bootstrap.
6. Add artifact metadata for Launchpad-prepared RootFS images.
7. Simplify or remove the current heavy normalization/remap path once the new
   startup model is proven in production.

## Open Questions

- Exactly how much verification should run on a published RootFS before we trust
  it as Launchpad-prepared?
- Should a host refuse to use a published RootFS if the artifact mapping
  version is missing, or should it fall back to a compatibility repair path?
- Should the first-start init script install `sudo` and CA certificates only if
  missing, or also repair obviously broken existing installations?

These are much smaller questions than the previous architecture had to answer.

