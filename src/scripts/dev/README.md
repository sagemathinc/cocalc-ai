# Local Hub Dev Stack + Smoke Tests

## One-time setup (optional)

```bash
pnpm --dir src dev:hub:init
```

This creates a local, untracked config at:

- `src/.local/hub-daemon.env`

Edit that file as needed.

Notes:

- `pnpm --dir src smoke:self-host` will auto-create this config on first run if missing and continue with defaults.
- Set `SMOKE_REQUIRE_EXISTING_CONFIG=1` to keep the old fail-fast behavior that requires manual config editing first.
- Smoke defaults to cleanup on failure (`SMOKE_CLEANUP_FAILURE=1`) so failed runs do not leave Multipass VMs consuming RAM.
- Smoke auto-selects a free local pairing sshd port when `COCALC_SSHD_PORT` is unset; disable this with `SMOKE_AUTO_SSHD_PORT=0`.
- Smoke rebuilds hub by default (`SMOKE_BUILD_HUB=1`) so software-manifest changes are picked up before each run.
- Smoke now ensures full `tools-linux-*` artifacts are built (not `tools-minimal`) because project-start in smoke requires `dropbear`.

## Shell env

Use these to print the fully resolved CLI/browser environment for the current
local stack and apply it to your shell:

```bash
eval "$(pnpm -s --dir src dev:lite:env)"
eval "$(pnpm -s --dir src dev:hub:env)"
```

If you want the raw configured daemon variables instead of shell exports:

```bash
pnpm --dir src dev:lite:config
pnpm --dir src dev:hub:config
```

## Hub dev commands

```bash
pnpm --dir src dev:hub:start
pnpm --dir src dev:hub:build
pnpm --dir src dev:hub:status
pnpm --dir src dev:hub:logs
pnpm --dir src dev:hub:stop
```

`dev:hub:build` now only builds the local hub/runtime artifacts. It does not
restart the hub or touch hosts.

For host rollout and the old all-in-one behavior:

```bash
pnpm --dir src dev:hosts:upgrade
pnpm --dir src dev:hosts:reconcile
pnpm --dir src dev:stack:refresh
```

## Lite dev commands

```bash
pnpm --dir src dev:lite:init
pnpm --dir src dev:lite:start
pnpm --dir src dev:lite:status
pnpm --dir src dev:lite:logs
pnpm --dir src dev:lite:stop
```

Run Jupyter Playwright tests against the local Lite dev instance (auto-uses
saved connection info, so no long env prefix is needed):

```bash
pnpm --dir src lite:test:e2e -- --grep "single-doc"
pnpm --dir src lite:test:e2e:headed -- --grep "single-doc"
pnpm --dir src lite:test:e2e:strict -- --grep "single-doc"
```

Defaults:

- config: `src/.local/lite-daemon.env`
- state/logs: `src/.local/lite-daemon`
- isolated home: `$HOME/scratch/<repo-name>-lite-daemon`
- connection info: `src/.local/lite-daemon/connection-info.json`
- sqlite db: `$LITE_HOME/.local/share/cocalc-lite/hub.db` (shown in `dev:lite:status`)

Safety note: `lite-daemon.sh` is PID-file scoped and only stops the exact process it started.
It does not scan/kill other `node`/`cocalc-lite` processes.

## Self-host smoke test (multipass)

```bash
pnpm --dir src smoke:self-host
```

By default this script:

1. Builds local `project-host` + `project` bundles (and tools if missing).
2. Builds `@cocalc/server`.
3. Builds `@cocalc/cli` (used by smoke-runner for host/workspace actions).
4. Starts the local hub dev stack (if not running).
5. Runs self-host multipass smoke tests end-to-end, including:
   - cross-project file copy (project A -> project B),
   - backup indexing,
   - workspace SSH connectivity check (`workspace ssh --check`),
   - workspace HTTP proxy denied/allowed checks (`workspace proxy curl` + issued token),
   - optional second VM/host provisioning,
   - optional move/restore to a second host,
   - optional cross-host project copy after move.

You can override behavior via variables in `src/.local/hub-daemon.env`.
For smoke-only toggles, set environment variables when invoking, e.g.:

```bash
SMOKE_VERIFY_COPY_BETWEEN_PROJECTS=0 pnpm --dir src smoke:self-host
```

## Cloud host smoke test (CLI flow)

```bash
pnpm --dir src smoke:cloud-host
```

This runs project-host cloud smoke via the CLI execution path and includes:

1. Host create/start.
2. Workspace create/start.
3. Sentinel file write/read.
4. Backup create/list/index verification (non-lambda providers).
5. Host stop/start and persistence check.
6. Cleanup (hard workspace delete with delayed backup purge + host delete by default).

Before provisioning cloud resources, smoke now performs an R2 backup auth preflight
when `SMOKE_CLOUD_VERIFY_BACKUP=1`:

- validates `r2_api_token` against Cloudflare API,
- validates S3 credentials against the latest recorded backup bucket (if one exists).

Useful toggles:

- `SMOKE_CLOUD_PROVIDERS`: provider list (`gcp,nebius,hyperstack,lambda`) or `all`.
- `SMOKE_CLOUD_SCENARIO`: `persistence`, `drain`, `move`, `apps`, or `apps-static`.
- `SMOKE_CLOUD_CONTINUE_ON_FAILURE=1`: keep running other providers after one fails.
- `SMOKE_CLOUD_EXECUTION_MODE=cli|direct`: defaults to `cli`.
- `SMOKE_CLOUD_VERIFY_BACKUP=1`: defaults to `1`.
- `SMOKE_CLOUD_CLEANUP_SUCCESS=1`: defaults to `1`.
- `SMOKE_CLOUD_CLEANUP_FAILURE=1`: defaults to `1`; now also does tag-based fallback cleanup.
- `SMOKE_CLOUD_BACKUP_PREFLIGHT=1`: defaults to `1` (set `0` to skip auth preflight).
- `SMOKE_CLOUD_RESULT_DIR`: directory for per-provider JSON results (default `src/.local/smoke-cloud`).

Each provider run now gets a unique `run_tag` and writes a result JSON file, and
the wrapper prints a PASS/FAIL matrix summary at the end.

Examples:

```bash
SMOKE_CLOUD_PROVIDERS=gcp pnpm --dir src smoke:cloud-host
SMOKE_CLOUD_PROVIDERS=gcp SMOKE_CLOUD_SCENARIO=apps-static pnpm --dir src smoke:cloud-host
SMOKE_CLOUD_PROVIDERS=all SMOKE_CLOUD_CONTINUE_ON_FAILURE=1 pnpm --dir src smoke:cloud-host
```

## Launchpad Codex smoke

```bash
pnpm --dir src smoke:codex-launchpad -- --project <project-id>
```

This runs a focused smoke against the real routed `project codex exec` path:

1. Resolves the effective Codex auth/payment source for the project.
2. Stops the project first by default, so the Codex turn must autostart it.
3. Runs one Codex turn and verifies a real upstream thread id is returned.
4. Runs a second turn with `--session-id <thread-id>` and verifies context resume.
5. For site-key auth, waits for a new `codex-site-key` metering row in
   `openai_chatgpt_log`.

Notes:

- The script refreshes `dev:hub:env` automatically before each `cocalc` call.
- It expects a local hub dev stack with Postgres available via
  `scripts/dev/hub-daemon.sh status`.
- By default it verifies site-key metering automatically when the resolved
  payment source is `site-api-key`.

Example:

```bash
pnpm --dir src smoke:codex-launchpad -- --project 3a05a2be-2018-41c6-8aa7-a7e0085b4bab
```

## Multibay reconnect smoke

```bash
pnpm --dir src smoke:multibay-reconnect -- --project <project-id>
```

This is a focused local 3-bay control-plane smoke for the reconnect-sensitive
paths that recently broke:

1. Restarts the local hub + attached bays by default.
2. Refreshes `dev:hub:env` before every `cocalc` invocation.
3. Verifies `host list` includes the requested hosts.
4. Verifies `host get` works for `host1` and `host2` by default.
5. Verifies `project get` and `project logs` on the target project.
6. Stops and starts the project again by default.
7. Runs `project exec` and requires an `EXEC_OK` marker in stdout.

Useful options:

- `--host <name>` to check different host names (repeatable).
- `--no-restart` to reuse an already-running stack.
- `--no-stop-start` to avoid changing project state during the smoke.
- `--timeout <ms>` to widen CLI/RPC timeouts.
- `--tail <n>` to control fetched runtime log lines.

Example:

```bash
pnpm --dir src smoke:multibay-reconnect -- \
  --project b0917d32-d749-4dd4-a527-aa306144233a
```

## Project orphan recovery smoke

```bash
pnpm --dir src smoke:project-orphan-recovery -- \
  --project <project-id> \
  --yes-destructive
```

This is a destructive local smoke for the conmon/libpod orphan-recovery path
on disposable multibay hosts. It is designed for hosts like `host2` on
`lite4b`, where direct SSH access and sudo are available.

What it does:

1. Ensures the target project is running on the expected host.
2. Verifies a clean baseline: exactly one podman container row and one main
   `conmon` tree for the project.
3. Deliberately deletes that live container's libpod DB rows from the host's
   rootless podman SQLite DB.
4. Verifies `podman ps` loses the project while the `conmon` tree remains live.
5. Stops the project through the normal routed control plane.
6. Verifies the fallback recovery path actually removed the orphaned live
   process tree.
7. Starts the project again and requires exactly one normal container/tree.

Notes:

- `--yes-destructive` is required because this edits the host's rootless podman
  DB directly.
- The default host is `host2`; override with `--host` and `--ssh-target` if
  needed.
- Use `--keep-db-backup` if you want to retain the host-side DB backup file for
  inspection after a passing run.

Example:

```bash
pnpm --dir src smoke:project-orphan-recovery -- \
  --project b0917d32-d749-4dd4-a527-aa306144233a \
  --yes-destructive
```

## Host density smoke

```bash
pnpm --dir src smoke:host-density -- \
  --host host1 \
  --ssh-target host \
  --tiers 5,10,25 \
  --batch-size 5
```

This is a local multibay host-capacity canary for measuring how one project
host behaves as more projects are placed and started on it.

What it does:

1. Creates disposable projects pinned to one requested host.
2. Starts them in batches up to each requested tier.
3. Samples host state over SSH after each tier:
   - CPU/load average
   - memory usage
   - disk usage
   - `conmon` / `cloudflared` / `project-host` process counts
   - `podman` running/all project counts
   - network RX/TX delta over a configurable interval
4. Optionally keeps one live terminal session per started project when
   `--active-terminal` is enabled, so the sampled tier reflects active running
   workloads instead of only opened-state projects.
5. Optionally runs `project exec` on the first and last project at each tier
   when `--exec-smoke` is enabled.
6. Stops and soft-deletes the created projects by default, then records a final
   post-cleanup sample.

Useful options:

- `--tier <n>` or `--tiers <a,b,c>` to control the density steps.
- `--batch-size <n>` to control concurrent starts/stops/deletes.
- `--network-sample-seconds <n>` to lengthen or shorten the per-tier traffic sample.
- `--settle-seconds <n>` to wait after each tier before sampling.
- `--rootfs-image <image>` or `--rootfs-image-id <id>` to force the same runtime image.
- `--keep-projects` to leave the created projects in place for manual follow-up.
- `--active-terminal` to keep one `bash -lc 'echo DENSITY_ACTIVE; sleep ...'`
  terminal alive per started project during sampling.
- `--terminal-hold-seconds <n>` to control how long those active terminals stay alive.
- `--exec-smoke` to require a routed `project exec` check on the first and last
  project at each tier.

For an active-density canary with real terminal sessions kept alive:

```bash
pnpm --dir src smoke:host-density -- \
  --host host1 \
  --ssh-target host \
  --tiers 5,10 \
  --batch-size 5 \
  --active-terminal \
  --terminal-hold-seconds 900 \
  --rootfs-image buildpack-deps:noble-scm
```

For a quick local sanity check without much churn:

```bash
pnpm --dir src smoke:host-density -- \
  --host host1 \
  --ssh-target host \
  --tiers 1,2 \
  --batch-size 1 \
  --network-sample-seconds 5 \
  --settle-seconds 3
```

## Multibay browser QA

```bash
COCALC_MULTIBAY_QA_PASSWORD='<password>' \
pnpm --dir src qa:multibay-browser -- \
  --base-url https://lite4b.cocalc.ai \
  --project <project-id> \
  --email <test-account@example.com> \
  --project-title '<visible project title>'
```

This runs a real Chromium browser against a stable public multibay URL. It opens
the project while signed out, verifies that the sign-in target preserves the
stable `/projects/<id>` path, signs in as the supplied test account, and checks
that the final browser URL is still on the stable site URL. It then uses the
signed-in browser app runtime to read project storage quota/overview, snapshot
usage, backups, and first-backup root files through the same Conat routing that
the UI uses.

Useful options:

- `--scenario sign-in-target`, `--scenario storage-archives`,
  `--scenario invite-redeem`, `--scenario invite-edge-cases`,
  `--scenario project-lifecycle`, `--scenario reconnect-stable-url`, or
  `--scenario sign-up-home-bay` to run one check.
- `--allow-empty-backups` for fixtures that should not require an existing backup.
- `--allow-empty-snapshots` for fixtures that should not require snapshots.
- `--headed` to watch the Chromium run.
- `--json` for machine-readable output.

Run the account-to-account invite/redeem matrix scenario with an inviter account
that already has project access and a disposable invitee account that does not:

```bash
COCALC_MULTIBAY_QA_OWNER_PASSWORD='<owner-password>' \
COCALC_MULTIBAY_QA_INVITEE_PASSWORD='<invitee-password>' \
pnpm --dir src qa:multibay-browser -- \
  --scenario invite-redeem \
  --base-url https://lite4b.cocalc.ai \
  --project <project-id> \
  --project-title '<visible project title>' \
  --owner-email <owner@example.com> \
  --invitee-email <invitee@example.com>
```

For disposable repeatable fixtures, add `--invite-reset-before` to remove the
invitee from the project before creating the invite. Add
`--invite-cleanup-after` only when the invitee should not remain a collaborator
after the run.

Run the mutating invite edge-case scenario against disposable invitee accounts
to cover duplicate invite creation, revoke, already-collaborator rejection,
remove collaborator, and re-invite/redeem. Repeat this scenario with one
invitee account homed on each bay to cover cross-bay inbox projection:

```bash
COCALC_MULTIBAY_QA_OWNER_PASSWORD='<owner-password>' \
COCALC_MULTIBAY_QA_INVITEE_PASSWORD='<invitee-password>' \
pnpm --dir src qa:multibay-browser -- \
  --scenario invite-edge-cases \
  --base-url https://lite4b.cocalc.ai \
  --project <project-id> \
  --project-title '<visible project title>' \
  --owner-email <owner@example.com> \
  --invitee-email <invitee-on-one-bay@example.com>
```

Run the opt-in lifecycle matrix scenario when it is acceptable for the fixture
project to be started, restarted, stopped, and started again. The scenario
leaves the project running and verifies a terminal-backed file marker after
start and restart:

```bash
COCALC_MULTIBAY_QA_PASSWORD='<password>' \
pnpm --dir src qa:multibay-browser -- \
  --scenario project-lifecycle \
  --base-url https://lite4b.cocalc.ai \
  --project <project-id> \
  --project-title '<visible project title>' \
  --email <test-account@example.com> \
  --timeout 120000
```

Run the stable URL reconnect scenario to validate that a signed-in browser can
survive a network flap without leaving the stable public origin and can still
read routed project state afterward:

```bash
COCALC_MULTIBAY_QA_PASSWORD='<password>' \
pnpm --dir src qa:multibay-browser -- \
  --scenario reconnect-stable-url \
  --base-url https://lite4b.cocalc.ai \
  --project <project-id> \
  --project-title '<visible project title>' \
  --email <test-account@example.com>
```

Run the sign-up home-bay scenario to create a disposable account through the
stable public URL, assert the selected home bay, then sign in again from a fresh
browser context. This scenario does not require `--project`:

```bash
COCALC_MULTIBAY_QA_PASSWORD='<password>' \
pnpm --dir src qa:multibay-browser -- \
  --scenario sign-up-home-bay \
  --base-url https://lite4b.cocalc.ai \
  --email <new-test-account@example.com> \
  --registration-token <registration-token> \
  --expected-home-bay bay-2
```

## Codex long-thread benchmark

```bash
pnpm --dir src bench:codex-thread -- --thread-id <codex-thread-id>
```

This runs a real `codex app-server` turn against an existing upstream thread and
prints JSON metrics for:

1. thread resume wall time
2. time to first backend activity
3. time to first visible model output
4. total turn wall time
5. peak RSS of the app-server process
6. `.codex/sessions` and root sqlite growth during the turn

Useful options:

- `--codex-home <path>` to benchmark a specific Lite/Launchpad `CODEX_HOME`
- `--cwd <path>` to control the runtime working directory
- `--prompt <text>` to use a custom follow-up prompt
- `--sample-ms <ms>` to adjust RSS polling frequency

Example against the local Lite daemon home:

```bash
HOME=/home/wstein/scratch/cocalc-lite4-lite-daemon \
CODEX_HOME=/home/wstein/scratch/cocalc-lite4-lite-daemon/.codex \
pnpm --dir src bench:codex-thread -- \
  --thread-id e9732ad2-c7a2-4dcc-bd60-96276ee41df5 \
  --cwd /home/wstein/scratch/cocalc-lite4-lite-daemon
```
