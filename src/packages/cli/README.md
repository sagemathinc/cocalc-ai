# @cocalc/cli

Commander-based CoCalc CLI (network transport via conat).

## Build

```bash
pnpm --dir src/packages/cli build
```

## Bundle + SEA

```bash
pnpm --dir src/packages/cli build:bundle
pnpm --dir src/packages/cli sea
pnpm --dir src/packages/cli sea:signed
```

SEA output binary:

- `src/packages/cli/build/sea/cocalc-cli-<version>-<arch>-<os>`
- symlink: `src/packages/cli/build/sea/cocalc-cli`

Publish commands:

```bash
pnpm --dir src/packages/cli publish:sea
pnpm --dir src/packages/cli publish:sea:signed
pnpm --dir src/packages/cli publish:site
```

macOS dev signing (optional):

```bash
COCALC_CLI_SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
COCALC_CLI_ENTITLEMENTS="src/packages/cli/sea/entitlements.plist" \
pnpm --dir src/packages/cli sea
```

## Run

```bash
node src/packages/cli/dist/bin/cocalc.js --help
```

## Auth

This CLI connects to a hub over websocket/conat and supports:

- `--profile <name>` (or `COCALC_PROFILE`) to select a saved auth profile
- `--api <url>` (or `COCALC_API_URL`)
- `--api-key <key>` (or `COCALC_API_KEY`)
- `--cookie <cookie>`
- `--bearer <token>`
- `--hub-password <password-or-file>` (local/dev mode; file contents are read if the path exists)
- `--account-id <uuid>` or `--account_id <uuid>` (alias)

If `--hub-password` is provided without an account id, the CLI tries to auto-select
an admin account for smoke-test workflows.

## Auth Commands

- `auth status [--check]`
- `auth list`
- `auth login [--profile <name>] [--api ...] [--api-key ...] [--account-id ...]`
- `auth setup ...` (alias for `auth login`)
- `auth use <profile>`
- `auth logout [--target-profile <name>]`
- `auth logout --all`

## Phase 0 Commands

- `plus ...` (forward to `cocalc-plus`; installs if missing)
- `launchpad ...` (forward to `cocalc-launchpad`; installs if missing)
- `workspace create`
- `workspace list`
- `workspace start --wait`
- `workspace exec`
- `workspace ssh`
- `workspace ssh --check`
- `workspace ssh --check --require-auth`
- `workspace move --host --wait`
- `workspace copy-path --wait`
- `workspace snapshot create`
- `workspace snapshot list`
- `host resolve-connection`
- `host issue-http-token`
- `workspace proxy url`
- `workspace proxy curl`
