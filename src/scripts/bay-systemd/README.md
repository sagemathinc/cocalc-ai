# CoCalc Bay Systemd Starter

This directory contains starter artifacts for the bay-on-one-VM systemd plan:

- `systemd/`: unit templates to install under `/etc/systemd/system/`
- `env/`: example environment files to install under `/etc/cocalc/`
- `bin/`: wrapper scripts to install under `/opt/cocalc/bay/current/bin/`

These files are intentionally conservative starter templates, not a finished
product runtime. They are meant to make the agreed rollout model concrete:

- one bay per VM
- bay-local Postgres, persist, and router
- replicated hub workers under `cocalc-bay-hub@.service`
- worker-only rollout vs full-bay rollout
- explicit drain / replacement workflows above systemd

There is also an installer:

- [install-scaffold.sh](/home/user/cocalc-ai-clone/src/scripts/bay-systemd/install-scaffold.sh)
- [bay-bootstrap-host.sh](/home/user/cocalc-ai-clone/src/scripts/bay-systemd/bay-bootstrap-host.sh)
- [bay-bootstrap-release.sh](/home/user/cocalc-ai-clone/src/scripts/bay-systemd/bay-bootstrap-release.sh)

It copies the units, wrapper scripts, and env templates into a target rootfs so
you can start testing the scaffold on a remote VM without hand-copying every
file.

## Fresh VM Bootstrap

For a fresh Ubuntu VM, the intended first pass is:

1. Prepare the host:

```sh
sudo ./src/scripts/bay-systemd/bay-bootstrap-host.sh --install-nodejs
```

On a fresh Ubuntu VM, the host bootstrap also stops and disables the default
package-managed `postgresql` service so it does not collide with the bay-local
Postgres instance on `127.0.0.1:5432`. Use `--preserve-system-postgres` only if
you intentionally want to keep that system service around.

2. Stage a built `src/` tree as the active bay release:

```sh
sudo ./src/scripts/bay-systemd/bay-bootstrap-release.sh \
  --source /path/to/built/src \
  --start
```

For a packaged Rocket bay runtime bundle, build the artifact locally:

```sh
pnpm -C src/packages --filter @cocalc/rocket run build:bay-bundle
```

Then copy the generated tarball to the VM and stage it directly:

```sh
sudo ./bay-bootstrap-release.sh \
  --bundle /tmp/cocalc-bay-runtime-linux-x64.tar.xz \
  --worker-count 8 \
  --start
```

The release bootstrap currently:

- stages the built tree under `/opt/cocalc/bay/releases/<release-id>`
- updates `/opt/cocalc/bay/current`
- installs the scaffold and either the current-CoCalc or Rocket bundle overlay
- provisions the bay database if missing
- writes `/etc/cocalc/bay.env`, `bay-workers.env`, and `bay-secrets.env`
- enables `cocalc-bay.target` plus the requested hub worker units

## Suggested Install Layout

1. Run the installer, for example:

```sh
sudo ./src/scripts/bay-systemd/install-scaffold.sh --overlay current-cocalc --daemon-reload
```

2. Edit:
   - `/etc/cocalc/bay.env`
   - `/etc/cocalc/bay-workers.env`
   - `/etc/cocalc/bay-secrets.env`
   - optionally `/etc/cocalc/bay-overlay.env`
3. Enable whichever worker instances you actually want.
4. Start the bay target:

```sh
sudo systemctl enable cocalc-bay-hub@1.service
sudo systemctl enable cocalc-bay-hub@2.service
sudo systemctl start cocalc-bay.target
```

## Important Constraints

- The wrapper scripts expect environment to come from:
  - `/etc/cocalc/bay.env`
  - `/etc/cocalc/bay-workers.env`
  - `/etc/cocalc/bay-secrets.env`
- optionally `/etc/cocalc/bay-overlay.env`
- The optional `bay-current-cocalc-overlay.env.example` file is intentionally
  transitional. It binds the scaffold to the current repo layout:
  - router and persist from `@cocalc/project-host`
  - hub workers from `@cocalc/hub`
  - migrations through a dedicated `bay-migrate-schema.js` helper that runs the
    current CoCalc schema update path and exits
- The actual bundle entrypoints are intentionally configured through
  `COCALC_BAY_*_CMD` variables instead of being hardcoded here.
- Rollout helpers assume versioned bundles live under
  `/opt/cocalc/bay/releases/<version>` and the active bundle is the symlink
  `/opt/cocalc/bay/current`.

## What Is Still Missing

- control-plane integration
- bay drain orchestration above systemd
- production-safe migration guards
- exact bundle-local service entrypoints
- log shipping / metrics exporters / nginx / cloudflared wiring

That missing work is deliberate. This tree is meant to be the smallest useful
starting point that can be iterated on during implementation.

## Direct State Handoff

For the first alpha-to-bay cutover, the simplest path is a direct control-plane
state handoff, not a backup restore drill.

On the current launchpad-style source host:

```sh
./src/scripts/bay-systemd/export-launchpad-state.sh \
  --output /tmp/alpha-state \
  --data-dir /home/wstein/cocalc-ai/src/data/app/postgres \
  --pg-host /run/user/1001/cocalc/pg-bef114df \
  --pg-user smc \
  --pg-database smc
```

Copy that directory to the bay VM, then on the bay VM:

```sh
sudo ./src/scripts/bay-systemd/import-bay-state.sh \
  --input /tmp/alpha-state \
  --start
```

By default, import writes a one-shot migration-skip marker because
`postgres.dump` is a full database dump whose schema has already been restored.
Pass `--run-migrations` only when intentionally importing data into a database
that still needs the current release migration step.

This imports:

- the control-plane Postgres DB
- `DATA/sync`
- `DATA/secrets`

By default, `export-launchpad-state.sh` excludes `secrets/launchpad-cloudflare`
so a disposable bay VM does not immediately advertise itself as the existing
public site. Pass `--include-cloudflare` only for an intentional cutover.

It does not attempt a full backup/PITR restore and it does not move
project-host storage.
