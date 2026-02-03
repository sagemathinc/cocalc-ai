# CoCalc Plus SSH Remote Mode (Draft Strategy)

## Todo

- [ ] Robust cleanup: detect dead tunnels/servers and prune stale entries; optional --keep or --ttl.
  - even if dead, the user may want to start them again later when the target is available; user should be able to explicitly kill and remove any server though.

- [ ] login shell config -- make sure that the PATH etc is what user would get when using a login shell. E.g., I  don't have /usr/local/bin/ in the path, which is weird when using cocalc-plus itself.

- [ ] delete old versions from `~/.cache/cocalc/cocalc-plus/` on upgrade, since it is just a cache and they waste space

- [ ] add version check to startup
  - use this to print warning if remote server is not up to date, with instructions about how to upgrade
  - surface version mismatch in the UI

- [ ] Port + token UX: stable local port is done; add “reconnect” command that reuses saved port/token if still live.

- [ ] Remote daemon lifecycle: graceful shutdown (SIGTERM + wait), and status from pidfile + HTTP health.

- [ ] Config sync (settings, preferences): export local settings to a bundle, push over SSH, and import on remote startup.

- [ ] Secrets sync (opt‑in): separate encrypted store or per‑target prompt; clear UX and clear “do not sync” default.

- [ ] SSH hardening: explicit --no-install, --forward-only, better errors when ssh fails.

- [ ] Diagnostics: --log-level debug already exists; add --verbose-ssh to show exact commands.

- [ ] enable proxying of remote apps (e.g., jupyterlab) and make sure it works
  - this is probably just enabling a button in the frontend when lite mode is true, instead of explicitly disabling it; there might not be anything else to do.

- [ ] reflect-sync integration issues:
  - [ ] make it so configuration of sync is focused around "Remote SSH Sessions" targets, e.g., maybe use an antd expand button to configure sync.  The configuration would be:
    - path, ignores presets
    - primary key is just a local path; don't allow a path that is contained in another path
    - make the remote path equal local path for simplicity, relative to HOME directory
    - advanced mode:
      - different remote path, not relative to home directory, conflict modes
  - [ ] also make port forwards be part of the remote ssy target:
    - local port, remote port (defaults to local port), direction (defaults to remote --&gt; local)

- [ ] document how this works and that remote sessions are persistent (e.g., terminals, jupyter kernels, etc. do not stop). 

- [ ] improve the website

- [ ] implement `cocalc-plus uninstall` and recommend that.  
  - mention on https://software.cocalc.ai/software/cocalc-plus/index.html 
  - it should delete the extracted files from bundle in ~/.cache (or wherever)
  - undo changes to PATH (?).
  - do NOT delete config/state info (the sqlite database) unless use `cocalc-plus uninstall --purge` 

- [x] Remote session management: 
  - [x] cocalc-plus ssh list (local registry of targets + last port + status), 
  - [x] cocalc-plus ssh stop  (uses saved pidfile)
  - [x] cocalc-plus ssh status  (ping)
  - [x] make table look nice using ascii-table3 with same style as used in `packages/conat/sync/inventory.ts` 

### Reflect Sync -- background

Reflect-sync is a powerful open source program I wrote with codex over 2 months, but haven't used yet.  It's an extremely efficient rsync + sqlite program for bidirectional file sync over ssh, and also supports configuring arbitrary maintained port forwards.   It would fit naturally into this "Remote SSH Sessions" page, where one could easily configure and see the status of the following:

- a list of directories to bidirectionally sync to the remote ssh target that you'll run cocalc-plus on
- ports to forward and their direction

Reflect sync is mainly a cli program, but I think it could easily be a library we just include in our bundle. It has no binary package dependencies (it uses node:sqlite), and just relies on rsync being installed -- we could make that one of the tools (similar to rg) so it just works in case rsync isn't installed (see `/home/wstein/upstream/rsync/rsync-static` )... or just show an error in this case.

The value add is that reflect-sync is very efficient and direct, open source, and doesn't involve any user data going to dropbox/google drive/etc. 

## Goal

Deliver a one-command "CoCalc Plus Remote" experience:

```
cocalc-plus ssh user@host[:port]
```

The local binary acts as a thin CLI that:

- connects over SSH
- ensures cocalc-plus is installed remotely
- starts a remote server bound to localhost only
- forwards a local port to the remote port
- prints (and optionally opens) a local URL with auth token

This mirrors "VS Code Remote SSH", but provides the CoCalc UX with persistent terminals, Jupyter, file browsing, and optional app proxies.

## Core UX

### Happy path

1) User runs:
   `cocalc-plus ssh user@host`.
2) CLI verifies SSH connection and target OS/arch.
3) Remote installation (if missing) from software.cocalc.ai.
4) Remote daemon starts on 127.0.0.1:<remotePort>.
5) Local port forward is established: localhost:<localPort> -> remote:localhost:<remotePort>.
6) Local URL printed:
   `http://localhost:<localPort>?auth_token=...`
7) Browser auto-opens unless `--no-open`.

### Immediate value

- Zero manual SSH forwarding
- Persistent sessions on remote
- Works for Jupyter + terminals + file editing
- Trivially supports "proxy apps" (JupyterLab, code-server, etc.)

## Command surface

### Proposed CLI

```
cocalc-plus ssh <target> [options]

<target>:
  user@host[:port]

Options:
  --local-port <n|auto>      default: auto
  --remote-port <n|auto>     default: auto
  --install / --no-install   default: install
  --upgrade                  force upgrade remote
  --daemon / --no-daemon     default: daemon
  --open / --no-open         default: open
  --forward-only             skip install/start; only forward
  --ssh-arg <arg>            repeatable
  --identity <file>          identity key
  --proxy-jump <host>        ProxyJump
  --log-level <info|debug>
```

### Exit/cleanup

- `cocalc-plus ssh --stop user@host` to stop daemon.
- `cocalc-plus ssh --status user@host` for status.

## High-Level Flow

### Local steps

1) Parse SSH target.
2) Establish SSH control socket for reuse:
   `ssh -MNf -o ControlMaster=auto -o ControlPath=...`.
3) Check remote arch/OS:
   `uname -s`, `uname -m`.
4) Check remote cocalc-plus availability:
   `command -v cocalc-plus`.
5) Install or upgrade if needed:
   `curl -fsSL https://software.cocalc.ai/software/cocalc-plus/install.sh | bash`.
6) Determine remote port:
   - If user specifies, use it.
   - Else choose free port on remote (see below).
7) Start remote daemon (see below).
8) Determine local port:
   - If user specifies, use it.
   - Else choose free port on local.
9) Establish tunnel:
   `ssh -L <localPort>:127.0.0.1:<remotePort> ...`.
10) Print + open URL with token.

### Remote daemon command (example)

```
COCALC_AUTH_TOKEN=<token> \
COCALC_BIND=127.0.0.1 \
COCALC_PORT=<remotePort> \
cocalc-plus --daemon
```

## Port Selection

### Remote port selection

Strategy:

- Preferred: let **cocalc-plus** itself allocate a free port and write
  connection info to a file. This avoids any dependency on remote Python/Node.
  Example flag (to implement):

```
cocalc-plus --daemon --write-connection-info /tmp/cocalc-plus.json
```

Where the JSON includes `{ port, token }`. The SSH launcher reads the file
back and forwards to that port.

- Fallback: run a small remote script to allocate a free port:

```
python3 - <<'PY'
import socket
s=socket.socket()
s.bind(('127.0.0.1',0))
print(s.getsockname()[1])
s.close()
PY
```

If Python unavailable, fallback to Node:

```
node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();})"
```

### Local port selection

Same approach locally.

## Daemonization

### Preferred: internal Node daemonization

Add lightweight daemonization in the cocalc-plus Node runtime itself (likely
already present in CoCalc code). This avoids platform-specific service managers
and keeps behavior consistent across Linux/macOS. It can write a pidfile and a
connection-info file in one place.

### Optional: systemd user service (Linux only)

- If `systemctl --user` available and working:
  - `systemd-run --user --unit cocalc-plus-ssh-<hash> ...`
  - Benefits: restart, logs, easy stop.

### Fallback: nohup + pidfile

- Write pidfile in `~/.local/share/cocalc-plus/ssh/<hash>/pid`.
- `nohup cocalc-plus ... > log 2>&1 &`.

## Security Considerations

- **Bind only to 127.0.0.1 on remote**.
- **Require auth token** for all connections.
- **Token transmitted only over SSH** and printed to local terminal.
- **No remote 0.0.0.0 bind** unless explicitly requested.
- Avoid writing token to world-readable files.

Note: OpenSSH supports **streamlocal** forwarding (`-L /local.sock:/remote.sock`).
If we ever want to bind the remote server to a UNIX socket instead of TCP, we
can do that and forward the socket (Linux/macOS only). TCP on 127.0.0.1 is still
the simplest cross-platform path.

Optional:

- Store token in a temp file with 0600 perms for reconnects.
- Allow `--token` to reuse an existing server.

## Reconnect UX

If daemon already running:

- Query status file or attempt GET to `http://127.0.0.1:<remotePort>` remotely.
- Reuse token and port.
- Only re-create the local tunnel.

## Install/Upgrade Rules

- Install if missing.
- Upgrade if `--upgrade` or remote version != local expected.
- Version compare should be tolerant (semver).

## Compatibility Matrix

Remote supported targets:

- linux/amd64
- linux/arm64
- darwin/arm64

Local supported:

- same set

## Logging & Diagnostics

- `--log-level debug` prints SSH commands + remote outputs.
- `--trace` prints remote install script output.
- `--dry-run` prints planned actions.

## Implementation Sketch

- Add a new CLI entrypoint: `cocalc-plus ssh`.
- Implement in `src/packages/plus` (node CLI).
- Use `child_process.spawn` to drive ssh.
- Cache per-host state under:
  `~/.local/share/cocalc-plus/ssh/<hash>/`.

## Implementation Plan (Phased)

### Phase 0 — Plumbing & CLI skeleton

- Add `cocalc-plus ssh` subcommand with argument parsing.
- Add `--ssh-arg`, `--identity`, `--proxy-jump` passthrough support.
- Implement local port selection helper (node-based).

### Phase 1 — Remote install & daemon

- SSH to target and detect OS/arch.
- Install `cocalc-plus` on remote (install.sh) if missing.
- Add `--write-connection-info` flag on server startup:
  - write JSON `{ port, token, pid, startedAt }` to a known path.
- Implement internal daemonization (pidfile + log).

### Phase 2 — Tunneling + UX

- Create SSH control socket for reuse.
- Forward local → remote with the selected ports.
- Print URL + token.
- `--open` support to launch browser.

### Phase 3 — Reconnect & lifecycle

- If remote daemon already running, reuse its connection info.
- `ssh --status`, `ssh --stop` commands.
- Add local “session list” (read cached connection info).

### Phase 4 — Hardening

- Add timeouts + retries.
- Robust cleanup for temp files.
- Better error messages for common SSH failures.

## Open Questions

- Do we want a local "session list" UI? YES, definitely. 
- Should remote daemon auto-stop when tunnel closes? NO, definitely not.  Let's be like tmux.
- Do we allow multiple simultaneous tunnels to same remote?  Maybe.   Probably.  This would be similar to how in vscode different projects (git repos) correspond to different windows.     On the other hand, it feels like it could complicate things a lot.  I'm unsure. 