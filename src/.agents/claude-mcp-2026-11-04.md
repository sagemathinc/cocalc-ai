# MCP servers for Claude agents (phase 1 design), 2026-11-04

William (Nov 3): "A big missing thing with claude agents in cocalc-ai right now is MCP client support ... with codex I can just install an mcp client via the cli and it works because ~/.codex is the same via the web UI and the cli. With claude I think that's not true." He asked for phase 1 on Nov 3 ("Yes, please do start on phase 1").

## Why it doesn't work today

- Codex runs inside the project, so `~/.codex/config.toml` (including `[mcp_servers]`) is the same for the CLI and the web UI.
- Claude subscription turns (pinned or Auto) run Claude Code in an isolated **controller** outside the project, so subscription credentials never reach project code (`sessionPolicy === "claude-subscription-controller"` in `ai/acp/harness-client.ts`).
  - The session sets `settingSources: []` and `mcpServers: {}`.
  - Its only MCP server is CoCalc's own bridge: `claude-project-mcp.cjs`, mounted at `/run/cocalc/agent-tools`. It sends one request per tool call, as a line with a token, over a Unix socket to the project host (`claude-project-tool-bridge.ts`). The host runs the work in the project through `sandboxExec`.
  - So `claude mcp add` in a project terminal writes `~/.claude.json`, which the controller never reads.
- MCP servers must not run in the controller. A stdio server is arbitrary code, and next to the credential it would defeat the isolation.

## Constraint found: no stdin into contained commands

Agent commands run through the contained path:

- `runContainedSandboxCommand` starts the root helper (`cocalc-runtime-storage supervise-project-job`).
- The helper starts `podman exec` with the in-project supervisor.
- The helper **consumes its own stdin as the lease**, and writes its own `.` heartbeats into the container.
- No host data reaches the command's stdin. A long-lived stdio MCP server can't be driven through this path without changing the root-owned bootstrap helper on every host. That is heavy and security-sensitive, so it's ruled out for phase 1.

## Design

### 1. Config: Claude Code's own files, read in the project

At session open, the host reads the following inside the project (`sandboxExec`, read-only, with a size bound):

- `~/.claude.json`:
  - top-level `mcpServers` (user scope, written by `claude mcp add --scope user`);
  - `projects[<cwd>].mcpServers` (local scope, the default of `claude mcp add`).
- `<cwd>/.mcp.json` `mcpServers` (project scope, as checked into a repo). See approval below.

Entries are parsed and validated:

- `name` must match `^[A-Za-z0-9_-]{1,64}$` and can't collide with the CoCalc tool server's name.
- stdio entries: `command`, `args`, `env`.
- http and sse entries: `url`, `headers`.
- Bounded counts and sizes. At most 16 servers.

So `claude mcp add ...` in a project terminal works as it does for Codex. There is no CoCalc config format to learn.

### 2. Servers run inside the project, behind a project conat socket service

The project daemon (`packages/project`) gets an **MCP service**: a conat socket server, as for terminals and Jupyter (`conat/socket`, cf. `conat/project/terminal`).

- On connect with `{server: name}`, it re-reads the config itself, never trusting a command from the caller. It spawns that stdio server as a normal project process (the project's user, environment and network) and relays newline-delimited JSON-RPC both ways.
- For an `http`/`sse` entry it connects from inside the project (phase 1b), so headers and tokens stay in the project.
- The process dies when the socket closes, or after an idle limit.

Trust: the same as any project process, such as a terminal. Its stderr goes to a bounded log the activity can show.

### 3. Controller side: one more bridge entry per server

The session's `mcpServers` gets, per configured server:

```js
{ name, command: "/opt/cocalc/bin/node", args: ["/run/cocalc/agent-tools/bridge.cjs", "--mcp", name] }
```

- In `--mcp` mode the existing bridge script is a pass-through. It opens one long-lived connection to the host socket, sends a first line `{token, mcp: name}`, then relays raw MCP lines between its stdio and the socket.
- The host bridge, on such a connection:
  - checks the token and authority, as for tools;
  - connects to the project's MCP service for `name` and pipes both ways;
  - applies bounded line sizes (1.2 MB, like the tool transport) and a per-session cap on open MCP connections;
  - closes everything on cancel, fence or close, like tool calls.
- Tools appear to Claude as `mcp__<name>__<tool>`.

### 4. Approval

- **User and local scope** (`~/.claude.json`): the user configured them, so their tools are pre-approved (`allowedTools: mcp__<name>`), as CoCalc's own tool server is.
- **Project scope** (`.mcp.json` in the working directory): a cloned repo can add one. Claude Code asks before first use. Phase 1 includes them only when `~/.claude.json` `projects[<cwd>].enabledMcpjsonServers` lists them (or `enableAllProjectMcpServers` is true). These are the same keys Claude Code writes when you approve in the CLI. Otherwise they are skipped and the activity says so. (Open question for William: just include them?)

### 5. Lifecycle and cost

- The config is read at session open. A change takes effect at the next session; it doesn't restart a running one. The new tool list costs one prompt-cache miss, then caching resumes.
- A server that fails to start or dies is reported in the turn's activity ("MCP server X: failed to start: ..."). The tool simply errors, and the turn never fails because of it.

## Design review (@lite1-review, Nov 4): resolutions

1. **Bind name, scope and config digest (approval and TOCTOU).**
   - At session open the host builds the server list. Each entry is `{name, scope, digest}`, where `digest` is the SHA-256 of the canonical entry: scope, command, args, env, url, headers.
   - The bridge `--mcp` entry carries only `name`. The host relay sends `{name, scope, digest}` to the project service.
   - The project service re-reads the config and spawns only if the same name and scope still hash to that digest. Otherwise the server is refused ("MCP server X changed since the session started").
   - So a config swapped between approval or session open and spawn never runs.
2. **Authority throughout long-lived relays.**
   - Each relay registers with the bridge's existing authority loop: a recheck every 30 s while any relay is open, plus a check at open.
   - A failed check, cancel, fence or close destroys every relay. That kills the project process (see 3).
   - Relays opened before a cancel are not resumed. Claude reconnects at the next session.
3. **Limits and cleanup.**
   - Per project: at most 8 running MCP server processes, enforced in the project service. Per session: at most 8 relays.
   - Lines at most 1.2 MB.
   - Queued bytes per direction at most 4 MB. Above that, the relay pauses the reading side (backpressure); if it is still over the limit after 30 s, it closes the relay.
   - The server is spawned detached in its own process group. On close the whole group gets SIGTERM, then SIGKILL after 5 s.
   - Idle timeout: 30 minutes without traffic closes the relay.
   - stderr is kept in a bounded ring (64 KB) for diagnostics.
4. **Server-initiated sampling and elicitation are refused.**
   - The relay inspects server→client JSON-RPC requests. It allows only `ping` and `roots/list`. It answers `sampling/createMessage`, `elicitation/create` and any other request with error -32601, without forwarding to Claude.
   - So a server can never spend the subscription or prompt the user.
   - Notifications and responses pass through.
5. **Who can reach the project service.** It is a conat service on the project's subject, so the project's collaborators can reach it too, like terminals. This is explicitly accepted: collaborators can already start any process in the project. Admission limits apply (3), and the service spawns only servers named in the project's own config, never a command from the caller.
6. **`.mcp.json` approval stays** (Claude Code's `enabledMcpjsonServers` / `enableAllProjectMcpServers` in `~/.claude.json`).
   - Documented: in CoCalc, `~/.claude.json` is **shared project-home state**. Every collaborator's Claude agents in that project use its MCP servers, and anyone who can edit project files can change it.
   - William (Nov 3) on approval: it "does seem reasonable to have an approval step".

## Implementation notes (1a)

- The bridge entry is a separate script, `relay.cjs`, rather than a mode of `bridge.cjs`. The CoCalc tool server's name is a hash of `bridge.cjs`, so changing that file would rename the server and cost every Claude agent one prompt-cache miss.
- The session's list comes from the project service itself, via `{list: true, cwd}`, so Claude's config is parsed in one place, inside the project.
- Relays belong to the session, not a turn:
  - A cancelled turn (`cancel()`) stops project jobs but leaves relays open. Claude Code would not reconnect a server it saw disconnect.
  - A failed authority check, a fence or `close()` ends them.
  - Relays are rechecked every 30 s with `authorize()` directly, paused or not, and checked when they open.
- Policy (refusing sampling and elicitation) is applied on the host, not in the project service: that runs as the same user as the server.

## Phases

- **1a (this PR):** stdio servers from user and local scope, plus approved project scope. Project MCP socket service, bridge `--mcp` pass-through, host relay, config reader, activity notes. Tests: config parsing; relay framing and limits; an end-to-end test with a tiny echo MCP server through the host relay and a fake project service; authority close and cancel.
- **1b:** http/sse servers with static headers, connected from inside the project.
- **2:** OAuth remote servers (token store and a login flow); an "MCP servers" list in the Claude settings dialog; per-server enable and disable.

## Not changed

- The API-key and project-secret modes already run Claude Code in the project with default settings. To verify in 1a: whether they already read `~/.claude.json`.
- Codex: unchanged.
