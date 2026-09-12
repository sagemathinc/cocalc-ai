# CoCalc Plus

CoCalc Plus is the productized wrapper around the lightweight core shipped in `@cocalc/lite`. It exists so we can ship a branded, single-machine experience without duplicating the underlying hub/server/database logic.

## Role

- Builds directly on the Lite core for a single-user CoCalc experience.
- Adds only product-level defaults (branding, configuration presets, packaging), not new logic.
- Serves as the public entry point for the “CoCalcPlus” SKU while keeping shared code in [../lite](../lite/README.md).

## Change Discipline

- Keep implementation in Lite. If a feature is useful beyond Plus, add it to Lite rather than here.
- Plus should remain declarative: configuration, presets, and packaging only; no podman/btrfs/ssh plumbing.
- Avoid introducing new dependencies unless they belong in Lite. Treat Plus as a thin layer to keep the dependency graph clean.
- When Lite gains new capabilities, Prefer re-exporting or configuring them here instead of re-implementing.

## Getting Started

- Build with `pnpm --filter @cocalc/plus build`.
- At runtime this package re-uses Lite’s entry points; product-specific CLI and packaging live here.

## CoCalc Star Remote Installer

`cocalc-plus` can also manage the zero-conf Star install path on a dedicated
remote Ubuntu VM:

```sh
cocalc-plus star ubuntu@1.2.3.4
```

This SSHs to the target, checks whether CoCalc Star is already installed, runs
the public `install-cocalc-star.sh` installer with passwordless `sudo` when
needed, and opens an SSH tunnel from your laptop to the remote Star instance.

Useful variants:

```sh
cocalc-plus star ubuntu@1.2.3.4 --status-only
cocalc-plus star ubuntu@1.2.3.4 --local-port 9500 --no-open
cocalc-plus star ubuntu@1.2.3.4 --upgrade
```

Star is a whole-machine appliance install. Run this only on a VM intended for
CoCalc Star; it requires SSH access and passwordless `sudo` on the target.

## Base URL / Proxy Behavior

`cocalc-plus` now follows a code-server style model for URL prefixing:

- The app does **not** require compile-time `BASE_PATH` configuration.
- It works when a reverse proxy strips a fixed prefix and forwards to the Plus server.
- Redirects from non-SPA routes preserve the current prefix (using relative redirects), so deep links under a proxy continue to work.

Examples:

- Direct access: `http://localhost:30002`
- Behind strip-prefix proxy: external `https://example.com/tools/cocalc/...` forwarded to `http://127.0.0.1:30002/...`

Notes:

- This behavior is for Lite/Plus static app routing and project routes.
- `/port/...` style proxying remains a separate mechanism (primarily used for JupyterLab-style apps), and is not the target model for Plus base-URL behavior.

## Packaging & Distribution

- **Bundle**: `pnpm --filter @cocalc/plus build:bundle` (uses ncc to bundle `bin/start.js` and copies static assets).
- **Tarball**: `pnpm --filter @cocalc/plus build:tarball` (creates `packages/plus/build/bundle.tar.xz`).
- **SEA binary**: `pnpm --filter @cocalc/plus sea` (produces compressed SEA artifact under `packages/plus/build/sea`).
- **Electron**: `pnpm --filter @cocalc/plus app-electron` for desktop runs; adjust signing/notarization via `sea/Makefile` on macOS.

### Native Windows preview

The native Windows build runs the Lite/Plus server directly on Windows; it
does not use WSL. Its default locations are:

- workspace: `%USERPROFILE%\CoCalc`
- application data: `%LOCALAPPDATA%\CoCalc\Plus`
- command launcher: `%LOCALAPPDATA%\CoCalc\bin\cocalc-plus.cmd`

Set `COCALC_PLUS_WORKSPACE`, `COCALC_PLUS_HOME`, or `COCALC_DATA_DIR` before
launching to override these paths. Terminals use PowerShell through Windows
ConPTY. The release smoke test starts the installed application and exercises
the HTTP app, project file service, and a real PowerShell terminal.

Run the **Build CoCalc Plus for Windows** workflow to create a tested portable
ZIP. For a locally built ZIP:

```powershell
.\src\packages\plus\install.ps1 `
  -ArchivePath .\cocalc-plus-<release>-x86_64-windows.zip `
  -AddToPath

cocalc-plus
```

The installer keeps application versions separate from the workspace and
supports `-Rollback` and `-Uninstall`. Uninstall recursively removes the selected
installation root and launcher. The default workspace is outside that root and
is retained; keep a custom workspace or other user data outside `-InstallRoot`
if it must survive uninstall.

Packaging artifacts are intended for redistribution; keep core runtime changes in Lite so Plus remains a thin product wrapper. The CLI `cocalc-plus` delegates to `@cocalc/lite/bin/start` (no extra build required), and Electron uses `electron.js` as the main entry.
