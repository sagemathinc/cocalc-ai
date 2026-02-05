# CoCalc Plus SSH Remote Mode (Draft Strategy)

## Updated finish plan (2026-02-05)

### Phase 1: UX correctness and visibility (low risk, immediate user value)

- [ ] auto-start sync scheduler when creating a new remote session (optional default + toggle)
- [ ] sync confidence/status surface: "all files synced" + on-demand deep check/progress
- [ ] window title in lite remote mode should include target
- [ ] fix opening `files/some/path` on remote
- [ ] support opening paths outside HOME (`files/.root/...`) in a stable way
- [ ] verify remove-session fully terminates related forwards/processes (the lingering `ps` case)

### Phase 2: runtime robustness and operability (medium risk)

- [ ] robust cleanup policy for stale sessions/tunnels (explicit remove remains authoritative)
- [ ] login-shell/PATH behavior parity
- [ ] cache cleanup of old extracted versions under `~/.cache/cocalc/cocalc-plus/`
- [ ] startup version checks + mismatch warning path in CLI/UI
- [ ] remote daemon lifecycle hardening (graceful stop + reliable health/status)
- [ ] diagnostics expansion (`--verbose-ssh`)
- [ ] SSH hardening UX (`--no-install`, `--forward-only`, clearer failures)

### Phase 3: platform/product expansion (higher scope)

- [ ] config sync bundle (opt-in)
- [ ] secrets sync model (opt-in, secure-by-default)
- [ ] uninstall workflow (`cocalc-plus uninstall` + `--purge`)
- [ ] Electron app
- [ ] docs/site quality pass

## Reflect Sync UI todo

- [x] automatically start on create of new remote session

- [ ] connecting via ssh doesn't work on macos 

- [ ] more status of sync: are all files sync'd or are some not sync'd?  Checkbox if they are all sync'd.  This is possibly expensive so click to update (?).  If sync'ing a lot of data, this could provide a "percent done" sort of thing. 

- [x] remote server upgrade -- make it one click to upgrade a remote server to the latest available version; we need to determine somehow if there even is a newer version, etc. (since latest version may vary depending on architecture).  Also this needs a warning because any running notebooks and terminals are reset on upgrade.

- [x] local server upgrade: if the local server is out of date, it would be very good to also have a way to click a button and upgrade it...

- [x] projects already have a color that can be set in project settings.  it does NOTHING in lite mode, since normally it only impacts the project tab, which isn't displayed in lite mode. Let's make it so the color of the project is shows as a 3px solid border on the left of the screen, i.e., add a `border-left` style to the component with class cocalc-webapp-container.

- [x] filter -- a box where you can type and only the remote sessions whose target match are shown

- [x] add a little "copy" icon next to the target name/url, so it's easy to copy (right now it's impossible).

- [x] starring -- i.e., a column where you can start certain sessions

- [x] sorting -- sort by some columns; antd makes this easy - target, starred, status, last used

- [ ] window title: in lite mode when whatever is set to make that "Remote: " button appear in the upper right, it would be good to short circuit whatever displays the window title and instead have the SSH target as the title, since otherwise it is very hard to distinguish these sessions.

- [ ] fix bug that opening cocalc-plus at files/some/path does not work. 

- [ ] provide a way that works to open cocalc-plus files not in HOME, e.g., files/.root/some/path

- [x] #wontfix (bad idea?) Make the same "SSH sessions" react component also be visible in settings in a new page called "Remote Sessions".   This would be next to the pages for "Settings"/"Profile"/"Preferences"/"Admin". Also, is there a better name for this. In VS Code it is called "VS Code Remote Development". We could call it "Remote Sessions" and not emphasize ssh so much, since ssh suggests "something in a terminal"; it just happens to be how it works.   Also for the button in the upper right it would be nice to add a label "Local" to it, to emphasize it isn't remote.  For the remote session the modal "Remote SSH Session" could just have the heading "Remote Session".

- [x] missing root when syncing.  It is very easy to hit this when using cocalc this way:
  - create a new sync directory, e.g. my-project

  - of course the remote server doesn't have my-project yet

  - just get an error in the target since: "
    ```
    2/4/2026, 1:41:55 PM [warn] (cocalc-plus) scheduler exited {"code":1,"signal":null}
    2/4/2026, 1:41:55 PM [error] (cocalc-plus) MissingRootError: sync root missing: beta root 'ctl:/home/cocalc/x' does not exist
        at failMissingRoot (file:///home/wstein/build/cocalc-lite2/src/packages/node_modules/.pnpm/reflect-sync@0.15.1/node_modules/reflect-sync/dist/scheduler.js:509:28)
        at ensureRootsExist (file:///home/wstein/build/cocalc-lite2/src/packages/node_modules/.pnpm/reflect-sync@0.15.1/node_modules/reflect-sync/dist/scheduler.js:584:13)
        at process.processTicksAndRejections (node:internal/process/task_queues:103:5)
        at async runScheduler0 (file:///home/wstein/build/cocalc-lite2/src/packages/node_modules/.pnpm/reflect-sync@0.15.1/node_modules/reflect-sync/dist/scheduler.js:655:5)
        at async Module.runScheduler (file:///home/wstein/build/cocalc-lite2/src/packages/node_modules/.pnpm/reflect-sync@0.15.1/node_modules/reflect-sync/dist/scheduler.js:167:9) {
      side: 'beta'
    }
    2/4/2026, 1:41:55 PM [error] (cocalc-plus) Failed to start scheduler: MissingRootError: sync root missing: beta root 'ctl:/home/cocalc/x' does not exist undefined
    ```

    "

  - instead we really need to just create the missing root (on either side) on startup.  This could be an options to reflect-sync that we set or we try to run mkdir over ssh.

  - all that said, at any point just doing "mkdir" fixes the problem -- reflect sync starts working and syncing as soon as the missing directory is created.

- [x] what happens if a port forward gets killed for some reason?  what I want: it gets restarted automatically

- [x] speed up getting session status -- loading the ssh page feels really slow.   There's also a lot of actions, e.g., clicking on a session to open it, that locks the entire page with a spinner... why?  It just feels slow.

- [x] The "Reflect Daemon Logs" are always empty.  Seems suspicious.

- [x] the expand UI is still too overwhelming and cluttered:  add more margin; it's just very hard to see where the expanded row stops and the next row starts.

- [x] in sync, make remote path clickable, with clicking it open the REMOTE server at that path in the file explorer. This opens a new browser tab (or reuses the browser tab for a remote ssh session, if we already opeend one?). 

- [x] in sync, make local path clickable, with clicking it open that path in the file explorer in cocalc (so it just changes the page in the current browser tab).

- [x] removing an ssh session should also remove all the corresponding sync and port forward sessions.  Does it?  if not, implement it.  Also, the remove dialog should clearly explain what remove does, including disabling sync and port forwards, but not deleting any user files. 
  - [ ] ALSO, I created an ssh remote session, then removed it, and checked with "ps" and saw that the port forward was still running.

- [x] Showing "running" twice under sync state looks weird. If the current and desired states are the same, just show current; if not, show both with an arrow from one to the other or a spinner or something?

- [x] make the session target in the list of ssh sessions be clickable; clicking on it should be identical clicking the "open" button.

- [x] move "[user@]hostname[:port] (port is optional)" down a bit -- it's too close to the input box.  It would also be nice to have info popup that explains what will happen.

- [x] for the ssh target, can we support [user@]hostname[:port] and document that we support that in the dialog to make a new ssh target.  Note that the [:port] part of course requires special handling and introduces some incompat with ip6, but that's ok with me.  Maybe we already support this, so we just need to document it.

- [x] in port foward, make the local address "localhost:8080" clickable; click does same thing as "open" button.

- [x] the first time opening any remote server, it always says the site isn't available (so I see an error), then a  few seconds later it works (with no manual refresh required).  It would be much better to probe and be sure the remote server is running before creating the new tab.

- [x] delete ssh server session

- [x] do not show "stop" button if the ssh session is already stopped

- [x] delete an existing sync

- [x] pause an existing sync

- [x] "Additional ignore patterns":
  - explain the format and note that I think reflect-sync doesn't fully implement the git ignore syntax -- please check the reflect-sync source code, but I think there are some limitations to keep things really fast.    It would be really nice though to just summarize a few key rules, since even the official git page is overwhelming. 
  - AI: could describe what you want to ignore and it would fill in a guess?  I wonder if there's a way to do AI integrations for everything generically this way....?  We need a generic AI assistant react component don't we, which is as popular as popovers and tooltips.

- [x] edit an existing sync: many things can edited and some are useful (unclear what to do here; at least edit the ignores, maybe the preference side)

- [x] create new remote server -- just enter [user@]hostname[:port], get new row

- [x] localhost:port1 and localhost:port2 are using the same token... which is VERY confusing to the browser.

- [x] port forward is backwards

- [x] click on the "Remote: ...." button should provide a link to the local server in the modal (with token?)

- [x] paths for sync should be relative to HOME by default; also HOME on remote machine is usually totally different than local machine.  Use `~/` not hardcoded full path.

- [x] port forward (remote --&gt; local): add button to open port via http in another browser tab (since usually to a server)

## Other Todo

- [ ] Robust cleanup: detect dead tunnels/servers and prune stale entries; optional --keep or --ttl.
  - even if dead, the user may want to start them again later when the target is available; user should be able to explicitly kill and remove any server though.

- [ ] login shell config: make sure that the PATH etc is what user would get when using a login shell. E.g., I  don't have /usr/local/bin/ in the path, which is weird when using cocalc-plus itself.

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

- [x] enable proxying of remote apps (e.g., jupyterlab) and make sure it works
  - this is probably just enabling a button in the frontend when lite mode is true, instead of explicitly disabling it; there might not be anything else to do.

- [ ] Create an Electron App.

- [x] reflect-sync integration improvements:
  - [x] make it so configuration of sync is focused around "Remote SSH Sessions" targets, e.g., maybe use an antd expand button to configure sync.  The configuration would be:
    - path
      - advanced: remote path (defaults to local path)
      - ignore configuration (default to parsing .gitignore if present?)
      - local path not relative to home directory, conflict model
    - primary key is just the local path; don't use the reflect sync "name" at all
    - don't allow a local path that is contained in another path or contains another path (for simplicity and to avoid confusion
  - [x] also make port forwards be part of the remote ssh target:
    - local port, remote port (defaults to remote=local port), optional direction (defaults to remote --&gt; local)
  - [x] improve logs to be less confusing

- [ ] document how this works and that remote sessions are persistent (e.g., terminals, jupyter kernels, etc. do not stop). 

- [ ] improve the website

- [ ] implement `cocalc-plus uninstall` and recommend that.
  - mention on https://software.cocalc.ai/software/cocalc-plus/index.html 
  - it should delete the extracted files from bundle in ~/.cache (or wherever)
  - undo changes to PATH (?).
  - do NOT delete config/state info (the sqlite database) unless use `cocalc-plus uninstall --purge` 

- rsync static binary
  ```
  wstein@lite:~/upstream/rsync/rsync-3.4.1$ ls -lht rsync-static 
  -rwxrwxr-x 1 wstein wstein 2.8M Oct 13 23:55 rsync-static
  ```

- [x] Remote session management: 
  - [x] cocalc-plus ssh list (local registry of targets + last port + status), 
  - [x] cocalc-plus ssh stop  (uses saved pidfile)
  - [x] cocalc-plus ssh status  (ping)
  - [x] make table look nice using ascii-table3 with same style as used in `packages/conat/sync/inventory.ts` 

## Reflect Sync -- background

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
