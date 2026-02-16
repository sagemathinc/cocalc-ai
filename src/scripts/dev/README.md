# Local Hub Daemon + Self-Host Smoke

## One-time setup

```bash
pnpm --dir src hub:daemon:init
```

This creates a local, untracked config at:

- `src/.local/hub-daemon.env`

Edit that file as needed.

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
4. Runs self-host multipass backup smoke test end-to-end.

You can override behavior via variables in `src/.local/hub-daemon.env`.
