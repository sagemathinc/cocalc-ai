# CoCalc Rocket

CoCalc Rocket packages the CoCalc control plane for customer-operated private
infrastructure. This directory includes a systemd/VM bay runtime bundle and a
Kubernetes Helm chart. Project compute runs on project hosts.

This directory contains a first-round Helm chart and the bay runtime packaging
work. The Helm chart is intentionally minimal and meant to be adapted for GKE +
Cloud SQL + R2 (or for on-prem deployments). The bay bundle is the current
systemd/VM path for the multibay architecture.

Locations:

- `bay/build-bundle.sh`: builds a compact Rocket bay runtime tarball
- `bin/bay-migrate-schema.js`: bundled schema migration entrypoint
- `helm/rocket`: the Kubernetes chart
- [bay systemd scaffold](../../scripts/bay-systemd/README.md): VM service templates
  and operator bootstrap/upgrade instructions

Build a bay runtime bundle:

```sh
pnpm -C src/packages --filter @cocalc/rocket run build:bay-bundle
```

The bundle includes the bay runtime plus the project-host, project, tools, and
bootstrap artifacts needed for the bay's `/software/...` project-host bootstrap
endpoints.

Kubernetes chart notes:

- Conat persist must run as exactly one pod with fast, durable storage.
- The hub deployment runs the API + web entrypoint. It proxies /conat to the
  conat-router service.
- Postgres is expected to be external (managed or self-hosted) and configured
  via env vars / secrets.

## Chart notes

- The default chart deploys a hub deployment that runs the conat API services.
  If you want to split conat API into its own deployment, set
  `conat.api.enabled=true` and consider disabling `hub.enabled`.
- Conat persist is a StatefulSet and should remain at exactly one replica.
