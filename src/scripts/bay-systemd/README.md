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

The host bootstrap also installs conservative OS logging limits for Rocket bay
hosts: journald is capped at 1GB with 7-day retention, and the Ubuntu rsyslog
logrotate stanza for `/var/log/syslog` gets `maxsize 512M` so spammy service
logs rotate early instead of filling the root disk. Because bay hosts are
headless, emergency messages remain in syslog and journald but are not sent to
Ubuntu `omusrmsg` or GCP `/dev/console` actions, which otherwise retry forever
when the `syslog` user cannot write `/dev/console`. Use
`--skip-system-logging` only if the VM has an externally managed logging
policy.

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
  --start
```

Rocket defaults to one browser-facing hub worker. Production bays can raise
`--worker-count` after deploying the sticky frontdoor: browsers are pinned to
one healthy worker by an affinity cookie, and drained or unhealthy workers are
replaced automatically. This is the intended near-term scale-up path for a
single Rocket bay; a shared hub Conat fabric is still the longer-term design.

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

## Control-Plane Backups

The legacy full backup job is not the production target. It combines a full
PostgreSQL dump, SQLite snapshotting, compression, and Rustic upload on the bay
VM, so one long low-priority job can still contend with the serving control
plane. The replacement deliberately separates the two data stores:

- PostgreSQL uses pgBackRest directly to the R2-compatible object store, with
  continuous WAL archiving, a weekly full backup, and daily differential
  backups.
- Conat persistence SQLite files use SQLite's online backup API only when the
  DB/WAL/SHM signature changes. Rustic snapshots the persistent uncompressed
  mirror so unchanged pages and files deduplicate.
- GCP disk snapshots remain a separate infrastructure recovery layer.

Both application-level backup paths are disabled by default. Do not enable the
legacy full scheduler at the same time.

`COCALC_BACKUP_ROOT` is the canonical local backup path. The shell runtime
forces `COCALC_BAY_BACKUP_DIR` to the same value so the legacy and replacement
implementations cannot silently use different disks. pgBackRest spool data and
SQLite mirror data are automatically rebased from old defaults to this root;
conflicting payload paths fail closed. Configuration/profile files may remain
on the bay filesystem. In production set
`COCALC_BAY_BACKUP_REQUIRE_SEPARATE_FILESYSTEM=1`; backup commands then fail
before creating any path if the dedicated mount is absent, not writable, or on
the same filesystem as its parent. This check affects backup commands only and
does not block normal bay services from booting.

### pgBackRest Binary

Build pgBackRest on a disposable build host, not on a production bay. The
resulting executable is dynamically linked against the runtime libraries that
`bay-bootstrap-host.sh` installs; configuration and PostgreSQL startup fail
closed if the copied executable cannot run:

```sh
./src/scripts/bay-systemd/build-pgbackrest.sh \
  --install-deps \
  --output /tmp/pgbackrest
```

The builder pins pgBackRest 2.59.0, verifies the official release checksum,
and runs the upstream PostgreSQL backup/restore smoke test. Copy the resulting
single executable and its checksum to each bay as
`/usr/local/bin/pgbackrest`; `bay-bootstrap-host.sh` installs its runtime
libraries but intentionally does not install compiler dependencies.

### Activation Order

1. Configure the dedicated R2 credentials and independent pgBackRest/SQLite
   repository passwords in `/etc/cocalc/bay-secrets.env`.
2. Install the verified pgBackRest binary and Rustic.
3. Set `COCALC_BAY_PGBACKREST_ENABLED=1` and run
   `bay-pgbackrest-run stanza-create` while PostgreSQL is still serving. Restart
   PostgreSQL once, then immediately run
   `systemctl start cocalc-bay-pgbackrest-setup.service`. This idempotently
   confirms the stanza and verifies that a WAL segment reaches R2.
4. Run and inspect one full backup manually:
   `systemctl start cocalc-bay-pgbackrest-backup@full.service` and
   `cat $COCALC_BAY_PGBACKREST_STATUS_FILE`.
5. Set `COCALC_BAY_SQLITE_BACKUP_ENABLED=1` and run one SQLite backup manually.
   Keep its recurring backup and prune timers disabled.
6. Run `cocalc bay restore-test <bay-id> --disposable-gcp`. When pgBackRest is
   enabled, this command creates a pre/post transaction boundary, verifies its
   WAL reached the repository, restores the selected pgBackRest backup to the
   boundary, proves the post-boundary row is absent, restores the independent
   SQLite Rustic snapshot, and checks every database. The worker uses
   prefix-scoped temporary read-only R2 credentials and always deletes its VM
   and boot disk.
7. Enable the full, differential, status, SQLite backup, and SQLite prune timers
   only after that disposable PITR test succeeds.

The backup units have explicit CPU, memory, and I/O limits. The PostgreSQL
status probe records the latest backup age, retained backup bytes, archive
ranges, `pg_stat_archiver`, and pending/error spool state in
`pgbackrest-status.json`. The SQLite status records exactly which databases
were refreshed and Rustic's actual `data_added` result. R2 bucket metrics are
still the authoritative source for total stored bytes, WAL growth, requests,
and cost; pgBackRest's retained-backup byte count intentionally excludes the
WAL repository.

Run a disposable full restore and point-in-time recovery at least weekly. A
backup is not considered healthy solely because upload commands succeeded.
The restore drill must start PostgreSQL, verify application-level probes, and
record the newest replayed transaction and recovery target.

### Production Migration From Legacy Bay Snapshots

Deploying the release is inert: the pgBackRest and changed-only SQLite flags
default to zero and none of their timers are enabled by the release installer.
It does not restart PostgreSQL. The existing dedicated backup disk is reused
through `COCALC_BACKUP_ROOT`; the new payloads live below `pgbackrest/` and
`sqlite-mirror/`, and activation does not remove legacy artifacts.

Before the maintenance window, leave all replacement flags and timers disabled
and verify the release with:

```sh
findmnt -T /mnt/cocalc-backups
df -h /mnt/cocalc-backups
/opt/cocalc/bay/current/bin/bay-backup-storage-check
systemctl is-enabled cocalc-bay-pgbackrest-full.timer \
  cocalc-bay-pgbackrest-diff.timer \
  cocalc-bay-pgbackrest-status.timer \
  cocalc-bay-sqlite-backup.timer \
  cocalc-bay-sqlite-prune.timer
```

The timer check should report `disabled` for every replacement timer. Activation
is a separate operator operation:

1. Set `COCALC_BAY_BACKUP_INTERVAL_MS=0` before restarting the primary hub so
   the legacy in-process scheduler cannot start another full snapshot. Retain
   its latest local and R2 snapshots unchanged for rollback.
2. Set both `COCALC_BACKUP_ROOT` and `COCALC_BAY_BACKUP_DIR` to the dedicated
   backup mount and set
   `COCALC_BAY_BACKUP_REQUIRE_SEPARATE_FILESYSTEM=1`. Run
   `bay-backup-storage-check`, `findmnt -T "$COCALC_BACKUP_ROOT"`, and
   `df -h "$COCALC_BACKUP_ROOT"` before enabling either replacement path.
3. Install the checksum-verified pgBackRest binary and repository credentials
   while pgBackRest remains disabled.
4. Set `COCALC_BAY_SQLITE_BACKUP_ENABLED=1` and run
   `systemctl start cocalc-bay-sqlite-backup.service` manually under
   observation. This first pass snapshots every database; later passes only
   refresh changed databases. Inspect `sqlite-backup-status.json`, but keep the
   recurring backup and prune timers disabled.
5. Before the maintenance interruption, enable pgBackRest and create the stanza
   with `bay-pgbackrest-run stanza-create`. Restart PostgreSQL once to activate
   `archive_mode`, immediately run the setup/check service, force a WAL switch,
   and confirm the status reports no archive backlog.
6. Run one constrained full backup and the disposable GCP PITR/SQLite restore
   drill before enabling any recurring backup or prune timer.
7. Before the first activation, seed the persistent calendar-timer stamps to
   the current time. The migration has already produced and restore-tested a
   manual full backup, so replaying calendar events from before activation is
   both unnecessary and potentially disruptive. Then enable the status,
   SQLite, differential, full, and prune timers one at a time. Confirm each
   unit and status file before proceeding:

```sh
install -d -m 755 /var/lib/systemd/timers
touch \
  /var/lib/systemd/timers/stamp-cocalc-bay-pgbackrest-diff.timer \
  /var/lib/systemd/timers/stamp-cocalc-bay-pgbackrest-full.timer \
  /var/lib/systemd/timers/stamp-cocalc-bay-sqlite-prune.timer
systemctl enable --now cocalc-bay-pgbackrest-status.timer
systemctl enable --now cocalc-bay-sqlite-backup.timer
systemctl enable --now cocalc-bay-pgbackrest-diff.timer
systemctl enable --now cocalc-bay-pgbackrest-full.timer
systemctl enable --now cocalc-bay-sqlite-prune.timer
```

Rollback first disables all five replacement timers, then sets both replacement
enable flags to zero. If PostgreSQL has already been restarted with archiving
enabled, restart only `cocalc-bay-postgres.service` once more after disabling
pgBackRest. Restore the legacy interval only if an operator intentionally wants
to resume the old scheduler. Do not delete either new repository or any legacy
snapshot during rollback.

## GCP Bootstrap Service Account

Run this in a trusted admin `gcloud` shell to create or update the project
service account used by the GCP bay bootstrap helper:

```sh
PROJECT_ID=projecthosts \
  ./src/scripts/bay-systemd/gcp-rocket-bootstrap-service-account.sh
```

To update IAM roles for an existing service account without creating another
JSON key:

```sh
PROJECT_ID=projecthosts GENERATE_KEY=0 \
  ./src/scripts/bay-systemd/gcp-rocket-bootstrap-service-account.sh
```

The script prints a JSON service account key between explicit markers. Treat
that JSON as a password and store it as a CoCalc project secret before passing
it to `gcp-bootstrap-dogfood-bay.sh --key-file`.

By default the helper grants:

- `roles/compute.instanceAdmin.v1`
- `roles/compute.networkUser`
- a project custom role named `cocalcRocketFirewallAdmin`

Bay VMs are created with `--no-service-account` by default. This avoids
exposing project credentials through the VM metadata server and means the
bootstrap identity does not need `roles/iam.serviceAccountUser`. Rerunning the
service-account helper removes that legacy project-wide role if present.

If a bay intentionally needs an attached VM identity, pass
`--service-account <email>`, define a custom role containing only
`iam.serviceAccounts.actAs`, and bind that role to the bootstrap identity on
that specific target service account. Do not grant project-wide
`roles/iam.serviceAccountUser`.

The custom firewall role is intentionally narrower than
`roles/compute.securityAdmin`. It includes only:

- `compute.firewalls.create`
- `compute.firewalls.delete`
- `compute.firewalls.get`
- `compute.firewalls.list`
- `compute.firewalls.update`
- `compute.networks.updatePolicy`

Set `INCLUDE_FIREWALL_ADMIN=0` to skip the custom role. If custom-role creation
is blocked by organization policy, manually grant `roles/compute.securityAdmin`
to the service account as the broader fallback.

## Direct GCP Bay Ingress

`gcp-reconcile-bay-public-ingress.sh` provisions a regional external HTTPS
Application Load Balancer for a GCP bay. This keeps Cloudflare's normal proxied
DNS, CDN, and WAF path, but removes Cloudflare Tunnel from the request path:

```text
browser -> Cloudflare proxy -> regional GCP HTTPS LB -> bay frontdoor -> hub worker
```

The regional load balancer uses Standard Network Tier. Its frontend has a fixed
regional IP and a regional Google-managed certificate. Cloud Armor permits only
Cloudflare edge source ranges, while VPC firewall rules permit the backend port
only from the regional proxy-only subnet and Google health checks.

The command is plan-only unless `--apply` is passed, and defaults to refusing
any hostname that does not start with `staging.` or any VM without a
`site=staging` label. A staging plan looks like this:

```sh
./src/scripts/bay-systemd/gcp-reconcile-bay-public-ingress.sh \
  --gcp-project projecthosts \
  --zone us-south1-a \
  --instance staging-bay-0 \
  --hostname staging.cocalc.ai \
  --resource-prefix cocalc-staging-hub \
  --proxy-subnet-range 10.100.0.0/23 \
  --cloudflare-token-file /run/secrets/cocalc/cloudflare-token.txt
```

The safe two-pass provisioning and cutover order is:

1. Apply the GCP plan without changing the public hostname. Supply a
   Cloudflare token with `Zone > Config Rules > Edit`; the script creates and
   reads back an exact-host `ssl=full` rule but does not change DNS. On this
   first pass it creates the DNS authorization and reserves the frontend IP,
   but deliberately does not create a certificate yet.
2. Add the printed Certificate Manager CNAME authorization to DNS, verify it is
   public, and apply the reconciler again. The second pass creates the regional
   certificate and HTTPS proxy. Wait for the certificate to become `ACTIVE`.
3. Deploy the frontdoor change, set `COCALC_BAY_FRONTDOOR_HOST=0.0.0.0`, and
   leave `COCALC_BAY_PUBLIC_INGRESS_MODE=cloudflare-tunnel` during validation.
4. Add a temporary `--test-source-cidr`, then test the load-balancer IP with
   `curl --resolve` and a browser-style WebSocket handshake.
5. Set `COCALC_BAY_PUBLIC_INGRESS_MODE=cloudflare-proxy` and temporarily set
   `COCALC_BAY_CLOUDFLARED_ENABLED=1`. Restart the frontdoor and hub workers,
   then verify the still-active, restartable tunnel route.
6. Replace only the bay hostname's Cloudflare record with a proxied A record for
   the reserved IP. Verify HTTP and WebSocket traffic through normal DNS before
   stopping `cocalc-bay-cloudflared.service` and removing the temporary
   `COCALC_BAY_CLOUDFLARED_ENABLED` override. Remove `--test-source-cidr` and
   reapply the reconciler.

Rollback reverses the last two steps: restore the saved tunnel CNAME, set the
ingress mode to `cloudflare-tunnel`, and start the cloudflared service. Do not
delete the load-balancer resources during an incident; they are inert when DNS
does not reference them and remain useful for diagnosis.

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
the new frontend and CDN assets, flips `/opt/cocalc/bay/current`, checks bay
health, and skips hub restarts, Postgres, migrations, router/persist, and
project-host rollout. Versioned CDN directories from prior releases are kept
for already-open clients. Pass `--restart-hub-workers` only when deliberately
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
   - `/etc/cocalc/bay-local.env` for operator-owned settings that must survive
     release bootstrap and generated-overlay replacement
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
  - `/etc/cocalc/bay-local.env` (loaded last and never regenerated)
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
