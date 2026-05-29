# Dogfood Demo Site Deployment Runbook, 2026-05-29

Status: `active`

Target site: `https://demo.cocalc.ai`

Purpose: deploy a fresh dogfood CoCalc-ai site using the bay `systemd`
deployment path, record every manual and automated step, and turn any deployment
friction into code fixes or follow-up release blockers.

This runbook is intentionally operational. It is not a general architecture
proposal. The architecture baseline is `src/.agents/scalable-architecture.md`,
and the systemd scaffold baseline is `src/scripts/bay-systemd`.

## Deployment Shape

### Bay 0 Seed Node

- Provider: GCP.
- Region: `us-south1`.
- Machine: `t2d-standard-4`.
- Spot/preemptible: no.
- Disk: 50 GB balanced persistent disk.
- Role: seed bay and first public control plane for `demo.cocalc.ai`.
- Bay id: `bay-0`.
- Bring this up first and keep it stable before creating `bay-1`.

### Bay 1 Remote Bay

- Provider: GCP.
- Region: `europe-west4`.
- Machine: `t2d-standard-4`.
- Spot/preemptible: no.
- Disk: 50 GB balanced persistent disk.
- Role: second bay for multibay and high-latency cross-region validation.
- Bay id: `bay-1`.
- Create this only after `bay-0` has passed the seed-node smoke tests.

### Project Hosts

- Add two project hosts after the control plane is stable.
- At least one project host should be intentionally remote from the active
  browser/user region to expose latency and routing assumptions.
- Project hosts belong to exactly one bay. Do not shortcut this by treating
  Launchpad as a separate architecture.

## Explicit Scope

### Manual For This Run

These should be recorded, but do not need to be automated for the first dogfood
site:

- GCP VM creation.
- GCP firewall and service account configuration.
- Cloudflare DNS, TLS, proxy, and any tunnel/origin configuration.
- Nebius provider account/API setup.
- Email provider setup, DNS records, and deliverability checks.
- Any one-time secrets created outside the VM.

### Must Be Automated Or Scripted

These should use repo scripts or become scripts during this deployment:

- Preparing a fresh Ubuntu bay VM.
- Installing the bay systemd scaffold.
- Staging a release under `/opt/cocalc/bay/releases/<release-id>`.
- Updating `/opt/cocalc/bay/current`.
- Starting/stopping/checking bay services.
- Rolling forward and rolling back a bay release.
- Repeating the same workflow on `bay-1`.

## Preferred Automation Path

Use the GCP dogfood helper first. The manual sections below remain as the
debugging fallback and as the checklist for what the helper is expected to do.

The helper script is:

- `src/scripts/bay-systemd/gcp-bootstrap-dogfood-bay.sh`

It expects:

- `gcloud` installed and authenticated.
- `gcloud` permission to create and SSH to VMs in the target project.
- `pnpm` available locally.
- A GCP project id, VM name, bay id, and zone.

It does:

- build the Rocket bay runtime bundle, including the project-host, project, and
  tools artifacts needed for project-host bootstrap,
- create the GCP VM if needed,
- create or reuse a local site master key,
- copy the bundle, systemd scaffold, and site master key to the VM,
- run `bay-bootstrap-host.sh`,
- run `bay-bootstrap-release.sh`,
- start the bay,
- run bay status and health checks,
- start an SSH local port forward to the first hub worker,
- print the local URL, bootstrap admin URL if found in logs, and the exact
  site-master-key path to save in 1Password.

Bay 0 example:

```sh
src/scripts/bay-systemd/gcp-bootstrap-dogfood-bay.sh \
  --gcp-project <gcp-project> \
  --vm-name <bay-0-vm-name> \
  --bay-id bay-0 \
  --zone us-south1-a \
  --machine-type t2d-standard-4 \
  --boot-disk-size 50GB \
  --boot-disk-type pd-balanced \
  --public-url https://demo.cocalc.ai \
  --local-forward-port 7001
```

Bay 1 example after bay 0 is stable:

```sh
src/scripts/bay-systemd/gcp-bootstrap-dogfood-bay.sh \
  --gcp-project <gcp-project> \
  --vm-name <bay-1-vm-name> \
  --bay-id bay-1 \
  --zone europe-west4-a \
  --machine-type t2d-standard-4 \
  --boot-disk-size 50GB \
  --boot-disk-type pd-balanced \
  --public-url <bay-1-url> \
  --local-forward-port 7002
```

Use `--reuse-existing-vm` only when intentionally iterating on an existing VM.
The script refuses to silently overwrite an existing VM by default.

The default site master key path is:

```sh
~/.cocalc/dogfood/<gcp-project>/site-master-key
```

Use the same key for every bay in the same dogfood site. Store it in 1Password
immediately after bay 0 bootstrap succeeds.

## Existing Systemd Deployment Tooling

The current scaffold lives at:

- `src/scripts/bay-systemd/README.md`
- `src/scripts/bay-systemd/bay-bootstrap-host.sh`
- `src/scripts/bay-systemd/bay-bootstrap-release.sh`
- `src/scripts/bay-systemd/bin/bay-preflight`
- `src/scripts/bay-systemd/bin/bay-status`
- `src/scripts/bay-systemd/bin/bay-health`
- `src/scripts/bay-systemd/bin/bay-rollout-full`
- `src/scripts/bay-systemd/bin/bay-rollback-full`

The default runtime layout is:

- Config: `/etc/cocalc/bay.env`
- Worker config: `/etc/cocalc/bay-workers.env`
- Secrets env: `/etc/cocalc/bay-secrets.env`
- Shared site master key: `/etc/cocalc/site-master-key`
- Bay state root: `/mnt/cocalc/bays/<bay-id>`
- Releases: `/opt/cocalc/bay/releases/<release-id>`
- Active release symlink: `/opt/cocalc/bay/current`
- Bay target: `cocalc-bay.target`
- Hub workers: `cocalc-bay-hub@<n>.service`

The bootstrap currently supports two release inputs:

- A built `src` tree via `--source`.
- A packaged Rocket bay runtime bundle via `--bundle`.

Prefer the Rocket bay bundle for dogfood if it passes build and startup. Use the
built `src` tree path only as a temporary unblocker, and record that explicitly
in the friction log.

## Local Build And Artifact Preparation

This section is the manual equivalent of the automation helper's build step.

Run from the repository root on the operator workstation.

```sh
pnpm -C src build:dev
pnpm -C src/packages --filter @cocalc/rocket run build:bay-bundle
```

Expected bundle artifact:

```sh
find src/packages/rocket -name 'cocalc-bay-runtime-*.tar.xz' -print
```

If the Rocket bundle is not viable, prepare to stage the built `src` tree:

```sh
rsync -a --delete \
  --exclude '/.git' \
  --exclude '/.local' \
  --exclude '/data' \
  --exclude '/.build-home' \
  src/ <bay-vm>:/tmp/cocalc-src/
```

Record the exact git commit deployed:

```sh
git rev-parse HEAD
git status --short
```

Do not deploy from a dirty tree unless the dirty files are explicitly listed in
the friction log.

## Bay 0 Bootstrap

This section is the manual fallback for what
`gcp-bootstrap-dogfood-bay.sh --bay-id bay-0` automates.

### 1. Manual VM Preconditions

On the GCP VM:

- Ubuntu 24.04 or compatible Ubuntu release.
- SSH access for the operator.
- `sudo` access.
- At least 50 GB balanced persistent disk.
- Inbound access only for the intentionally exposed public ingress path.
- `/mnt/cocalc` available as the bay state parent, either as a directory on the
  boot disk or as a mounted persistent disk.

Recommended first host prep:

```sh
sudo mkdir -p /mnt/cocalc
sudo chmod 755 /mnt/cocalc
```

### 2. Copy Bootstrap Scripts Or Bundle

For the first run, copy the systemd scaffold from the repo:

```sh
rsync -a src/scripts/bay-systemd/ <bay0>:/tmp/bay-systemd/
```

If using a Rocket bundle, also copy it:

```sh
scp <bundle-path> <bay0>:/tmp/cocalc-bay-runtime-linux-x64.tar.xz
```

If using a built `src` tree, copy the built tree as described above.

### 3. Prepare The Host

On `bay-0`:

```sh
cd /tmp
sudo ./bay-systemd/bay-bootstrap-host.sh \
  --bay-id bay-0 \
  --install-nodejs
```

This installs base packages, Node.js 26.2.0 under `/opt/cocalc/nvm`, creates the
`cocalc-bay` user/group, prepares `/mnt/cocalc/bays/bay-0`, and disables the
default distro PostgreSQL service so it does not collide with the bay-local
Postgres service.

### 4. Install The Shared Site Master Key

Generate or retrieve one site master key for the whole `demo.cocalc.ai` site.
Use the same key on every bay.

On `bay-0`:

```sh
sudo install -o root -g root -m 0600 /tmp/site-master-key /etc/cocalc/site-master-key
```

Keep an encrypted backup outside the VM. Database, R2, or disk backups are not
enough without this key.

### 5. Stage And Start The First Release

Preferred bundle path:

```sh
sudo /tmp/bay-systemd/bay-bootstrap-release.sh \
  --bundle /tmp/cocalc-bay-runtime-linux-x64.tar.xz \
  --bay-id bay-0 \
  --worker-count 2 \
  --public-url https://demo.cocalc.ai \
  --start
```

Temporary built-source path:

```sh
sudo /tmp/bay-systemd/bay-bootstrap-release.sh \
  --source /tmp/cocalc-src \
  --bay-id bay-0 \
  --worker-count 2 \
  --public-url https://demo.cocalc.ai \
  --start
```

After bootstrap, inspect and edit these before declaring the bay ready:

```sh
sudoedit /etc/cocalc/bay.env
sudoedit /etc/cocalc/bay-workers.env
sudoedit /etc/cocalc/bay-secrets.env
sudoedit /etc/cocalc/bay-overlay.env
```

### 6. Verify Bay 0

On `bay-0`:

```sh
sudo /opt/cocalc/bay/current/bin/bay-status
sudo /opt/cocalc/bay/current/bin/bay-health
systemctl status cocalc-bay.target
systemctl status cocalc-bay-postgres.service
systemctl status cocalc-bay-conat-persist.service
systemctl status cocalc-bay-conat-router.service
systemctl status 'cocalc-bay-hub@*.service'
```

Logs:

```sh
journalctl -u cocalc-bay.target -n 200 --no-pager
journalctl -u cocalc-bay-conat-router.service -n 200 --no-pager
journalctl -u cocalc-bay-conat-persist.service -n 200 --no-pager
journalctl -u cocalc-bay-hub@1.service -n 200 --no-pager
```

Browser and API smoke:

- `https://demo.cocalc.ai` loads.
- Account creation works.
- Login/logout works.
- Email sending works.
- Admin access works.
- Create a project.
- Start the project on a project host after host setup.
- Open files, terminal, Jupyter, chat, and Codex.
- Confirm steady-state project traffic routes directly to project hosts where
  applicable, not through the bay hub as a data-plane proxy.

## Bay 0 Upgrade And Rollback Drill

Before adding `bay-1`, prove that a simple bay upgrade and rollback works.

Stage a second release exactly as above, with a distinct release id. Then:

```sh
sudo /opt/cocalc/bay/current/bin/bay-status
sudo /opt/cocalc/bay/current/bin/bay-rollout-full <new-release-id>
sudo /opt/cocalc/bay/current/bin/bay-health
```

Rollback:

```sh
sudo /opt/cocalc/bay/current/bin/bay-rollback-full
sudo /opt/cocalc/bay/current/bin/bay-health
```

Record:

- Whether active browser sessions reconnect cleanly.
- Whether project-host connections survive or recover.
- Whether migrations are safe to rerun.
- Whether rollback is blocked by schema or config changes.

## Bay 1 Bootstrap

This section is the manual fallback for what
`gcp-bootstrap-dogfood-bay.sh --bay-id bay-1` automates.

Repeat the same flow after `bay-0` is stable, with these changes:

- Region: `europe-west4`.
- Bay id: `bay-1`.
- Public URL: use the chosen bay-specific internal/public endpoint, not the
  global `demo.cocalc.ai` URL unless that is the intended router entrypoint.
- Site master key: same `/etc/cocalc/site-master-key` as `bay-0`.

Host prep:

```sh
sudo ./bay-systemd/bay-bootstrap-host.sh \
  --bay-id bay-1 \
  --install-nodejs
```

Release bootstrap:

```sh
sudo ./bay-systemd/bay-bootstrap-release.sh \
  --bundle /tmp/cocalc-bay-runtime-linux-x64.tar.xz \
  --bay-id bay-1 \
  --worker-count 2 \
  --public-url <bay-1-url> \
  --start
```

Cross-bay checks:

- Account home bay behavior is explicit.
- Project owning bay behavior is explicit.
- A project owned by `bay-0` is not accidentally controlled directly by
  `bay-1`.
- Browser control-plane routing remains understandable from the UI and logs.
- Cross-region latency is visible but not catastrophic for normal control-plane
  actions.
- Project data-plane traffic still goes directly to the project host.

## Project Host Setup

Add project hosts only after both bay systemd deployments are understood.

For each host, record:

- Provider, region, zone, instance type, spot setting, and disk settings.
- Owning `bay_id`.
- Public/private connectivity model.
- Software artifact versions.
- Whether `/scratch` is enabled.
- Whether GPU is present.
- First project start logs.

Minimum smoke per host:

- Create a project assigned to that host.
- Start it.
- Open terminal.
- Open file browser.
- Open Jupyter.
- Confirm host status in the admin UI.
- Stop and start the project.
- Stop and start the host if supported.

## Manual Configuration Checklist

Record the final values or links to secure storage for:

- Cloudflare zone and DNS records.
- TLS/origin certificate strategy.
- Any Cloudflare tunnel or reverse proxy config.
- GCP project id.
- GCP service accounts and permissions.
- GCP firewall rules.
- Nebius account/project/API configuration.
- Email provider, domain, SPF, DKIM, DMARC, bounce handling.
- R2 or object-storage buckets and credentials.
- Site master key storage location.
- Admin account bootstrap path.

Do not put secrets in this repo.

## Acceptance Criteria

The dogfood site is good enough to mark this release-blocker item done when:

- `demo.cocalc.ai` is reachable through the intended public ingress.
- `bay-0` is deployed by `src/scripts/bay-systemd`, not ad hoc shell history.
- `bay-1` is deployed by the same workflow.
- Both bays have repeatable status, health, restart, rollout, and rollback
  commands.
- At least two project hosts are attached to bays and can run real projects.
- A fresh user can sign up, create a project, open terminal/files/Jupyter, and
  run chat/Codex.
- Admins can inspect bay, host, project, and deployment state.
- Every deployment failure found during setup is either fixed or added to the
  active release-blocker triage with enough detail to reproduce.

## Friction Log

Append entries here during the deployment.

| Time       | Phase    | Command / action | Symptom                                                        | Resolution / follow-up                                             |
| ---------- | -------- | ---------------- | -------------------------------------------------------------- | ------------------------------------------------------------------ |
| 2026-05-29 | Planning | Created runbook  | Need concrete dogfood deployment checklist before creating VMs | Use this file as the source of truth for the first deployment pass |

## Open Decisions

- Exact public ingress shape: direct VM reverse proxy, Cloudflare tunnel, or
  Cloudflare proxied DNS to an origin proxy. (ans: it's built in to use cloudflare reverse tunnel)
- Whether the first dogfood deployment uses Rocket bundle only or temporarily
  allows a built `src` tree.
- Whether bay-local Postgres on the 50 GB boot disk is enough for dogfood, or
  whether `/mnt/cocalc` should be a separate persistent disk from day one.
- How to expose bay-specific health endpoints without exposing private admin
  internals.
- Whether `bay-1` should be visible to end users immediately or reserved for
  controlled multibay tests first.
- Initial project-host placement: one host near each bay versus deliberately
  asymmetric placement.

## Immediate Next Steps

1. Run `src/scripts/bay-systemd/gcp-bootstrap-dogfood-bay.sh` for `bay-0`.
2. Store the generated site master key in 1Password.
3. Visit the forwarded local URL and finish the initial bay/site configuration.
4. Record every command, edit, and failure in the friction log above.
5. Fix deployment blockers as code changes rather than relying on manual VM
   surgery.
6. Run the same helper for `bay-1` only after `bay-0` is stable.
