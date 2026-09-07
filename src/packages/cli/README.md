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

- Linux: `src/packages/cli/build/sea/cocalc-cli-<version>-<arch>-linux.tar.gz`
- macOS: `src/packages/cli/build/sea/cocalc-cli-<version>-arm64-darwin`
- Windows: `src/packages/cli/build/sea/cocalc-cli-<version>-x86_64-windows.exe`

The native builder requires an official Node.js 26 distribution with SEA
enabled. In particular, Homebrew's Node.js build currently disables SEA. To
build from a bundle produced on another machine:

```bash
node src/packages/cli/sea/build-sea.mjs \
  --bundle /path/to/index.js \
  --release-id my-candidate
```

The same NCC bundle is intentionally used by all native builders. Each output
is still constructed and executed on its target operating system and CPU.

Publish commands:

```bash
pnpm --dir src/packages/cli publish:sea
pnpm --dir src/packages/cli publish:sea:signed
pnpm --dir src/packages/cli publish:site
```

The manual publishers remain useful for development, but production CLI
releases should use the **Release CoCalc CLI** GitHub Actions workflow. It builds
and verifies these native artifacts under one immutable release ID:

- Linux amd64 on `blacksmith-8vcpu-ubuntu-2404`
- Linux arm64 on `blacksmith-8vcpu-ubuntu-2404-arm`
- macOS arm64 on `blacksmith-6vcpu-macos-15`
- Windows amd64 on `blacksmith-4vcpu-windows-2025`

The workflow defaults to the `candidate` channel. Choose `none` to build,
sign, notarize, and retain the workflow artifacts without publishing them.
Choose `stable` only after candidate testing; stable promotion also updates the
legacy `latest` manifests.

### GitHub release credentials

In the GitHub repository, open **Settings → Environments** and create these two
protected environments. Configure required reviewers for both environments.

`cocalc-cli-signing` contains the Apple credentials:

- `APPLE_DEVELOPER_ID_P12_BASE64`: base64 of a Developer ID Application
  certificate and its private key exported as a password-protected `.p12`
- `APPLE_DEVELOPER_ID_P12_PASSWORD`: password used when exporting the `.p12`
- `APPLE_NOTARY_KEY_P8_BASE64`: base64 of an App Store Connect API key `.p8`
- `APPLE_NOTARY_KEY_ID`: App Store Connect API key ID
- `APPLE_NOTARY_ISSUER_ID`: App Store Connect API issuer UUID

It also contains the Azure/Microsoft Artifact Signing configuration. The first
three values identify the OIDC-enabled Azure application; no Azure client
secret or code-signing private key is stored in GitHub:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT`
- `AZURE_ARTIFACT_SIGNING_PROFILE`

Create an Artifact Signing account and a **Public Trust** certificate profile,
grant the Azure application's service principal the **Artifact Signing
Certificate Profile Signer** role on that profile, and add a federated
credential to the application with this GitHub environment subject:

```text
repo:sagemathinc/cocalc-ai:environment:cocalc-cli-signing
```

Use GitHub's Azure Login action issuer and audience values:

```text
issuer:   https://token.actions.githubusercontent.com
audience: api://AzureADTokenExchange
```

Store all six values as environment secrets under **Settings -> Environments
-> cocalc-cli-signing**, not as repository variables. The workflow requests an
OIDC token only inside the protected signing environment and Microsoft holds
the signing key.

`cocalc-cli-release` contains only the R2 software publishing credentials:

- `COCALC_R2_ACCOUNT_ID`
- `COCALC_R2_ACCESS_KEY_ID`
- `COCALC_R2_SECRET_ACCESS_KEY`
- `COCALC_R2_BUCKET`
- `COCALC_R2_PUBLIC_BASE_URL`

Use `openssl` to produce single-line values for the two binary credential
files, without committing either file:

```bash
openssl base64 -A -in developer-id-application.p12
openssl base64 -A -in AuthKey_XXXXXXXXXX.p8
```

The Blacksmith GitHub App must have access to this repository. The workflow
uses GitHub, Azure, and Blacksmith-supported actions on ephemeral Blacksmith
runners.

The macOS build requires a timestamped Developer ID signature and submits a ZIP
containing the standalone binary to Apple's notary service. Apple publishes an
online ticket for a standalone executable but does not support stapling that
ticket directly to the executable.

The Windows job creates a native x64 SEA, signs and timestamps it with Microsoft
Artifact Signing, verifies the PE architecture and Authenticode signature, and
runs an install/uninstall smoke test before publication. Publishing is rejected
when Windows signing is disabled.

## Install

Linux and macOS:

```bash
curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://software.cocalc.ai/software/cocalc/install.ps1 | iex
```

The Windows installer verifies SHA-256 and requires a valid Authenticode
signature for the stable channel. It installs versioned executables under
`%LOCALAPPDATA%\CoCalc\CLI` and does not alter PATH unless it is saved to a
file and run with `-AddToPath`:

```powershell
irm https://software.cocalc.ai/software/cocalc/install.ps1 -OutFile install-cocalc.ps1
.\install-cocalc.ps1 -AddToPath
```

Rollback and uninstall use the same saved script with `-Rollback` or
`-Uninstall -RemoveFromPath`.

Native Windows supports authentication, profiles, hub/project control-plane
commands, OpenSSH integration, cloudflared download, and the per-user named-pipe
CLI daemon without Node.js, WSL, or a Unix shell. Commands that are already
unsupported in every standalone SEA, notably local Playwright browser-session
spawning, retain their explicit SEA capability error.

macOS dev signing (optional):

```bash
COCALC_CLI_SIGN_ID="Developer ID Application: Your Name (TEAMID)" \
COCALC_CLI_ENTITLEMENTS="src/packages/cli/sea/entitlements.plist" \
pnpm --dir src/packages/cli sea
```

## Run

```bash
node src/packages/cli/dist/bin/cocalc.js --help
pnpm --dir src/packages/cli exec cli --help
pnpm --dir src/packages/cli exec cocalc-cli --help
```

Daemon controls:

```bash
pnpm --dir src/packages/cli exec cli daemon start
pnpm --dir src/packages/cli exec cli daemon status
pnpm --dir src/packages/cli exec cli daemon stop
```

## Auth

This CLI connects to a hub over websocket/conat and supports:

- `--verbose` (or `COCALC_CLI_DEBUG=1`) for debug diagnostics on stderr
- `-q, --quiet` to suppress the final human-formatted result block
- `--no-daemon` to disable daemon usage for daemon-enabled commands
- `--profile <name>` (or `COCALC_PROFILE`) to select a saved auth profile
- `--api <url>` (or `COCALC_API_URL`)
- `--api-key <key>` (or `COCALC_API_KEY`)
- `--cookie <cookie>`
- `--bearer <token>`
- `--hub-password <password-or-file>` (local/dev mode; file contents are read if the path exists)
- `--account-id <uuid>` or `--account_id <uuid>` (alias)

If `--hub-password` is provided without an account id, the CLI tries to auto-select
an admin account for smoke-test workflows.

`project file ...` commands connect directly to the target project-host and use
short-lived host tokens kept in-process (no on-disk token cache). All
`project file` subcommands are daemon-enabled and auto-start the daemon unless
`--no-daemon` is set, which keeps routed host connections warm for lower latency.
These file commands do not require the project to be running.
`project sync forward ...` uses `reflect-sync` for SSH forward sessions.
Use `project file check` to run a sanity suite (mkdir/put/list/cat/get/rg/fd/rm)
against the current project context or `--project`.
Use `project file check --bench --bench-runs <n>` to run repeated checks with
per-run and per-step timing summaries.
`project codex ...` uses routed project-host APIs so codex device-auth and
project codex execution run in the same project-host containerized path as the UI.
`project codex exec --stream` prints progress events to stderr; `--jsonl`
emits raw ACP stream messages as JSONL on stdout.
`--verbose` also enables codex progress streaming automatically.

## Run And Continue Codex From The CLI

Use the project Codex command for a turn against a project-hosted runtime. Start
with the matching authenticated CLI profile and check the effective authentication/payment source:

```bash
cocalc project codex auth status --project "$COCALC_PROJECT_ID"
cocalc --json project codex exec --project "$COCALC_PROJECT_ID" \
  --session-mode read-only --stdin <<'PROMPT'
Inspect README.md and summarize the project. Do not change files.
PROMPT
```

JSON output wraps the command result under `data`: read `data.final_response`,
`data.usage`, and `data.thread_id`. For a new turn, `data.session_id` echoes the
optional input and can be null; keep `data.thread_id` as the Codex session
identifier. After that turn finishes, pass it
explicitly when continuing:

```bash
cocalc project codex exec --project "$COCALC_PROJECT_ID" \
  --session-id "$codex_thread_id" --session-mode read-only \
  "Explain the main entry points in that same project."
```

Set `codex_thread_id` to the previous result's `data.thread_id`. There is no implicit
resume-last command. This RPC command does not create a `.chat` transcript.

Human mode prints the final response; `--stream` adds progress on stderr.
`--jsonl` emits raw stream messages on stdout. Combining `--json` with `--stream`
also streams JSONL, so omit `--stream` when saving one final JSON result.
An incomplete stream reports an error; inspect session state before retrying
work that may already have changed files. See `project codex exec --help` for
model, reasoning, working-directory and session-mode options.

## Codex Runtime Environment (Agent Integration)

When CoCalc runs Codex turns with CLI/browser integration enabled, turns may
inherit these env vars:

- `COCALC_API_URL`
- `COCALC_BEARER_TOKEN`
- `COCALC_ACCOUNT_ID`
- `COCALC_PROJECT_ID`
- `COCALC_BROWSER_ID`
- `COCALC_CLI_CMD` (preferred exact command string)
- `COCALC_CLI_BIN` (optional explicit path)
- `COCALC_CLI_AGENT_MODE` (`1` enables machine-friendly defaults: JSON output unless explicitly overridden)

Recommended browser automation pattern inside a turn:

```bash
cocalc browser exec-api --browser "$COCALC_BROWSER_ID"
cocalc browser exec \
  --project-id "$COCALC_PROJECT_ID" \
  --browser "$COCALC_BROWSER_ID" \
  --file script.js
# if the session is stale after a frontend rebuild:
cocalc browser action reload --browser "$COCALC_BROWSER_ID" --posture prod
# best-effort hard refresh:
cocalc browser action reload --browser "$COCALC_BROWSER_ID" --posture prod --hard
```

Exec posture note:

- `--posture dev`: raw browser JS exec is allowed by default.
- `--posture prod`: sandboxed exec is the default; raw exec requires policy
  opt-in (`allow_raw_exec=true`).

If you need an isolated browser target (instead of the developer's live tab),
spawn a dedicated Playwright-backed Chromium session:

```bash
# spawn defaults to headless; add --headed for a visible window
cocalc browser session spawn --use
cocalc browser session spawned
# ... run browser exec/open/screenshot commands ...
cocalc browser session destroy <spawn_id_or_browser_id>
```

For scoped/agent tokens, prefer `--project-id` + `--browser` (or the matching
env vars) to avoid discovery calls that may require broader hub permissions.

## Auth Commands

- `auth status [--check]`
- `auth list`
- `auth login [--profile <name>] [--api ...] [--api-key ...] [--account-id ...]`
- `auth setup ...` (alias for `auth login`)
- `auth rename <from> <to>`
- `auth use <profile>`
- `auth logout [--target-profile <name>]`
- `auth logout --all`

Example:

```bash
cocalc --profile alice --api https://lite4b.cocalc.ai auth login --email alice@example.com
```

## Phase 0 Commands

- `plus ...` (forward to `cocalc-plus`; installs if missing)
- `launchpad ...` (forward to `cocalc-launchpad`; installs if missing)
- `daemon start`
- `daemon status`
- `daemon stop`
- `project create`
- `project rename`
- `project use`
- `project unuse`
- `project list`
- `project start --wait`
- `project stop`
- `project restart --wait`
- `project exec`
- `project ssh`
- `project ssh --check`
- `project ssh --check --require-auth`
- `project move --host --wait`
- `project copy-path --wait`
- `project sync key ensure`
- `project sync key show`
- `project sync key install`
- `project sync forward create`
- `project sync forward list`
- `project sync forward terminate`
- `project file list`
- `project file cat`
- `project file put`
- `project file get`
- `project file rm`
- `project file mkdir`
- `project file rg`
- `project file fd`
- `project file check`
- `project codex exec`
- `project codex auth status`
- `project codex auth subscription login`
- `project codex auth subscription status`
- `project codex auth subscription cancel`
- `project codex auth subscription upload`
- `project codex auth api-key status`
- `project codex auth api-key set`
- `project codex auth api-key delete`
- `project snapshot create`
- `project snapshot list`
- `project snapshot restore`
- `host resolve-connection`
- `host issue-http-token`
- `admin search`
- `admin user create`
- `admin user ban`
- `admin user unban`
- `admin user issue-impersonation-link`
- `project proxy url`
- `project proxy curl`
- `op list`
- `op get`
- `op wait`
- `op cancel`
