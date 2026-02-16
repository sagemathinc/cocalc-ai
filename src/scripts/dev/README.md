# Local Hub Daemon + Self-Host Smoke

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
3. Starts hub daemon (if not running).
4. Runs self-host multipass smoke tests end-to-end, including:
   - cross-project file copy (project A -> project B),
   - backup indexing,
   - optional move/restore to a second host.

You can override behavior via variables in `src/.local/hub-daemon.env`.
For smoke-only toggles, set environment variables when invoking, e.g.:

```bash
SMOKE_VERIFY_COPY_BETWEEN_PROJECTS=0 pnpm --dir src smoke:self-host
```
