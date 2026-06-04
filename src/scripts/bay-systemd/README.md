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

This installs Node.js 26.2.0 via nvm 0.40.4 under `/opt/cocalc/nvm` by default.
The generated bay environment points services at that exact runtime with
`COCALC_BAY_NODE_BIN`, instead of relying on whichever `node` binary systemd
would otherwise find.

On a fresh Ubuntu VM, the host bootstrap also stops and disables the default
package-managed `postgresql` service so it does not collide with the bay-local
Postgres instance on `127.0.0.1:5432`. Use `--preserve-system-postgres` only if
you intentionally want to keep that system service around.

2. Install the shared site master key before starting bay services:

```sh
sudo install -o root -g root -m 0600 /path/to/site-master-key /etc/cocalc/site-master-key
```

Use the same key on every bay for one `cocalc.ai` site. Keep an encrypted backup
of this key outside the VM; database/R2/disk backups are not enough without it.
The bay units load it with systemd `LoadCredential=` and expose it to CoCalc only
through `$CREDENTIALS_DIRECTORY/site-master-key`.

3. Stage a built `src/` tree as the active bay release:

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

For an existing bay, prefer the higher-level upgrade wrapper from the repo
checkout. It stages the release, restarts the bay, runs health checks, upgrades
online project hosts, verifies host software state, and deletes any temporary
CLI auth session it created:

```sh
./src/scripts/bay-systemd/upgrade-bay-release.sh \
  --remote ubuntu@10.206.15.209 \
  --api https://delta.cocalc.ai \
  --build-bundle \
  --admin-email wstein@gmail.com
```

If you already built the bundle, pass it explicitly instead:

```sh
./src/scripts/bay-systemd/upgrade-bay-release.sh \
  --remote ubuntu@10.206.15.209 \
  --api https://delta.cocalc.ai \
  --bundle ./src/packages/rocket/build/cocalc-bay-runtime-linux-x64.tar.xz \
  --admin-account-id 00000000-0000-0000-0000-000000000000
```

The wrapper is intentionally conservative:

- it still uses `bay-bootstrap-release.sh` for the versioned release layout
- it restarts the same systemd service set used in manual validation
- it calls `cocalc host upgrade --all-online --wait` for project hosts
- it writes a report directory under `tmp/bay-upgrade-...`
- it accepts `--skip-host-upgrade` for control-plane-only upgrades
- it accepts `--keep-remote-artifacts` when debugging a failed upgrade
- it base64-encodes temporary `remember_me` hashes before inserting them into
  Postgres, so shell `$` expansion cannot corrupt the session hash
- it always attempts to delete the temporary `remember_me` row on exit

This script is currently an operator workflow, not a stable public installer
interface. It assumes SSH access to the bay VM and direct bay-local Postgres
access through the systemd layout.

For frontend/static-only changes, build a smaller artifact locally:

```sh
pnpm -C src/packages --filter @cocalc/rocket run build:bay-static-bundle
```

The operational wrapper can build and deploy that artifact directly:

```sh
./src/scripts/bay-systemd/upgrade-bay-release.sh \
  --remote ubuntu@10.206.15.209 \
  --api https://delta.cocalc.ai \
  --build-bundle \
  --static-only
```

This stages a normal hardlinked release from the current VM release, overlays
the new frontend/static assets, flips `/opt/cocalc/bay/current`, checks bay
health, and skips hub restarts, Postgres, migrations, router/persist, and
project-host rollout. Pass `--restart-hub-workers` only when deliberately
testing the fallback path.

Then copy the generated tarball to the VM and stage a new versioned release
from the current release:

```sh
sudo ./bay-bootstrap-release.sh \
  --static-bundle /tmp/cocalc-bay-static-linux-x64.tar.xz \
  --worker-count 8
sudo /opt/cocalc/bay/current/bin/bay-health
```

This creates a normal release directory under `/opt/cocalc/bay/releases/`,
hardlinks unchanged files from the current release, overlays the new frontend
assets, flips `/opt/cocalc/bay/current`, and preserves rollback semantics.
For Rocket/systemd bay releases, hash-named Rspack chunks from the previous
`/static` tree are retained when the new release does not include them, so
already-open clients can continue lazy loading chunks until they refresh.

The release bootstrap currently:

- stages the built tree under `/opt/cocalc/bay/releases/<release-id>`
- updates `/opt/cocalc/bay/current`
- installs the scaffold and either the current-CoCalc or Rocket bundle overlay
- provisions the bay database if missing
- writes `/etc/cocalc/bay.env`, `bay-workers.env`, `bay-topology.env`, and
  `bay-secrets.env`
- enables `cocalc-bay.target` plus the requested hub worker units
- requires `/etc/cocalc/site-master-key` when `--start` is used

## Suggested Install Layout

1. Run the installer, for example:

```sh
sudo ./src/scripts/bay-systemd/install-scaffold.sh --overlay current-cocalc --daemon-reload
```

2. Edit:
   - `/etc/cocalc/bay.env`
   - `/etc/cocalc/bay-workers.env`
   - `/etc/cocalc/bay-topology.env`
   - `/etc/cocalc/bay-secrets.env`
   - optionally `/etc/cocalc/bay-overlay.env`
3. Install `/etc/cocalc/site-master-key` with mode `0600`.
4. Enable whichever worker instances you actually want.
5. Start the bay target:

```sh
sudo systemctl enable cocalc-bay-hub@1.service
sudo systemctl enable cocalc-bay-hub@2.service
sudo systemctl start cocalc-bay.target
```

## Multibay Topology And Peer Health

Standalone bays use a loopback peer-health endpoint by default. For multibay
clusters, render the same topology on every bay and bind peer health to each
VM's internal cloud IP:

```sh
./src/scripts/bay-systemd/render-bay-topology-env.sh \
  --cluster bella \
  --seed-bay bay-0 \
  --local-bay bay-0 \
  --bay bay-0=10.206.0.21 \
  --bay bay-1=10.206.0.22
```

Install that output as `/etc/cocalc/bay-topology.env` on the local bay. Use the
same `COCALC_CLUSTER_SHARED_SECRET` in `/etc/cocalc/bay-secrets.env` on every
bay in the cluster.

Peer health is intentionally an internal control-plane endpoint:

- service: `cocalc-bay-peer-health.service`
- default port: `9402`
- authenticated path: `/peer-health`
- unauthenticated local liveness path: `/healthz`

Check local plus peer health with:

```sh
sudo /opt/cocalc/bay/current/bin/bay-health --peers
```

Public ingress and peer health are separate. Cloudflare tunnels can expose the
public site, but bay-to-bay health and control traffic should use private
internal IPs and firewall rules scoped to bay VMs.

The repeatable wrapper for a small cluster is `bay-cluster.sh`:

```sh
./src/scripts/bay-systemd/bay-cluster.sh install-topology \
  --cluster bella \
  --seed-bay bay-0 \
  --bay bay-0=ubuntu@34.0.157.185=10.206.0.21 \
  --bay bay-1=ubuntu@34.0.146.0=10.206.0.22

./src/scripts/bay-systemd/bay-cluster.sh status \
  --bay bay-0=ubuntu@34.0.157.185=10.206.0.21 \
  --bay bay-1=ubuntu@34.0.146.0=10.206.0.22

./src/scripts/bay-systemd/bay-cluster.sh health \
  --bay bay-0=ubuntu@34.0.157.185=10.206.0.21 \
  --bay bay-1=ubuntu@34.0.146.0=10.206.0.22
```

By default `install-topology` rotates `COCALC_CLUSTER_SHARED_SECRET` across all
listed bays using a temporary secret file copied over SSH. Use `--secret-file`
to install a pre-generated shared secret, or `--no-rotate-secret` to only update
topology and preserve existing secrets.

## Important Constraints

- The wrapper scripts expect environment to come from:
  - `/etc/cocalc/bay.env`
  - `/etc/cocalc/bay-workers.env`
  - `/etc/cocalc/bay-topology.env`
  - `/etc/cocalc/bay-secrets.env`
  - optionally `/etc/cocalc/bay-overlay.env`
- Production bay services set `COCALC_REQUIRE_SITE_MASTER_KEY=1` and load
  `/etc/cocalc/site-master-key` as a systemd credential. Missing keys fail
  startup instead of creating a new local key.
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
