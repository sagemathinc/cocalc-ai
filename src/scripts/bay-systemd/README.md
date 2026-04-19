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

2. Stage a built `src/` tree as the active bay release:

```sh
sudo ./src/scripts/bay-systemd/bay-bootstrap-release.sh \
  --source /path/to/built/src \
  --start
```

The release bootstrap currently:

- stages the built tree under `/opt/cocalc/bay/releases/<release-id>`
- updates `/opt/cocalc/bay/current`
- installs the scaffold and the current-CoCalc overlay
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
