# Local Hub Daemon + Smoke Tests

## One-time setup (optional)

```bash
pnpm --dir src hub:daemon:init
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

## Hub daemon control

```bash
pnpm --dir src hub:daemon:start
pnpm --dir src hub:daemon:status
pnpm --dir src hub:daemon:logs
pnpm --dir src hub:daemon:stop
```

## Lite daemon control

```bash
pnpm --dir src lite:daemon:init
pnpm --dir src lite:daemon:start
pnpm --dir src lite:daemon:status
pnpm --dir src lite:daemon:logs
pnpm --dir src lite:daemon:stop
```

Run Jupyter Playwright tests against the daemon instance (auto-uses daemon
connection info, so no long env prefix is needed):

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
- sqlite db: `$LITE_HOME/.local/share/cocalc-lite/hub.db` (shown in `lite:daemon:status`)

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
4. Starts hub daemon (if not running).
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

- The script refreshes `dev:env:hub` automatically before each `cocalc` call.
- It expects a local hub daemon with Postgres available via
  `scripts/dev/hub-daemon.sh status`.
- By default it verifies site-key metering automatically when the resolved
  payment source is `site-api-key`.

Example:

```bash
pnpm --dir src smoke:codex-launchpad -- --project 3a05a2be-2018-41c6-8aa7-a7e0085b4bab
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

- `--scenario sign-in-target`, `--scenario storage-archives`, or
  `--scenario project-lifecycle` to run one check.
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
