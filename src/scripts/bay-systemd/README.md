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

## Suggested Install Layout

1. Copy env examples into `/etc/cocalc/` and replace placeholders.
   If you want to start from the current CoCalc source/bundle layout instead of
   mapping every command by hand, also copy
   `env/bay-current-cocalc-overlay.env.example` and source it after
   `bay.env`.
2. Copy `systemd/*.service` and `systemd/*.target` into
   `/etc/systemd/system/`.
3. Copy `bin/*` into `/opt/cocalc/bay/current/bin/`.
4. Run:

```sh
sudo systemctl daemon-reload
sudo systemctl enable cocalc-bay.target
sudo systemctl enable cocalc-bay-hub@1.service
sudo systemctl enable cocalc-bay-hub@2.service
sudo systemctl start cocalc-bay.target
```

## Important Constraints

- The wrapper scripts expect environment to come from:
  - `/etc/cocalc/bay.env`
  - `/etc/cocalc/bay-workers.env`
  - `/etc/cocalc/bay-secrets.env`
- The optional `bay-current-cocalc-overlay.env.example` file is intentionally
  transitional. It binds the scaffold to the current repo layout:
  - router and persist from `@cocalc/project-host`
  - hub workers from `@cocalc/hub`
  - migrations still require a bay-specific implementation decision
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
