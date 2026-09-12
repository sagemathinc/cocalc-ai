# Architecture and operations references

Use these topic references to locate the owning implementation and operational
guidance. Follow each document's stated scope: a design plan is not a validated
installation or recovery procedure. The public user guides are available in the
[documentation browser](https://cocalc.ai/docs).

## Products and deployment

- [architecture.md](architecture.md): project-host architecture and component
  responsibilities.
- [launchpad.md](launchpad.md): Launchpad control-plane defaults, host
  connectivity, and local backup transport reference.
- [self-host.md](self-host.md): connecting self-hosted project hosts.
- [star.md](star.md): Star product and deployment plan. Use the
  [Star installer reference](../src/scripts/star/README.md) for its current
  commands.
- [VM/systemd bay tooling](../src/scripts/bay-systemd/README.md) and
  [Rocket package](../src/packages/rocket/README.md): deployment-specific
  artifacts and operating references.

## Project state and storage

- [project-rootfs.md](project-rootfs.md): project image selection and runtime
  filesystem state.
- [project-startup-script.md](project-startup-script.md): project startup script
  location, execution, and logs.
- [project-backups.md](project-backups.md), [backup-indexes.md](backup-indexes.md),
  and [backup-secrets.md](backup-secrets.md): backup data, indexes, and keys.
- [buckets.md](buckets.md): backup and artifact storage architecture.
- [project-move.md](project-move.md): project move orchestration and cleanup.
- [long-running-operations.md](long-running-operations.md): durable operations
  and progress reporting.
- [persistence-alerts.md](persistence-alerts.md): persistence diagnostics.

## Routing, authentication, and collaboration

- [conat-routing.md](conat-routing.md): explicit routing and authority.
- [http-proxy.md](http-proxy.md): HTTP/WebSocket proxying and managed apps.
- [project-host-auth.md](project-host-auth.md): project-host Conat authentication.
- [ssh-key-distribution.md](ssh-key-distribution.md) and [ssh-proxy.md](ssh-proxy.md):
  project SSH keys and routing.
- [secrets.md](secrets.md): project and site secret handling.
- [sync.md](sync.md): collaborative synchronization.
- [remote-jupyter-kernels.md](remote-jupyter-kernels.md): remote kernel transport.

## Agents, tools, and administration

- [agents.md](agents.md) and [codex-auth.md](codex-auth.md): agent integration and
  authentication.
- [api.md](api.md) and [browser-debugging.md](browser-debugging.md): browser
  automation and debugging.
- [membership.md](membership.md): membership implementation.
- [accounts-receivable.md](accounts-receivable.md): accounts-receivable operations.
- [support-impersonation.md](support-impersonation.md): support content consent.
- [security/private-app-trust-model.md](security/private-app-trust-model.md) and
  [security/site-master-key-production-runbook.md](security/site-master-key-production-runbook.md):
  trust boundaries and site-key operations.
