# Project Viewer Endpoint Audit

Date: 2026-05-28

Status: executable audit coverage added.

## Architectural Rule

Viewer access is a separate read-only capability, not a weaker collaborator.
The control plane may authorize and issue scoped project-host access, but steady
state project traffic must stay direct between the client and project-host.
Different viewer semantics belong on distinct project-host subjects/services,
not by proxying project data through the hub.

## Allowed Viewer Surface

Viewers may use only the viewer file service:

- `fs-viewer.project-<project_id>.account-<account_id>`

That service exposes read-style filesystem methods and enforces the viewer read
policy at the project-host boundary for each operation.

Viewer copy-out is allowed only as a source operation when the destination
project is one where the same account has normal collaborator access. Directory
copy is all-or-nothing: the server must verify every copied child against the
source read policy.

## Denied Surfaces

The audit treats these as non-viewer surfaces:

- runtime start, stop, restart, state, address, runtime logs, active operations.
- proxy, app-server, Jupyter, terminal, Codex, ACP, and sync/persist subjects.
- SSH setup, SSH login keys, and project-host agent tokens.
- project secrets.
- snapshots and backups, including backup/snapshot file reads.
- project settings and schedule/quota/details reads that expose administrative
  configuration.
- collaborator invite, removal, role, and project-wide invite-management paths.
- normal collaborator filesystem subjects.

## Enforcement Summary

Project-host data plane:

- `project-host/conat-auth.ts` allows viewer accounts only on their matching
  `fs-viewer.project-...account-...` subject.
- Normal project/file-server/fs/persist/acp/codex subjects resolve through the
  collaborator path and reject viewers.

Hub and inter-bay control plane:

- `assertCollab` and `assertCollabAllowRemoteProjectAccess` explicitly mean
  owner-or-collaborator, not viewer.
- local and remote project access helpers include tests proving viewers are
  project users but not collaborators.
- inter-bay project details and secrets handlers re-check local collaborator
  access on the owning bay.

Proxy/app-server:

- hub proxy target resolution requires write access before autostarting a
  proxied service. Viewers are not write-access users.

SSH:

- browser project-host tokens may be issued to viewers so the viewer fs service
  can work, but project-host subject authorization prevents normal runtime/file
  access.
- project-host agent tokens and SSH authorized-key material require owner or
  collaborator roles only.

## Regression Tests

The executable audit is intentionally split across the boundary layers:

- `packages/project-host/conat-auth.test.ts` proves viewers can use only their
  viewer fs subject and cannot publish/subscribe to normal project-host
  runtime, file, terminal, storage, archive, persist, ACP, Codex, or hub project
  subjects.
- `packages/hub/proxy/target.test.ts` proves proxy/app-server target resolution
  requires write access before any autostart.
- `packages/server/conat/api/project-viewer-endpoint-audit.test.ts` checks that
  high-risk hub/inter-bay project RPCs retain collaborator, admin, or
  destructive-storage guards.
- `packages/server/conat/api/project-host-token-auth.test.ts` proves
  project-host agent tokens are not available to viewers.
- `packages/server/projects/project-ssh-keys.test.ts` proves viewer SSH keys are
  not exported into project authorized-key material.

## Residual Risk

The audit is not a substitute for reviewing new endpoint code. Any new
project-facing endpoint should be classified as metadata read, file read, file
write, runtime use, project administration, or owner-only, then guarded with the
narrowest capability. New project-host subjects must be added to the deny-list
test unless they are intentionally viewer-specific.
