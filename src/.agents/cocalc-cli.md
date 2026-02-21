# CoCalc CLI Interface Plan

TODO:

- [ ] make sure to delete the whole "CURRENTLY NOT USED" thing in db-schema/projects.ts
- [x] implement "host stop".
- [ ] Workspaces: name versus title.  Right now we're using the workspace title (which can have any characters in it and is easy to change at any time) for naming things, which isn't great.  There's also a "name" field associated to a workspace, which is much more constrained.  We should accept that for "-w" and also change the whole UI to strongly suggest choosing a name when making a workspace.
- [ ] When making a workspace or host, show the corresponding cocalc cli command, like GCP does.   See http://localhost:7000/projects/00000000-1000-4000-8000-000000000000/files/home/wstein/build/cocalc-lite4/lite4.chat#chat=1771453636305
- [ ] We really need some good documentation for all this... in a form that is extremely AI Agent friendly(!).  E.g., it's so important to point out that this is genuine full ssh, and fully supports port forwarding, X11 forwarding.  It's not just a half-broken "ssh gateway", but the real deal. 
- [ ] client and server versioning...
- [x] rewrite all the code in the cli to benefit from typescript for the cocalc api -- http://localhost:7000/projects/00000000-1000-4000-8000-000000000000/files/home/wstein/build/cocalc-lite4/lite4.chat#chat=1771572607303 
- [x] cloudflare ssh integration.
- [x] get logs from host (i.e., /mnt/cocalc/data/log), similar to how that works with kubernetes
- [x] upgrade host (or set host to a specific version)
- [x] ssh to host (or something like "kubectl exec bash").

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

### 10) Browser session automation (active roadmap)

```bash
cocalc browser session list
cocalc browser use <session-id>
cocalc browser files
cocalc browser open <workspace> <path...>
cocalc browser close <workspace> <path...>
cocalc browser exec-api
cocalc browser exec <workspace> [code...]
cocalc browser exec <workspace> --file <script.js>
cocalc browser exec <workspace> --stdin
cocalc browser exec --async --wait ...
cocalc browser exec-get <exec-id>
cocalc browser exec-wait <exec-id>
cocalc browser exec-cancel <exec-id>
```

Notes:

- This is for agent/human collaboration workflows where a turn is associated with a browser session id.
- `browser exec` should run in a constrained frontend API sandbox (e.g., restricted Redux helpers with approval boundaries).
- The API should be expanded systematically by capability domain so agents can compose reliable automations.

### 11) Browser exec API expansion plan (agent-first)

Goal:

- Make browser automation powerful enough that a user can ask for real end-to-end help ("create notebook, run, explain, notify me"), and an agent can do it with deterministic scriptable primitives.

Design rule:

- Prefer a small number of composable primitives over many one-off commands.
- Every state-changing primitive should support approval hooks and clear audit events.
- Return data should be stable, typed, and easy for LLMs to consume.
- Design for multiple CoCalc products/environments, not Launchpad-only behavior.

#### 11.0 Product mode compatibility (`cocalc-plus` / lite vs Launchpad)

The browser exec architecture must be mode-aware:

- `launchpad` mode:
  - rich host-backed functionality
  - timetravel providers: `patchflow`, `snapshots`, `backups`, `git`
- `lite` mode (`cocalc-plus`):
  - no host backup/snapshot infrastructure
  - timetravel providers: typically `patchflow`, optionally `git`

Agent-facing implication:

- Never hardcode provider assumptions in scripts.
- Scripts should discover capabilities first, then branch.

Required primitives:

- `api.system.getCapabilities()`:
  - `{ product_mode: "launchpad" | "lite" | "unknown", features: {...} }`
- `api.timetravel.listProviders(path)`:
  - authoritative provider list for a file in the current environment
- `api.exec.getApiVersion()`:
  - compatibility/version negotiation for script portability

CLI implication:

- `cocalc browser exec-api` should include:
  - API version
  - product-mode notes
  - capability discovery snippet

#### 11.1 Core domains and API shape

`api.session`

- `getInfo()` browser/session/workspace context metadata
- `listOpenWorkspaces()`
- `listOpenFiles({ workspaceId? })`
- `focusWorkspace(workspaceId)`
- `focusFile(workspaceId, path)`

`api.files`

- `list({ path, depth?, hidden? })`
- `readText(path, { start?, end? })`
- `writeText(path, content, { create?, overwrite? })`
- `patchText(path, edits)`
- `mkdir(path, { parents? })`
- `remove(path, { recursive?, trash? })`
- `move(src, dest, { overwrite? })`
- `copy(src, dest, { overwrite? })`

`api.fs` (node-compatible filesystem API + safe power tools)

- Expose the existing async node-style filesystem surface from [src/packages/conat/files/fs.ts](./src/packages/conat/files/fs.ts) as directly as possible.
- This gives agents a familiar API from training data, including binary-safe reads/writes.
- Key methods:
  - `readFile(path, encoding?)`
  - `writeFile(path, data)`
  - `readdir(path, opts?)`
  - `stat(path)`, `lstat(path)`, `exists(path)`
  - `mkdir`, `rm`, `rename`, `copyFile`, `cp`, `move`
  - `watch`, `find`, `fd`, `ripgrep`, `dust`
- Important behavior:
  - Works even when workspace runtime is not running (through file service backend).
  - Supports `Buffer` payloads for binary workflows.
  - Includes resource-limited, argument-whitelisted command wrappers for safety.
- Return normalization guidance:
  - Keep raw `stdout`/`stderr` buffers available.
  - Provide optional helper decoding for agent ergonomics (`utf8`, JSON lines parsing).

`api.editor`

- `open(paths, opts)`
- `close(paths)`
- `getSelection(path?)`
- `setSelection(path, range)`
- `reveal(path, { line, column })`
- `save(path?)`
- `saveAll()`

`api.notebook`

- `listCells(path)`
- `getCells(path, { ids?, includeOutputs? })`
- `setCells(path, updates)`
- `insertCells(path, inserts)`
- `deleteCells(path, ids)`
- `moveCells(path, moves)`
- `runCells(path, ids?)`
- `runAll(path)`
- `interruptKernel(path)`
- `restartKernel(path, { runAll? })`
- `getKernelStatus(path)`

`api.timetravel` (unified history API across providers)

- `listProviders(path)` -> `["patchflow", "snapshots", "backups", "git"]` subset per file
- `listVersions(path, opts)` where `opts` includes:
  - `provider?: "patchflow" | "snapshots" | "backups" | "git"`
  - `from_ms?`, `to_ms?`
  - `limit?`, `order?`
  - `query?` (provider-specific search text / metadata filter)
- `getVersion(path, { provider, version_id })`
- `getVersionText(path, { provider, version_id })`
- `diffVersions(path, { from, to, provider? })`
- `restoreVersion(path, { provider, version_id, dest_path?, mode? })`
- `search(path, opts)` unified search over one or more providers
- `summarize(path, opts)` compact activity summary over a time range

Provider helpers for agent ergonomics:

- `api.timetravel.patchflow.*`
- `api.timetravel.snapshots.*`
- `api.timetravel.backups.*`
- `api.timetravel.git.*`

Notes:

- Keep one top-level `api.timetravel` namespace for composability.
- Expose provider-specific helpers underneath it, rather than four disconnected top-level APIs.
- This matches how users think ("history of this file"), while still allowing explicit source control.

`api.bash` (workspace command execution with async/streaming control)

- Expose a focused bash execution API in browser exec for composability inside larger scripts.
- Back it directly by the existing execute-code contract in [src/packages/util/types/execute-code.ts](./src/packages/util/types/execute-code.ts).
- Core methods:
  - `run(opts)` blocking execution (returns stdout/stderr/exit_code)
  - `start(opts)` async execution (returns job metadata quickly)
  - `get(jobId, opts?)` poll job status/output
  - `await(jobId, opts?)` wait until completion
  - `kill(jobId)` terminate running job
  - `stream(jobId, onEvent)` optional realtime events (`stdout`, `stderr`, `stats`, `done`, `error`)
- Key options (aligned with existing execute-code options):
  - `command`, `args?`, `bash?`, `cwd?`, `path?`
  - `env?`, `timeout?`, `max_output?`
  - `err_on_exit?`, `ulimit_timeout?`, `filesystem?`
- Why this belongs in browser exec API:
  - agents can call bash in the middle of a larger browser-side workflow without extra RPC round trips
  - enables one-shot workflows like search -> transform -> open -> notify in a single script
  - leverages tooling agents are extremely strong at

`api.terminal` (high-value, carefully gated)

- `listSessions()`
- `openSession(opts)`
- `exec(command, opts)` non-interactive convenience
- `write(sessionId, input)`
- `read(sessionId, { maxBytes? })`
- `interrupt(sessionId)`
- `close(sessionId)`

`api.chatroom`

- `listThreads(path)`
- `createThread(path, opts)`
- `pinThread(path, threadId)`
- `listMessages(path, opts)`
- `postMessage(path, opts)`
- `deleteMessages(path, opts)` destructive + approval

`api.ui`

- `notify.show/info/success/warning/error(...)` (already started)
- `confirm(prompt, opts)` explicit user prompt/approval
- `modal(opts)` rich interaction surface
- `status(text)` transient progress indicator
- `copyToClipboard(text)`

`api.search`

- `rg(pattern, opts)` scoped ripgrep abstraction
- `findFiles(glob, opts)`
- `findSymbols(query, opts)` where available

`api.workspace`

- `start(workspaceId?)`
- `stop(workspaceId?)`
- `restart(workspaceId?)`
- `setTitle(workspaceId, title)`
- `openInNewTab(workspaceId, path?)`

#### 11.2 What users ask vs required primitives

"Summarize files I have open"

- Needs `api.session.listOpenFiles` + `api.files.readText`.

"Open notebooks mentioning elliptic curves, newest first"

- Needs `api.fs.ripgrep` + `api.fs.stat` + `api.editor.open`.

"Open matching notebooks and run all cells so they are ready"

- Needs `api.fs.ripgrep` + `api.editor.open` + `api.notebook.runAll`.

"Convert notebooks to .py and combine into a library"

- Needs `api.fs.find/fd` + notebook conversion helpers + `api.fs.writeFile`.

"Run workspace-level transformations in the middle of a browser script"

- Needs `api.bash.run/start/get/await` + `api.fs` + `api.editor`/`api.notebook`.

"Create a notebook to analyze X and run all cells"

- Needs `api.notebook.insert/set/runAll` + `api.ui.notify`.

"Close all markdown files"

- Needs `api.session.listOpenFiles` + `api.editor.close`.

"Fix this workspace and show me what changed"

- Needs `api.search`, `api.files`, `api.terminal.exec` (or backend tools), `api.ui.modal/notify`.

"Notify me when done"

- Needs `api.ui.notify` + long-running exec lifecycle.

"Restore the file a.tex from the last backup"

- Needs `api.timetravel.listVersions({ provider: "backups" })` + `api.timetravel.restoreVersion`.

"Search snapshots of a.ipynb for the last version that ran without errors and copy it to a-working.ipynb"

- Needs `api.timetravel.listVersions({ provider: "snapshots" })` + `api.timetravel.getVersion` + `api.notebook.listCells`/output checks + `api.timetravel.restoreVersion({ dest_path })`.

"Summarize activity on a.txt over the last two days"

- Needs `api.timetravel.search` + `api.timetravel.summarize`.

#### 11.3 Approval and safety model

Policy levels:

- `read`: metadata + text reads
- `write`: file/editor/notebook edits
- `exec`: terminal command execution
- `bash_exec`: workspace bash command execution
- `destructive`: deletes/resets/kernel restarts
- `ui_prompt`: user-facing modal/confirm interactions

Mutation safety policy (snapshot-first by default):

- Default in Launchpad: `snapshot_before_mutation` for any `write`, `bash_exec`, or `destructive` action.
- Optional stricter policy: `snapshot_before_turn` (one snapshot at turn start) plus per-mutation checkpoints for high-risk flows.
- Optional recovery policy: `snapshot_and_auto_rollback_on_failure` for scripted workflows.
- Opt-out policy for advanced users: `no_auto_snapshot` with explicit warning.
- For lite mode (no host snapshot provider), degrade gracefully:
  - `required` snapshot policy blocks mutation with a clear error.
  - `preferred` snapshot policy warns and continues.

Policy hooks:

- `api.safety.beginTurn({ snapshot: "if_available" | "required" | "none" })`
- `api.safety.beforeMutation({ reason, paths? })`
- `api.safety.endTurn({ summarize_changes?: boolean })`

Execution flow:

- Preflight permission plan from script (or dynamic prompts).
- Per-call approval where policy requires it.
- Every mutating call logged with timestamp, actor, workspace, args summary.
- Support dry-run for destructive families when feasible.

#### 11.4 Data contracts and ergonomics

- Paths are absolute everywhere.
- IDs are stable (`workspace_id`, `cell.id`, `thread.id`, etc.).
- Internal compatibility note: browser API can map `workspace_id` to backend `project_id` in adapters.
- Optional output simplification knobs:
  - notebook outputs: `raw|summary|text`
  - terminal output: bounded windows
- Return objects should include:
  - `ok`
  - `changed` counts
  - `warnings`
  - deterministic identifiers

#### 11.5 Operational model for agents

- Keep current async LRO-style exec (`start/get/wait/cancel`) as the primary control plane.
- Add optional event streaming later (`exec-stream`) for progress and approvals.
- Add script source options (inline/file/stdin) for robust agent invocation.
- Keep `exec-api` as canonical discoverability endpoint (TS declaration output).

#### 11.6 Phased implementation

Phase A (near-term)

- Make `cocalc browser ...` work in lite mode by wiring against [src/packages/lite/hub](./src/packages/lite/hub) (parallel lightweight API surface to server conat API), so browser automation can be used during ongoing development.
- Expand `api.session`, `api.files` (read/write text), `api.editor` save/focus.
- Expose `api.fs` node-compatible baseline (`readFile/writeFile/readdir/stat/rm/mkdir/rename`) plus safe `ripgrep/find/fd`.
- Harden `api.notebook` with insert/delete/move + kernel status.
- Add `api.ui.confirm` and richer notify variants.
- Add `api.timetravel` MVP (`listProviders`, `listVersions`, `getVersionText`, `restoreVersion`) with `patchflow` + `snapshots` first.

Phase B

- Add `api.chatroom` primitives.
- Add `api.search` primitives.
- Add better notebook output modes and size controls.
- Extend `api.timetravel` with `backups` + `git` providers and unified `search/summarize`.

Phase C

- Add `api.terminal` safe subset with approval gating.
- Add `api.bash` with async job lifecycle + optional stream events.
- Add event stream support for long interactive automations.

Phase D

- Advanced UI automation:
  - modal forms
  - guided workflows
  - richer progress/status surfaces.

#### 11.7 Concrete extension API spec (proposed)

Purpose:

- Let agents deliver repeatable, user-scoped frontend functionality by shipping extension bundles, not one-off ad hoc scripts.
- Reuse CoCalc's runtime editor registration model in a controlled, capability-gated way.

High-level model:

- Agent builds extension bundle (single JS file + manifest).
- Agent installs extension via browser API (`api.extensions.install`).
- Extension activates in current browser session and can register editors/panels/actions.
- User can open extension-backed files (e.g., `browser.gitview`) or panels.

TypeScript-style manifest:

```ts
export type ExtensionCapability =
  | "read_files"
  | "write_files"
  | "read_timetravel"
  | "restore_timetravel"
  | "read_git"
  | "exec_terminal"
  | "bash_exec"
  | "ui_notify"
  | "ui_modal"
  | "network_fetch";

export type ExtensionManifest = {
  id: string;                  // e.g. "com.cocalc.gitview"
  name: string;
  version: string;             // semver
  description?: string;
  entry: string;               // entry module symbol/path in bundle
  capabilities: ExtensionCapability[];
  compatibility?: {
    api_min?: string;
    api_max?: string;
    product_modes?: ("launchpad" | "lite")[];
  };
};
```

Browser API surface:

```ts
api.extensions = {
  list(): Promise<ExtensionSummary[]>;
  get(id: string): Promise<ExtensionDetails>;
  install(opts: {
    manifest: ExtensionManifest;
    bundle_js: string;
    replace?: boolean;
    scope?: "session" | "user" | "workspace";
  }): Promise<{ ok: true; id: string; version: string }>;
  enable(id: string): Promise<{ ok: true }>;
  disable(id: string): Promise<{ ok: true }>;
  uninstall(id: string): Promise<{ ok: true }>;
  invoke(id: string, command: string, args?: unknown): Promise<unknown>;
};
```

Extension runtime context:

```ts
export type ExtensionContext = {
  extension: { id: string; version: string };
  api: {
    session: ...;
    files: ...;
    notebook: ...;
    timetravel: ...;
    ui: ...;
  };
  registerEditor(spec: {
    id: string;
    name: string;
    file_extensions: string[];              // e.g. [".gitview"]
    can_open?: (path: string) => boolean;
    open: (path: string, opts?: unknown) => Promise<EditorHandle>;
  }): () => void;
  registerPanel(spec: {
    id: string;
    name: string;
    open: (opts?: unknown) => Promise<PanelHandle>;
  }): () => void;
  registerAction(spec: {
    id: string;
    label: string;
    run: (args?: unknown) => Promise<unknown>;
  }): () => void;
  onDispose(fn: () => void): void;
};

export async function activate(ctx: ExtensionContext): Promise<void>;
export async function deactivate?(): Promise<void>;
```

Editor registration behavior:

- Extension editors are user-scoped and hot-loadable.
- Registration is reversible (returns disposer).
- Opening a matching file extension dispatches to extension editor implementation.
- Extensions must render via approved UI host primitives (no unrestricted DOM ownership).

Capability + approval policy:

- Install requires explicit approval when capabilities include `write_files`, `exec_terminal`, `bash_exec`, `network_fetch`, or destructive history restore.
- Runtime calls are capability-checked per API method.
- All extension-originated mutating actions are audit logged with extension id + version.

Persistence and sharing:

- Scope options:
  - `session`: current browser session only
  - `user`: persists for user account
  - `workspace`: stored in workspace config (shareable with collaborators)
- Initial implementation can support `session` first, then `user`, then `workspace`.

Suggested CLI surface:

```bash
cocalc browser ext list
cocalc browser ext install --manifest ./ext.json --bundle ./ext.js [--scope session|user|workspace]
cocalc browser ext enable <id>
cocalc browser ext disable <id>
cocalc browser ext uninstall <id>
cocalc browser ext invoke <id> <command> [--arg-json ...]
```

Target example:

- `com.cocalc.gitview` extension registers `.gitview` editor.
- Opening `browser.gitview` shows recent commits/diffs for current repo.
- Agent iterates quickly by replacing bundle version via `install --replace`.

Mode compatibility guidance:

- Extensions should branch on `api.system.getCapabilities()` + `api.timetravel.listProviders(path)`.
- In lite mode, hide snapshot/backup UI paths automatically when those providers are unavailable.

Success metrics:

- Median user request can be resolved with <=2 browser exec calls.
- >90% of common notebook/file/chat tasks handled without bespoke backend changes.
- Low timeout/cancellation failure rates on async exec operations.

### 12) Notebook operations (future standalone commands)

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

### 13) Chatroom operations (future standalone commands)

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

### 14) Product launcher subcommands (future)

```bash
cocalc plus [args...]
cocalc launchpad [args...]
```

Behavior:

- If `cocalc-plus` / `cocalc-launchpad` is not installed, prompt and install it via the corresponding installer.
- Then forward all remaining arguments to the installed binary.
- Provide non-interactive flags for automation:
  - `--install-if-missing`
  - `--yes`
  - `--channel latest|stable|...`

Rationale:

- A user can install only `cocalc` first, discover additional products via `cocalc --help`, and immediately launch UI products with minimal friction.
- This improves first-run conversion from CLI users to Plus/Launchpad usage.

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
