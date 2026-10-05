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

## Runtime Fleet Health Gates

Runtime rollout and global promotion use the same health policy. Missing browser
latency samples (including an idle staging site or aged-out samples), aggregate
recovery warnings, and increases in the cumulative 24-hour I/O-pressure counter are advisory, not
automatic rollout failures. A cumulative counter can increase after a short
pressure event even when the host has already recovered; it does not establish
release causality or current storage failure.

Advisories are logged and retained in the operation's
`recovery_stop_gate_latest.advisories` alongside the unchanged baseline and raw
measurements. Inspect current pressure and use synthetic project/file/terminal
and application smoke checks when organic traffic is absent. Unmeasured latency
is not reported as healthy. Aggregate warnings are not necessarily harmless;
inspect their underlying causes. The fleet gate does not separately block on a
current emergency-pressure sample. Persistent current pressure with failing
workflows needs investigation, not dismissal as historical noise.

Measured latency regressions, newly critical recovery health, unavailable
recovery health, loss of previously available pressure telemetry, backup-debt
age jumps, and new non-quota recovery failures still stop the rollout. Runtime
version alignment, readiness, stabilization, and ACP drain checks are unchanged.
This fleet policy does not disable host-local storage admission or disk-space
and runtime-health protection. Do not rewrite an old failed campaign or baseline
to apply a new gate policy.

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
