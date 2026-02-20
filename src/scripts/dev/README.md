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
SMOKE_CLOUD_PROVIDERS=all SMOKE_CLOUD_CONTINUE_ON_FAILURE=1 pnpm --dir src smoke:cloud-host
```
