# @cocalc/cli

Commander-based CoCalc CLI (network transport via conat).

## Build

```bash
pnpm --dir src/packages/cli build
```

## Run

```bash
node src/packages/cli/dist/bin/cocalc.js --help
```

## Auth

This CLI connects to a hub over websocket/conat and supports:

- `--api <url>` (or `COCALC_API_URL`)
- `--api-key <key>` (or `COCALC_API_KEY`)
- `--cookie <cookie>`
- `--bearer <token>`
- `--hub-password <password-or-file>` (local/dev mode; file contents are read if the path exists)
- `--account-id <uuid>` or `--account_id <uuid>` (alias)

If `--hub-password` is provided without an account id, the CLI tries to auto-select
an admin account for smoke-test workflows.

## Phase 0 Commands

- `workspace create`
- `workspace list`
- `workspace start --wait`
- `workspace exec`
- `workspace ssh`
- `workspace move --host --wait`
- `workspace copy-path --wait`
- `workspace snapshot create`
- `workspace snapshot list`
- `host resolve-connection`
- `host issue-http-token`
- `workspace proxy url`
- `workspace proxy curl`
