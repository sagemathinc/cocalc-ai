# CoCalc CLI Interface Plan

## Goals

- Provide a single, scriptable CLI for CoCalc Launchpad and related products.
- Use user-facing terminology: `workspace` (with alias `ws`) instead of `project`.
- Cover both major control-plane entities:
  - workspaces
  - hosts
- Match the practical ergonomics of Sprites CLI (auth, list/create/use, exec/console, proxy URL workflows).
- Make CoCalc AI-agent-friendly by exposing stable, scriptable primitives for files, search, notebooks, and browser-session automation.
- Keep implementation SEA-friendly:
  - JS/TS only
  - no native compiled dependencies in the core CLI path
  - single-file bundle for SEA without extraction of native addons

## Non-goals (initially)

- Replacing every internal admin operation on day one.
- Building a full TUI dashboard.
- Supporting every edge-case interactive flow before scriptable flows are stable.

## Product Naming and Command Identity

- Binary name: `cocalc`
- Primary noun: `workspace`
- Alias: `ws`
- Keep internal code references to "project" in adapters only.

Examples:

```bash
cocalc workspace list
cocalc ws create my-notebook
cocalc ws exec my-notebook -- uname -a
```

## CLI Design Principles

- API-first, script-first:
  - every command supports stable machine output via `--json`
  - deterministic exit codes
- Human mode should remain concise and readable.
- Strongly typed command adapters so TypeScript catches API drift during build.
- Resource targeting should be flexible:
  - by id
  - by name
  - by active context (`use`)
- Consistent verb structure:
  - `list`, `get`, `create`, `update`, `delete`
  - `start`, `stop`, `restart`
  - `move`, `copy`, `restore`

## Global UX Contract

All commands support:

- `--json` machine-readable output
- `--output table|json|yaml` (default `table` in human mode, using ascii-table3)
- `--quiet`
- `--verbose`
- `--org <org>` or equivalent context selector
- `--profile <name>` config profile
- `--api <url>` override base API URL
- `--timeout <duration>` for blocking operations
- `--wait` for asynchronous operations that can be waited on

## Tooling Choices

- Command parser framework: `commander` (required) to avoid ad hoc argument parsing drift.
- Human tables: `ascii-table3` (required) for compact, stable terminal formatting.
- Keep command and output wiring centralized so global options (`--json`, `--wait`, `--timeout`) behave identically everywhere.

## Exit Code Contract

Proposed standardized exit codes:

- `0` success
- `1` usage/validation error
- `2` auth error
- `3` permission denied
- `4` not found
- `5` conflict/precondition failed
- `6` timeout
- `7` network/transport error
- `8` server/internal error

## Config and Context Model

Config file:

- `~/.config/cocalc/config.json` (Linux/macOS)
- `%APPDATA%/cocalc/config.json` (Windows)

Context layers:

1. command flags
2. env vars
3. active profile config
4. defaults

Suggested env vars:

- `COCALC_API_URL`
- `COCALC_TOKEN`
- `COCALC_PROFILE`
- `COCALC_ORG`
- `COCALC_OUTPUT`

Local directory context files:

- `.cocalc-workspace` (active workspace id/name for current directory)
- `.cocalc-org` (optional org affinity)

## Authentication Model

### Commands

```bash
cocalc auth login [--api <url>] [--org <org>] [--token <token>]
cocalc auth setup --token <token>
cocalc auth status
cocalc auth logout [--all] [--force]
cocalc auth list
cocalc auth use <profile-or-org>
```

### Keyring strategy (SEA-friendly)

Phase strategy:

1. Default encrypted-at-rest file token storage using Node crypto (no native deps).
2. Optional keyring integration via subprocess wrappers (not native Node addons):
   - macOS `security`
   - Linux `secret-tool` or `pass`
   - Windows `cmdkey`/Credential Manager bridge
3. Explicit command toggles:

```bash
cocalc auth keyring enable
cocalc auth keyring disable
```

This preserves single-file SEA reliability while leaving room for OS-native storage later.

## Top-Level Command Surface (Full Plan)

### 1) Workspace lifecycle (`workspace` / `ws`)

```bash
cocalc workspace create [name] [--host <host>] [--json]
cocalc workspace list [--prefix <name>] [--state <state>] [--json]
cocalc workspace get <workspace>
cocalc workspace use <workspace>
cocalc workspace unuse
cocalc workspace rename <workspace> <new-name>
cocalc workspace delete <workspace> [--force]
cocalc workspace start <workspace> [--wait]
cocalc workspace stop <workspace> [--wait]
cocalc workspace restart <workspace> [--wait]
```

Notes:

- `<workspace>` accepts id or name.
- `use` writes local `.cocalc-workspace`.

### 2) Workspace access and execution

```bash
cocalc workspace exec <workspace> -- <cmd...>
cocalc workspace ssh <workspace> [ssh-args...]
cocalc workspace console <workspace>
cocalc workspace terminal <workspace>
cocalc workspace sync up <workspace> --local <dir> --remote <path> [--watch]
cocalc workspace sync down <workspace> --remote <path> --local <dir>
cocalc workspace sync bidir <workspace> --local <dir> --remote <path> [--watch]
```

Notes:

- `workspace sync` is planned to use `reflect-sync` under the hood for fast SSH-based incremental sync.

### 3) Workspace file operations

```bash
cocalc workspace file list <workspace> [path]
cocalc workspace file cat <workspace> <path>
cocalc workspace file put <workspace> <src> <dest>
cocalc workspace file get <workspace> <path> <local-dest>
cocalc workspace file rm <workspace> <path>
cocalc workspace file rg <workspace> <pattern> [path] [-- <rg-args...>]
cocalc workspace file fd <workspace> [pattern] [path] [-- <fd-args...>]
```

Notes:

- Workspace file operations should work even when the workspace is stopped, whenever possible, by routing through project-host file services instead of requiring runtime startup.
- `rg`/`fd` support is explicitly included for AI-agent productivity.

### 4) Workspace transfer and placement

```bash
cocalc workspace move <workspace> --host <host> [--wait]
cocalc workspace copy-path \
  --src-workspace <ws> --src <path> \
  --dest-workspace <ws> --dest <path> [--wait]
cocalc workspace placement <workspace>
```

### 5) Workspace snapshots (fast btrfs) and backups (durable rustic)

```bash
cocalc workspace snapshot create <workspace>
cocalc workspace snapshot list <workspace>
cocalc workspace snapshot info <workspace> <snapshot>
cocalc workspace snapshot delete <workspace> <snapshot>
cocalc workspace snapshot restore-path <workspace> --snapshot <id> --path <src> [--dest <dest>] [--wait]
cocalc workspace snapshot restore-all <workspace> --snapshot <id> [--wait]

cocalc workspace backup create <workspace> [--wait]
cocalc workspace backup list <workspace>
cocalc workspace backup files <workspace> --backup <id> [path]
cocalc workspace backup restore-path <workspace> --backup <id> --path <src> [--dest <dest>] [--wait]
cocalc workspace backup restore-all <workspace> --backup <id> [--wait]
```

Notes:

- `snapshot` is the canonical CLI term for CoCalc btrfs snapshots (faster than backup/checkpoint systems that scale with data size).
- `backup` is for rustic/off-host durability and is slower.
- Current backend capability is path restore; `restore-all` is intentionally included in the interface plan as a target capability to implement.
- Optional compatibility aliases can be provided later: `checkpoint` -> `snapshot`.

### 6) Workspace HTTP proxy / app URL workflows

```bash
cocalc workspace proxy url <workspace> --port <port> [--host <host>] [--open]
cocalc workspace proxy token issue <workspace> --host <host> [--ttl <seconds>]
cocalc workspace proxy curl <workspace> --port <port> [--host <host>] [--path <path>]
```

Rationale:

- This aligns with your smoke-test need to verify denied access without token and allowed access with token.
- It can compose existing host-connection and token issuance APIs.

### 7) Host lifecycle and operations

```bash
cocalc host list [--all] [--json]
cocalc host get <host>
cocalc host create <name> [--region ...] [--size ...]
cocalc host start <host> [--wait]
cocalc host stop <host> [--wait]
cocalc host restart <host> [--wait]
cocalc host deprovision <host> [--wait] [--force]

cocalc host software upgrade <host> [--target all|project-host|project]
cocalc host connector upgrade <host> [--version <v>]
cocalc host logs <host> [--follow]
cocalc host resolve-connection <host>
cocalc host issue-http-token --host <host> [--workspace <workspace>] [--ttl <seconds>]
```

### 8) Long-running operations (`op`)

```bash
cocalc op list [--scope workspace|host] [--id <id>]
cocalc op get <op-id>
cocalc op wait <op-id> [--timeout 5m]
cocalc op cancel <op-id>
```

### 9) Utility/admin commands

```bash
cocalc doctor
cocalc config get [key]
cocalc config set <key> <value>
cocalc config list
cocalc version
```

### 10) Browser session automation (future)

```bash
cocalc browser session list
cocalc browser use <session-id>
cocalc browser files
cocalc browser open <path>
cocalc browser exec <script.js|->
```

Notes:

- This is for agent/human collaboration workflows where a turn is associated with a browser session id.
- `browser exec` should run in a constrained frontend API sandbox (e.g., restricted Redux helpers with approval boundaries).

### 11) Notebook operations (future)

```bash
cocalc workspace jupyter --path <ipynb> run <cell-id...>
cocalc workspace jupyter --path <ipynb> add --after <cell-id> [--type code|markdown] [--source <text>]
cocalc workspace jupyter --path <ipynb> delete <cell-id...>
cocalc workspace jupyter --path <ipynb> move <cell-id> --before <cell-id>
cocalc workspace jupyter --path <ipynb> list-cells
```

Notes:

- Cell-id-addressable operations are preferred for deterministic agent workflows.
- Follow-up can add execution result streaming and kernel state inspection.

### 12) Chatroom operations (future)

```bash
cocalc workspace chatroom --path <chat-path> thread list
cocalc workspace chatroom --path <chat-path> thread create --title <title> [--type codex|general]
cocalc workspace chatroom --path <chat-path> thread pin <thread-title-or-id>
cocalc workspace chatroom --path <chat-path> thread unpin <thread-title-or-id>

cocalc workspace chatroom --path <chat-path> message list [--thread <thread>] [--limit <n>]
cocalc workspace chatroom --path <chat-path> message delete --older-than 7d [--thread <thread>] [--yes]
```

Notes:

- The command surface should support common automation flows such as:
  - pinning a thread (e.g., "Todo list")
  - creating a new Codex thread
  - deleting messages older than a retention threshold
- Destructive operations (e.g., message deletion) should require explicit confirmation flags (`--yes`) and support dry-run previews where possible.
- Chatroom APIs should be exposed in a way that supports both human workflows and agent automation.

## Sprites CLI Mapping

High-level parity mapping:

- `sprite create` -> `cocalc workspace create`
- `sprite list` -> `cocalc workspace list`
- `sprite use` -> `cocalc workspace use`
- `sprite exec` -> `cocalc workspace exec`
- `sprite console` -> `cocalc workspace console`
- `sprite proxy` / `sprite url` -> `cocalc workspace proxy ...`
- `sprite checkpoint ...` -> `cocalc workspace snapshot ...`
- `sprite restore` -> `cocalc workspace backup restore-path` / `snapshot restore-path` (with `restore-all` planned)
- `sprite org/auth` -> `cocalc auth ...` and `cocalc org ...` (if needed)

CoCalc-specific extension:

- Explicit first-class `host` command tree
- Explicit workspace placement/move/copy workflows across hosts

## Command Grammar and Naming Rules

- Noun-first: `cocalc <noun> <verb> ...`
- Keep `workspace` and `ws` equivalent.
- Avoid ambiguous synonyms at launch.
- Resource identifiers:
  - accept id or exact name
  - require explicit `--id` in scripts when ambiguity exists

## Output Schemas (Stable)

`--json` success envelope:

```json
{
  "ok": true,
  "command": "workspace start",
  "data": {"workspace_id": "...", "op_id": "...", "status": "..."},
  "meta": {"api": "...", "org": "...", "duration_ms": 1234}
}
```

`--json` error envelope:

```json
{
  "ok": false,
  "command": "workspace start",
  "error": {
    "code": "permission_denied",
    "message": "...",
    "details": {}
  },
  "meta": {"request_id": "..."}
}
```

## Implementation Plan (`src/packages/cli`)

Proposed package structure:

```text
src/packages/cli/
  package.json
  tsconfig.json
  src/
    bin/cocalc.ts
    command-registry.ts
    core/
      api-client.ts
      context.ts
      config.ts
      output.ts
      errors.ts
      wait.ts
    commands/
      auth.ts
      workspace.ts
      workspace-files.ts
      workspace-snapshots.ts
      workspace-backups.ts
      host.ts
      op.ts
      browser.ts
      jupyter.ts
      chatroom.ts
      config.ts
      doctor.ts
  sea/
    build-static.sh
    build-bundle.sh
    build-sea.sh
```

Build approach:

- Follow `src/packages/plus` SEA model for consistency.
- Use static bundling (`ncc` or esbuild) to one JS entrypoint.
- Ensure all dynamic imports and file references are SEA-safe.

Dependency constraints:

- allowed: pure JS packages (`commander`, `ascii-table3`, `picocolors`, `yaml`)
- avoid: native addons (`node-pty`, `keytar`, `sqlite3`, etc.)

## Type Safety and Anti-Drift Requirements

- CLI command adapters must import and use typed request/response contracts from Conat/hub APIs where available.
- No untyped stringly-typed JSON plumbing in command handlers unless explicitly wrapped and validated.
- Add compile-time checks in CLI package build to fail on API signature drift.
- Add a small `contracts` layer in [src/packages/cli](./src/packages/cli) to isolate naming translation (`workspace` CLI <-> `project` backend).

## API Adapter Strategy

- CLI should use a thin adapter layer over existing Conat hub APIs.
- Keep protocol-specific details out of command handlers.
- Add minimal new server endpoints only when a workflow cannot be composed safely.

For your proxy smoke use-case, existing APIs appear sufficient:

- resolve host connection URL
- issue project-host HTTP auth token
- compose `/{workspace_id}/proxy/{port}/`

## Minimal MVP for Smoke Tests (First Implementation Slice)

Implement only these first:

1. `cocalc workspace create`
2. `cocalc workspace start --wait`
3. `cocalc workspace exec`
4. `cocalc workspace ssh`
5. `cocalc workspace move --host --wait`
6. `cocalc workspace copy-path --wait`
7. `cocalc workspace snapshot create`
8. `cocalc workspace snapshot list`
9. `cocalc host resolve-connection`
10. `cocalc host issue-http-token`
11. `cocalc workspace proxy url`
12. `cocalc workspace proxy curl`

This subset is enough to cleanly express the current smoke flows:

- two-host move verification
- cross-workspace copy verification
- HTTP proxy deny/allow checks with token bootstrap
- SSH and exec checks via one CLI surface
- snapshot smoke checks with fast btrfs semantics

## Example Smoke Script Flow (Future)

```bash
WS1=$(cocalc ws create smoke-a --json | jq -r '.data.workspace_id')
WS2=$(cocalc ws create smoke-b --json | jq -r '.data.workspace_id')

cocalc ws start "$WS1" --wait
cocalc ws start "$WS2" --wait

cocalc ws exec "$WS1" -- bash -lc 'mkdir -p smoke && echo hello > smoke/a.txt'

cocalc ws move "$WS1" --host "$HOST2" --wait

cocalc ws copy-path \
  --src-workspace "$WS1" --src smoke/a.txt \
  --dest-workspace "$WS2" --dest smoke/copied.txt --wait

cocalc ws exec "$WS2" -- cat smoke/copied.txt

URL=$(cocalc ws proxy url "$WS1" --port 8000 --json | jq -r '.data.url')
TOKEN=$(cocalc host issue-http-token --host "$HOST2" --workspace "$WS1" --json | jq -r '.data.token')
cocalc ws proxy curl "$WS1" --port 8000 --expect denied
cocalc ws proxy curl "$WS1" --port 8000 --token "$TOKEN" --expect ok
```

## Rollout Phases

Phase 0 (smoke-only):

- Implement MVP commands above.
- Lock JSON schemas and exit codes.
- Add CI smoke scripts using CLI.

Phase 1 (general operator usability):

- add list/get/status/stop/delete command completeness
- add full snapshot/backup command completeness (including restore-all when backend support lands)
- add `op wait` and streaming progress

Phase 2 (polish and broader parity):

- profile/org UX polish
- optional keyring backend
- workspace sync commands backed by `reflect-sync`
- browser session, Jupyter, and chatroom command families
- autocompletion (bash/zsh/fish)
- improved table output and paging

## Risks and Mitigations

- Risk: command naming drift between code (`project`) and UX (`workspace`)
  - Mitigation: adapter layer and strict naming tests on CLI help output.
- Risk: SEA bundle regressions from dynamic module patterns
  - Mitigation: single static entry, minimal dependencies, SEA integration tests.
- Risk: flaky wait logic around LRO status races
  - Mitigation: support `--wait` with postcondition verification where needed.

## Recommendation

Proceed with `src/packages/cli` and implement Phase 0 only first.

This gives immediate value for smoke tests while preserving a coherent long-term command model aligned with Sprites-style workflows and CoCalc’s host/workspace architecture.