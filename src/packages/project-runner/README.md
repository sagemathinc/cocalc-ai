# Project Runner

`@cocalc/project-runner` implements project runtime backends. In the normal
project-host deployment, it runs alongside the file server and uses that
host's project storage; it does not synchronize a private cache against a
single central file server.

## Runtime boundary

- The Podman backend launches projects using rootless Podman and host-managed
  Btrfs project volumes. Privileged storage operations go through the installed
  runtime-storage wrapper, not unrestricted sudo from the project.
- The workspace backend runs local processes for the explicit Launchpad
  workspace mode. It has a different isolation boundary and is not a substitute
  for a multi-tenant project host.
- Runtime selection is implemented in [runtime-mode.ts](./runtime-mode.ts) and
  [run/runtime-backend.ts](./run/runtime-backend.ts).
- [run/index.ts](./run/index.ts) registers start, stop, status, and save handlers.
  Cross-host project moves are orchestrated by the control plane; the runner's
  move handler rejects direct move requests.

## Development and deployment

Build this package with `pnpm --filter @cocalc/project-runner build` in a prepared
workspace. The standalone entry point also requires a runner identity and a
configured Conat/filesystem environment; building the package does not provision
those services.

Use [Project Host](../project-host/README.md) for the combined host service and
[Star](../../../docs/star.md) or [SelfHost](../../../docs/self-host.md) for the
corresponding deployment entry points. Project-host packaging owns the host
bundle and SEA distribution.

## Historical setup instructions

Earlier versions of this README described an experimental central-file-server
cache, formatting a local SSD as ext4, manually copying a hub Conat password,
and starting a version-specific runner binary. Those instructions predate the
current project-host storage and credential model and are not an installation
procedure. They remain available in Git history; do not use them to prepare a
current host or distribute its credentials.
