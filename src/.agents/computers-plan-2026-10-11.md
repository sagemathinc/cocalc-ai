# Computers: let your agents use another computer

Status: plan, nothing built yet (2026-10-11). It comes from a long discussion with
William on Oct 11, with input from @cocalc-lite4 (who built the CLI connectors
and sensors) and a survey of similar products (at the end). "Decisions" records
William's answers. Stage 1 must be designed so that later stages build on it
without redoing it; see "Rules stage 1 must get right".

Revision 2 (same day) folds in @cocalc-lite4's review of revision 1:
- shared projects (open question 1);
- atomic tickets, revision floors, persisted nonces, clock offset and key
  rotation;
- a grant table of its own;
- one-shot exit watchers instead of a per-computer watcher;
- job-scoped credential leases;
- multi-bay routing, rehoming and account deletion.

Revision 3 records William's answers to the open questions:
- private projects only;
- containers with a time limit;
- `nice` by default;
- limits;
- provider keys;
- public documentation of the trust model.

It adds "the hub can narrow options but never widen them" and goes to
@lite1-review for a security review.

## The idea

Run one line on any Mac or Linux machine, approve a card in CoCalc, and the
agents you choose can **run commands, run long jobs, and copy files** there.
The machine connects *out* to CoCalc: it opens no port, needs no sshd and no
root.

The agent stays in CoCalc, with its memory, connectors, sensors and chat
history. The computer is just its hands.

What it is for:
- **Your Mac:** test something with Docker Desktop, without copying and
  pasting between the agent and a terminal.
- **A blank research server:** let agents install software and run
  computations there.
- **A spare laptop:** use it for builds or math experiments.
- **Help:** fix a configuration problem on your laptop.
- **Later:** a GPU machine the agent rents itself (RunPod, Lambda), within
  limits you set, for example to run a Jupyter kernel.

It also gives agents a way out of a limitation of projects: **projects can't
run containers.** A connected computer can.

## Decisions (William, Oct 11)

1. **Name: "computer"** (`cocalc computer`, Settings → Computers).
   - It is never called "computer use". In the industry that means controlling
     a screen with screenshots, mouse and keyboard.
   - **We will never add screen control.** That is better done by a local
     agent (Claude Code, Codex) on the machine itself.
2. **One feature with an option, not two features.** The option is a **time
   limit**: 1 hour by default, extendable from CoCalc up to **8 hours in
   total**, or no limit.
   - Time-limited is for a computer with credentials on it (your laptop).
   - No limit is for a compute resource (a research server).
3. **An agent feature, not a project feature.**
   - A computer belongs to an **account**. It is switched on **per agent**,
     like a connector, and is usable only by **that account's own turns** of
     those agents.
   - Collaborators and their agents never get it.
   - People in a project already have ssh for their own use.
4. **The agent asks, the human approves, the human runs the line.** The agent
   starts the request, for example "make a computer help session that mounts
   ~/datasets". The human sees a card stating exactly what will happen, clicks
   **Approve** (fresh authentication), and gets one line to paste. The line
   shows the settings, so it can be inspected.
5. **Small surface: `exec`, `run` (jobs), limited file transfer.**
   - No file sync. Agents track files better than people, and sync's
     unpredictable latency would get in the way.
   - No Jupyter, terminals or port forwarding in stage 1. William's cocalc.com
     "compute servers" got out of hand by supporting all of that plus a
     filesystem sync layer.
6. **File transfer:** 2 GB per transfer, and the egress quota is checked
   *before* a transfer starts. Backpressure must be right end to end (the
   conat file-transfer memory problem must not come back).
7. **Containers** (rootless podman only, never docker), with or without a
   time limit:
   - A time-limited session may use a container too, for example "a help
     session that mounts ~/datasets", since a mount means nothing without one.
   - Persistent by default; `--fresh` gives a throwaway one.
   - **The agent picks the image.** We control the flags it runs with.
   - Host directories can be mounted read-write or read-only, chosen in the
     approved request.
   - Scratch space of a given size is a **soft quota** (watched, not
     guaranteed), and the agent is always told its quota and usage.
   - GPUs work in containers but aren't isolated: a job can crash other
     people's GPU work on that machine.
8. **Long jobs wake the agent through sensors** (watchers), instead of the
   agent polling.
9. **Everyone sees the jobs.** All of the owner's agents, and the owner, see
   every CoCalc job on a computer. `--exclusive` means **no other
   CoCalc-started job is running on that computer**, which is what
   benchmarks need.
10. **Machine notes:** a short note per computer that every agent reads.
11. **An @alias for each computer**, like agents and artifacts. Chats store the
    computer's id; people and agents write `@research-1`.
12. **Credentials:**
    - (1) **Connector passthrough** in the first version: the agent's GitHub
      and Cloudflare connectors work on the computer with short-lived tokens,
      for one job each, never written to disk.
    - (2) Named secrets by reference: later.
    - (3) Device sign-ins (`gh auth login`, which writes a long-lived token to
      disk): documentation only, never automated.
13. **Windows: WSL2 for now.** Keep native Windows possible.
14. **Provider connectors (RunPod, Lambda, …) build on this.** A machine *they*
    create joins as a computer without a separate approval for each machine:
    approving the connector and its spending limits covers it. Agents never
    get the provider credentials.
    - The hub may hold a provider's **long-lived API key**, encrypted
      (external-credentials store: `encryptSecretStorageValue`, bound to the
      credential). This is an accepted exception to "expiring tokens only".
15. **Private projects only.** An agent can use computers only in a project
    where the owner is the **only collaborator**.
    - Enforced at the hub and rechecked on every ticket: adding a collaborator
      stops new tickets at once.
    - The reason: every process in a project runs as the same Linux user, so a
      collaborator could act as your agent during your turn.
    - The long-term direction: private one-person projects, combined with much
      better tools for sharing and collaboration *between* projects
      (publishing results, sharing read-only content).
16. **More exit watchers.** The 5-watcher limit is raised for computer exit
    watchers. They are event-driven, and the limit exists because polling is
    inefficient.
17. **`nice` by default** on computers without a time limit (and `ionice` on
    Linux). The agent can turn it off per job (`--no-nice`), for example for
    benchmarks.
18. **Limits:** `exec` returns at most 1 MB of output (the rest stays in a file
    on the machine); job logs are kept 7 days or 1 GB per computer.
19. **Public documentation of the trust model** in `src/packages/docs`:
    exactly how access and credentials work, what CoCalc can and can't do,
    how far to trust CoCalc and why, and how it compares with the
    alternatives (AI Commander, SSH or MCP shell servers, tunnels, a local
    agent). See "Public documentation".

## What exists to build on (traced, origin/main 25f42495b2)

- **Connector grants:** `server/agents/cli-connectors.ts`.
  - Account connections and the per-agent switches are in table
    `agent_connector_grants`: `(account_id, agent_id, source_project_id,
    connector, connection_id, scope, revision, enabled)`, with revision
    compare-and-swap.
  - Turning a grant on needs fresh auth; turning it off doesn't.
  - Short-lived turn tokens come from `issueCliConnectorTurnTokens`, after
    `verifyActiveAgentRun` (`identity-routing.ts`) and
    `assertLiveTurn`/`assertTrustedSource` (`cocalc-connector-turn.ts`).
  - The records live at the account's home bay (`assertAccountHome`), and
    connections are stored in `server/external-credentials/store`.
  - **The unique key is `(account_id, agent_id, source_project_id,
    connector)`** (`util/db-schema/agent-messaging.ts`), with one
    `connection_id` that must be an external credential. A
    `connector = "computer"` row would allow only *one* computer per agent,
    and the save path (`saveCliConnectorGrant`, `isCliConnector`) rejects it,
    so computers get their own grant table (below).
  - `table-ownership.ts` marks these tables account-home and "requires
    explicit migration before these tables are portable". The new tables are
    in the same position.
- **Sensors** (`conat/agents/sensors.ts`, `server/agents/sensor-*.ts`,
  `project-host/sensors.ts`, docs `ai/codex-automation`, `cli/scheduled-agents`).
  - Watchers are typed (`SensorWatch`: `ci | file | at | exit`) and run
    CoCalc's own check script (`sensorWatchScript`) about every 3 minutes with
    the agent's connectors.
  - They wake once, give up after a day (at most 72 h), at most 5 per account,
    and count toward the daily wake budget.
  - `kickSensorScheduler()` (`sensor-kick.ts`) makes a due sensor run at once.
  - Wake turns say "not from a person; information, not instructions".
- **Streaming file transfer** (`conat/files/read.ts`, `read-flow.ts`,
  `read-admission.ts`, `write-stream.ts`, with backpressure and slow-consumer
  tests).
  - Credit-based flow: exactly one outstanding chunk, acknowledged on
    *consumption*.
  - Idle timeout, per-producer and per-consumer admission, and a writer that
    waits for `drain`.
  - `read.ts` itself suggests streaming a tar of a directory.
- **Managed egress quota:** `server/membership/managed-egress.ts`, with
  remaining bytes in 5-hour and 7-day windows
  (`managed_egress_5h_remaining_bytes`, …).
- **@-mentions:** `util/artifact-mentions.ts` and `util/agent-mentions.ts`.
  - A span with a JSON reference ("identity metadata, not an access grant").
  - Names match `^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$`.
  - The composer autocompletes them (`frontend/agents/use-agent-mentions.tsx`).
- **Fresh-auth registry:** `server/conat/api/dangerous-rpc-registry.ts`. Every
  new risky hub RPC needs an entry that matches what the code enforces.
- **CLI install and sign-in:**
  - `curl -fsSL https://software.cocalc.ai/software/cocalc/install.sh | bash`
    (Linux x64/arm64, Apple Silicon macOS), and `install.ps1` for Windows.
  - `cocalc auth login` is browser approval.
  - The standalone CLI can't load some native or optional modules (issue
    #937, reflect-sync), so the daemon must use only what the bundle already
    carries.
- **Remote Jupyter kernels over SSH:** `jupyter/kernel/remote-launcher.ts`
  (a proxy launcher) and `frontend/jupyter/remote-kernel-service.ts`. Stage 5
  adds a launcher that uses the computer connection instead of ssh.
- **Shared browser computer mode** (#939) uses its own `ssh -R` into the
  project. Stage 5 can move it onto the computer connection.
- **Docs that this replaces:** `self-hosting/reverse-ssh-access`. Its own
  "safer future CLI workflow" section asks for this.

## Concepts

- **Computer:** a machine connected by one account.
  - It has an id (UUID), an **alias** (`@research-1`, unique per account),
    OS/arch/user, **options** (time limit, container, mounts, GPU, scratch
    quota) and **notes**.
  - Its status is online or offline, with time left.
- **Daemon:** `cocalc computer connect`, part of the CLI.
  - One per user per machine, keeping one outbound websocket to the site's
    conat (HTTPS port 443).
  - It runs commands, jobs and transfers, and enforces the options itself.
- **Request:** an agent's (or the owner's) proposal to connect a computer with
  given options, shown as a card. Once approved, it yields a single-use
  **enrollment code** and the line to paste.
- **Grant:** a per-agent switch for one computer, in its own table
  `agent_computer_grants`.
  - Unique on `(account_id, agent_id, source_project_id, computer_id)`, so an
    agent can use several computers.
  - Its own save path and cap. It doesn't count against the connector-grant
    limit.
  - **Fresh auth for every enable,** as connectors (`authorizeConfigChange`);
    disabling needs none.
  - The Connectors menu shows connector and computer grants together.
- **Ticket:** a hub-signed, short-lived permission for *one* operation (one
  exec, one job, one transfer). The daemon checks it. See "Architecture".
- **Job:** a detached command (`run`) the daemon owns.
  - It survives the turn, the daemon restarting, and network loss.
  - It has an id, the agent and thread that started it, its command, status,
    exit code and a log on the machine.
- **Notes:** a short markdown text per computer (at most 4 KB), readable and
  writable by the owner and by agents with a grant, shown with
  `list`/`info`/`notes`.

## How it looks to the human

### The agent asks

> **You:** Make a computer help session on my laptop that mounts ~/datasets
> read-only, so you can check the Docker build.
>
> **Agent:** (runs `cocalc computer request --name laptop --hours 1 --mount ~/datasets:ro --why "check the Docker build"`)
> A card appears in the thread:

```
┌ Connect a computer ──────────────────────────────────────────┐
│ @laptop · requested by @claude-sagebrush                     │
│ Time limit: 1 hour (you can extend it, up to 8 hours)        │
│ Runs: directly as your user on that computer                 │
│ Mounts: ~/datasets (read-only)                               │
│ Agents allowed: @claude-sagebrush                            │
│ Why: check the Docker build                                  │
│ These agents can do anything your user can do on that        │
│ computer until the time limit ends.                          │
│                                  [ Approve ]   [ Decline ]   │
└──────────────────────────────────────────────────────────────┘
```

**Approve** (fresh sign-in if needed) turns the card into:

```
Run this on the computer (valid 15 minutes, once):
curl -fsSL https://cocalc.ai/connect | sh -s -- K7QF-29XM --hours 1 --mount ~/datasets:ro
```

- The settings in the line are for the human to read. The hub checks that they
  match the approved request and refuses the connection otherwise.
- If the CLI is installed, the line is just `cocalc computer connect K7QF-29XM …`.
- The install script installs the CLI under the user's home (no root), as
  `install.sh` does today.

### On the computer

```
Connected to cocalc.ai as @laptop (ends 17:45; extend in CoCalc).
Agents allowed: @claude-sagebrush.  Log: ~/.local/share/cocalc/computer/log
Ctrl-C ends the session and stops everything it started.

16:47:02 @claude-sagebrush  exec  docker ps                    exit 0   0.4 s
16:47:10 @claude-sagebrush  run   docker compose build         job 3   started
16:49:31 @claude-sagebrush  job 3 finished                     exit 0   2 m 21 s
```

- Without a time limit, `--service` installs a systemd user unit (Linux) or a
  launchd agent (macOS), so the daemon reconnects after reboots.
- `cocalc computer status` shows what is connected.
- `cocalc computer disconnect` ends it.
- `cocalc computer uninstall` removes everything.

### In CoCalc

- **Settings → Computers** lists each computer:
  - alias, online/offline, OS, options, time left, notes;
  - the agents switched on, running jobs (all of them), and recent activity;
  - actions: **Extend**, **Disconnect**, **Edit notes**, **Rename**.
- **The agent's Connectors menu** has a switch per computer, next to GitHub
  and Cloudflare.
- **The composer** autocompletes `@computer` aliases. They render as mention
  chips that link to the computer's page.
- **Activity log:** each exec, job and transfer with agent, thread link,
  command, directory, exit code, duration and bytes. It records metadata,
  never command output.

## How it looks to the agent

```sh
cocalc computer list                          # alias, OS, online, time left, notes (first line)
cocalc computer info @research-1              # CPU, RAM, disk, GPUs (+use), load, options, quota/usage, jobs
cocalc computer notes @research-1 [--set FILE]
cocalc computer exec @laptop -- docker ps     # stdout, stderr, exit code (bounded)
cocalc computer exec @research-1 --cwd sweep -- make -j32 test
cocalc computer run @research-1 --name sweep --wake -- python sweep.py
cocalc computer run @bench --exclusive --wake -- ./bench.sh
cocalc computer jobs @research-1              # every CoCalc job there, any of your agents
cocalc computer logs @research-1 sweep [--tail 200]
cocalc computer kill @research-1 sweep        # only jobs you started, unless --force
cocalc computer put @research-1 data/ sweep/data/      # file or directory, ≤ 2 GB
cocalc computer get @research-1 sweep/results/ results/
cocalc computer request --name … [--hours N | --no-limit] [--container IMAGE] [--mount PATH:ro|rw] [--gpu] [--scratch 50G]
```

- **`exec`:**
  - Runs in the user's **login shell environment**, so `PATH` matches
    Terminal (Docker Desktop, Homebrew and conda add to `PATH` only there).
  - **stdin is closed** unless given, so prompts fail instead of hanging.
  - Default timeout 10 minutes, at most 1 hour.
  - Output is capped (1 MB returned); the full output stays in a file on the
    machine, whose path is returned.
- **`run`:** starts a job and returns at once.
  - `--wake` sets a one-shot exit watcher for that job (see Sensors).
  - `--exclusive` queues until no other CoCalc job runs there; other `run`s
    then queue behind it. Short `exec`s still run.
- **Working directory:** each computer has a default one: `~/cocalc` on the
  host, the work volume in a container. Relative paths are relative to it.
- **Disk:** every result includes disk use against the scratch quota when there
  is one, so agents don't have to guess with `df`.
- **Output is untrusted data.** The CLI marks it as coming from a computer,
  not a person.
- **The bundled skill** gets a "Computers" section:
  - read the notes before using a computer;
  - say which computer you are about to change;
  - prefer scripts to step-by-step state;
  - fetch big data on the machine itself (git, curl, pip), not through
    `put`;
  - ask the human for `sudo` commands;
  - for device sign-ins, publish the link and code and let the human approve.

## Architecture

```
 agent's project            account's home bay (hub)              the computer
 cocalc computer exec ──► computer API: check grant, ─ ticket ─►  (via conat router)
   (runtime identity)        expiry, revocation; audit             daemon: verify ticket,
        │                    sign ticket ◄──────────────────────   run, report result
        └──────── data (transfers, output) via router ──────────►  (no hub in the data path)
```

### Control path: the hub authorizes, the daemon verifies

**The hub's check.** The agent's CLI asks the hub for each operation, with its
runtime identity (as `cocalc sensor` and `cocalc agent send` do). The hub (the
**account's home bay**, like connectors) checks, in **one transaction that also
inserts the audit row**, holding `FOR SHARE` on the grant and computer rows:
- the run is active and verified (`verifyActiveAgentRun`), and the request is
  bound to the run's **lease**, not just the bearer;
- the turn's **account** owns the computer;
- the project's **only collaborator is the owner** (decision 15). This is
  rechecked on every ticket, since collaborators can be added later;
- the agent's grant is on;
- the time limit hasn't passed and the computer isn't revoked;
- the operation is within the options (mounts, GPU, sizes);
- the run and the computer are within their **ticket rate limits**, since
  agents can loop.

Revoking, disconnecting and turning a grant off take `FOR UPDATE` and bump the
**revision**, so a revoke can never commit between a check and its signature.
This is the lesson of the sensor fix #1027: the condition has to be part of the
write.

**The ticket** (versioned schema) carries:
- the operation kind and typed parameters;
- the computer, agent, run and thread;
- the **grant and computer revisions**;
- limits (max bytes, timeout);
- a nonce;
- the hub's issue time and an expiry of about a minute;
- the **signing key id** and the hub's signature.

The CLI sends the ticket straight to the daemon through the conat router.

**The daemon's checks:**
- **Signature:** against the hub's current key set, which is pushed signed and
  can be rotated, so tickets carry a key id.
- **Expiry against hub time:** it measures its clock offset from the hub when
  it connects and keeps it current, because laptop clocks drift.
- **Revisions:** it rejects tickets older than the **revision floor**. When
  something is revoked or turned off, the hub pushes a signed new floor, which
  closes the one-minute window whenever the daemon is online.
- **Nonces:**
  - Kept on disk until their ticket expires, or else the daemon rejects any
    ticket issued before it started.
  - It rate-limits cheaply *before* verifying signatures, because any
    authenticated principal can send to `computer.<id>.>`.
- **Its own time limit.**

Then it performs the operation and reports the outcome to the hub (exit code,
duration, bytes), which completes the audit row.

**Why tickets rather than routing everything through the hub:**
- **Hub memory and throughput stay flat.** Transfers and output never pass
  through the hub.
- **The same mechanism covers later stages:** kernels, port forwarding and
  provider-created machines. The hub stays the only place that decides.

### Multi-bay

- **Where things live:** the daemon connects to the **account's home bay**,
  where the computer, grants, jobs mirror and audit live. The agent's runtime
  and project may be on another bay. Routing `computer.*` across bays is new.
  - Requests from the agent's CLI go to the home bay the way connector calls
    do (`cocalc-connector-routing.ts`).
  - The daemon's subjects need inter-bay routing.
  - The existing tests that assert the old inter-bay forwarding must be
    updated together (see the edge-routing checklist).
- **Rehoming an account:** the `account_computer*` and `agent_computer_grants`
  tables need an explicit migration (as `agent_connector_grants` does).
  Until that exists, rehoming is **blocked while the account has computers**.
- **Account deletion:** revokes every computer (pushing the revocation to
  online daemons) and purges grants, requests, the job mirror and audit rows.

### The daemon's identity and credentials

- **Enrollment:** the code is redeemed once for a **computer credential**: a
  key pair whose public half the hub records, plus the hub's public key for
  verifying tickets.
  - A computer credential can only *serve* that computer. It is never an
    account credential, and never `auth login`.
- **Time-limited computers:** the credential stays in the daemon's memory, so
  the session dies with the process.
- **Computers without a limit:** a mode-600 file under
  `~/.local/share/cocalc/computer/` (or the OS keychain), rotatable from
  CoCalc.
- **Never in a project's home,** where snapshots, backups and copies would
  include it.
- **conat:** the daemon authenticates as a new principal type, "computer".
  - conat authenticates with bearer tokens today, so the daemon gets a
    **short-lived conat token through challenge and response** with its key
    pair.
  - It may serve only `computer.<id>.>`, reply into requesters' `_INBOX` (the
    precedent is project-hosts replying to accounts), and publish its reports
    to the hub's computer service.

### Options are enforced on the machine, from the line

- **Where options live:** the options are in the line the human ran
  (`--hours`, `--container`, `--mount`, `--gpu`, `--scratch`, `--no-limit`).
  The daemon enforces them itself, and the hub checks they match the approved
  request.
- **The hub can narrow them** (end early, revoke, refuse operations) **but never
  widen them:**
  - no mount, GPU, host access or extra time beyond what the line allows;
  - extensions beyond the line's hours only up to the 8-hour cap the daemon
    also knows;
  - widening means a new line.
- **What this protects against:** a compromised CoCalc service can at most do
  what the owner pasted, until the time limit or Ctrl-C. The public docs state
  this.

### Time limits fail closed

- At connect and at every extension, the hub sends the end time, signed; the
  extension cap is enforced by the hub.
- The daemon refuses new work after it, kills the **process groups** of
  everything the session started (`podman stop` in a container), and exits,
  even if it lost the hub.
- Disconnecting, revoking or Ctrl-C does the same at once.
- Tickets expire within about a minute, so a revoked or expired computer can't
  be used by a ticket issued just before.

### Jobs

- **Storage on the machine:** each job has a directory
  `~/.local/share/cocalc/computer/jobs/<id>/` with `spec.json`, `log` and
  `status.json` (exit code, end time), written by a tiny wrapper, as the
  sensor exit watcher does.
- **Survival:** the process runs in its own session and process group, so it
  survives a daemon restart and network loss. On restart, the daemon finds its
  jobs again by pid and start time.
- **Offline endings:** the daemon reports jobs that ended while it was offline
  when it reconnects.
- **Hub mirror:** the hub keeps a mirror of each job's metadata (table
  `account_computer_jobs`), so `jobs`, the Settings page and other agents see
  everything without asking the machine.
- **Priority:** on computers without a time limit, jobs and execs run under
  `nice` (and `ionice` on Linux), so a forgotten sweep doesn't starve the
  owner's own work. `--no-nice` turns it off for one job (benchmarks).
- **Exclusive:** a small queue in the daemon. An exclusive job starts only when
  no CoCalc job is running; other jobs wait while it runs. The hub shows the
  queue.
- **Retention:** finished jobs' logs are kept for 7 days or 1 GB per computer,
  oldest removed first.

### Containers (rootless podman)

- **Offered** only when `podman` runs rootless; otherwise the approval card
  says commands run directly as the user.
- **Fixed flags** — the agent chooses only the image, `--fresh` and `--gpu`
  (if allowed):
  - user namespace (`--userns=keep-id`);
  - `--cap-drop=all`, `--security-opt=no-new-privileges`;
  - no `--privileged`, no devices except the allowed GPU;
  - **no podman or docker socket inside**;
  - network on.
- **Disks:**
  - the **work volume**, persistent, one per computer and image, mounted as
    home;
  - the **approved mounts**, read-only or read-write;
  - **scratch** of a soft size, watched by the daemon (stop the job at the
    limit, with a clear message).
- **Images:** the agent chooses. The activity log records the image digest.
  The daemon prunes the least recently used images over a disk budget
  (default 20 GB).
- **Persistent vs fresh:**
  - **Persistent:** one long-running container per image, with jobs started
    by `podman exec` and the exit status written to the work volume.
  - **`--fresh`:** `podman run --rm` per job.

### Files

- **Transfers:** `put` and `get` use the conat file-transfer protocol
  (`conat/files/read.ts`, `write-stream.ts`). The daemon serves the same read
  and write services a project does, so each hop holds at most one chunk and
  backpressure works end to end.
- **Directories** go as a tar stream, with `--exclude` and `--git` (only files
  git tracks).
- **Checks:**
  - a checksum at the end;
  - temporary file then rename, so no half-written file appears;
  - `--force` to overwrite.
- **Paths:** relative to the working directory. In a container, only
  container paths are reachable.
- **Limits:**
  - each transfer is capped at 2 GB, configurable by the site.
  - **`put`** (CoCalc to computer) is egress. The ticket's byte limit is
    *reserved* against the managed-egress windows before it starts (a
    directory is measured first), and the actual bytes are settled from the
    daemon's report.
  - **`get`** (computer to CoCalc) lands under the project's storage quota.
  - Over the cap, the error tells the agent to have the machine fetch the data
    itself.

### Sensors

Watchers stay **one-shot**: since #1027 a watcher with nothing scheduled is
`done`, and pause and resume are refused. So instead of a watcher per computer
that fires for every job, the existing exit watcher learns about computers:

- **The command:** `cocalc sensor watch exit --computer @research-1 -- python
  sweep.py` starts the job on the computer and wakes the agent **once**, when
  it ends, with the exit code and the end of its log. `cocalc computer run
  --wake …` is the same thing.
- **The limit:** `maxWatchersPerAccount` (5 today) goes up for these. With push
  (below), an idle watcher costs almost nothing.
- **Push, poll as fallback.** Sensors live on the **project's** bay;
  computers live on the **account's home** bay, so `kickSensorScheduler()`
  can't reach across.
  - When a job ends, the daemon reports to the home bay.
  - The home bay makes an inter-bay call that sets the watcher's
    `next_run_at = now()` on the project's bay and kicks the scheduler there.
  - The watcher's check reads the job mirror back from the home bay.
  - If the push is lost, the normal poll still fires it.
- **Cost:** wakes count against the account's daily wake budget (100–500 by
  membership since #1005), and wakes held while one is pending are combined,
  so a burst of jobs ending costs little.
- **Other one-shot watchers:** "this computer is back online" (laptops) and
  "the time limit ended".
- **Scripts** may list `computer` in `uses`, for example "wake me when the GPU
  is free".

### Credentials: connector passthrough

- **`--with github` / `--with cloudflare`** on `exec`/`run` (only connectors
  the agent has).
- **Token issue:** for a job, the hub issues tokens under a **job lease**
  modeled on sensor runs (`sensor-credentials.ts`: renew and release).
  - It renews only while the daemon reports the job alive, the grant is on and
    the computer isn't revoked, up to a cap (24 h).
  - An `exec` within a turn uses the turn's tokens.
  - **One token per job or turn,** not one per command, so a looping agent
    can't exhaust the provider request budget (`admitProviderRequest`).
- **What "expires" really means:** the token is *revoked* when the job ends.
  If that revocation is lost (for example while the daemon is offline), the
  token lives until the provider's own expiry, which we can't shorten (GitHub
  App user tokens: 8 h). The docs say so.
- **Delivery:** git's credential helper or a file descriptor for that job, in
  preference to environment variables. A same-user process can read another
  process's environment through `/proc`, which matters for direct (not
  container) jobs on a shared server account. Never written to disk.
- **Output masking:** token values are replaced with `***` in the output the
  agent sees.

### Notes and aliases

- **Notes** live at the hub with the computer, are edited by the owner or
  agents with a grant, are versioned (the last 20 kept), and are shown by
  `list`, `info` and `notes`.
- **Aliases:**
  - **Format:** names match the existing pattern, unique per account. Renaming
    keeps the id.
  - **Mention span:**
    `<span class="computer-mention" data-computer-reference="…">@name</span>`
    with `{version: 1, account_id, computer_id, name}`, as for agents and
    artifacts. A mention never grants access.
  - **Resolution:** the CLI accepts `@name`, `name` or the id.

### Audit

- **At the hub,** under the account's home bay: one row per operation (account,
  agent, run, thread, computer, operation, command or paths, directory, image,
  connectors passed, start, end, exit code, bytes).
  - Metadata only: output goes only to the agent that ran it.
  - Kept 90 days, and visible on the computer's page.
- **On the machine:** the daemon's local log, the same fields, so the owner
  can check without trusting CoCalc.

## Security model

| Threat | Mitigation |
|---|---|
| A collaborator, or a collaborator's turn of my agent, uses my computer | The hub checks the turn's account against the owner on every ticket. No project-level access exists. |
| **A collaborator in a shared project acts *as* my agent during my turn** (same Linux user, so they can read the runtime bearer from `/proc/<pid>/environ` and the lease directory) | The account check passes, because it *is* my turn. So computers work only in projects where the owner is the only collaborator (decision 15), checked on every ticket, and tickets are bound to the run's lease. |
| A revoke commits between a check and the signature | Check and audit insert in one transaction under `FOR SHARE`; revoke and turn-off take `FOR UPDATE` and bump the revision; tickets carry revisions and the daemon enforces the pushed floor. |
| A ticket is replayed after the daemon restarts | Nonces persisted until expiry, or tickets issued before the daemon started are rejected. |
| A laptop's clock is wrong | Expiry is checked against a hub-relative offset measured at connect. |
| The hub's signing key must change | Key ids in tickets; signed key sets pushed to the daemon. |
| Someone floods `computer.<id>.>` | A cheap rate limit before signature checks; ticket issuance rate-limited per run and per computer. |
| A less trusted agent gets a more powerful one to act (confused deputy) | Per-agent grants; nobody gets more access than the agent that asked. Machine output is marked untrusted. |
| An enrollment code is stolen | Single use, expires in 15 minutes, useless until the owner approves (approval precedes redemption). It binds to the approved options. |
| A ticket is replayed | A one-time nonce per ticket, kept by the daemon until the ticket expires. Tickets name one operation and one computer. |
| A revoke is lost, or the connection drops | Short tickets, a signed end time enforced on the machine, process groups killed. |
| An agent escapes the container to the host | Rootless podman, fixed flags, only approved mounts, no sockets. The agent never passes flags. |
| A bad image | Only inside the container boundary. The digest is logged, and disk is bounded. |
| Long-lived credentials left on the machine | Passthrough tokens are short-lived and never on disk. Device sign-ins are only documented. |
| The daemon looks like malware's hidden backdoor (the VS Code tunnel abuse) | Always visible: the banner, `status`, the local log, `uninstall`. No start at boot without `--service`. One install directory. |
| Slow readers exhaust memory | The conat file-transfer flow with one outstanding chunk, admission limits, and idle timeouts. |
| A runaway job fills the disk or starves the owner | Scratch quota watched, log retention bounded, `--exclusive` queue, `nice` by default on computers without a time limit. |
| Prompt injection through output a job prints | Output is marked untrusted. Credentials are narrow and short-lived. The time limit bounds help sessions. |
| A compromised or malicious CoCalc service | It can sign tickets, so it can run commands within the options the owner pasted, but never widen them. The time limit, Ctrl-C and `uninstall` are local. The local log records what ran. Containers and mounts bound what it reaches. Documented plainly (decision 19). |
| An agent requests a computer for itself | Only a human can approve a request, with fresh auth. Provider-created computers come only from a connector the human approved with limits. |

New hub RPCs and their fresh-auth decisions go in `dangerous-rpc-registry.ts`:
- **Fresh auth:** `approveComputerRequest`, `extendComputer`, and turning a
  grant on for a time-limited computer.
- **No fresh auth:** disconnecting or turning off (both narrowing).
- **Agent identity, no human:** `issueComputerTicket`.

## Data model (account home bay)

- **`account_computers`:**
  - `computer_id`, `account_id`, `name` (alias), `os`, `arch`, `user`;
  - `options` (jsonb: time limit, container, mounts, gpu, scratch), `notes`,
    `notes_revision`;
  - `credential_public_key`, `status`, `connected_at`, `last_seen`, `ends_at`;
  - `origin` (`user` | `provider:<connection id>`);
  - `revision`, `created`, `revoked_at`.
- **`account_computer_requests`:** `request_id`, `account_id`, requesting
  agent/run/thread, options, `why`, `state`
  (`pending|approved|declined|redeemed|expired`), `code_hash`,
  `code_expires_at`, `approved_by`, `approved_at`.
- **`account_computer_jobs`:** a mirror of each job's metadata: id, computer,
  agent, thread, command (truncated), image, exclusive, state, exit code,
  start and end.
- **`account_computer_audit`:** one row per operation (above).
- **`agent_computer_grants`:** `grant_id`, `account_id`, `agent_id`,
  `source_project_id`, `computer_id` (unique together), `enabled`,
  `revision`, `created_at`, `updated_at`.
- **Bay ownership:** all of these are account-home tables. Rehoming is blocked
  while computers exist, until a migration is written. Account deletion purges
  them.

## Public documentation (decision 19)

Written in `src/packages/docs` as each stage ships, describing only what is
built, and reviewed by the security reviewer.

- **Connect a computer** (how-to):
  - what it is for;
  - the request card and the line;
  - the two options (time limit or none), containers, mounts, scratch;
  - Settings → Computers;
  - Disconnect and uninstall;
  - WSL2 on Windows.
- **How computers keep you safe** (the trust model), plainly:
  - **What runs where:** the agent in CoCalc; commands on your computer as the
    user who ran the line, or in a rootless container.
  - **Who can use a computer:** only the agents you switched on, only in your
    own one-person projects, only during your turns.
  - **What CoCalc stores:**
    - the audit of operations (metadata, 90 days) and the job list;
    - notes;
    - the computer's public key;
    - provider API keys, encrypted.
  - **What passes through CoCalc:** command output passes through CoCalc's
    servers to the agent, and from there to the AI model provider as part of
    the agent's context.
  - **Credentials:**
    - connector tokens are short-lived, per job or turn, and never on disk;
    - their real lifetime if a revocation is lost (8 h for GitHub);
    - nothing of yours is copied to the computer otherwise;
    - the computer's own credential, and where it is kept.
  - **The limits of trust:**
    - a compromised CoCalc could run commands within the options you pasted,
      never beyond them, and the time limit, Ctrl-C and the local log are
      yours;
    - an allowed agent can do anything that user can do, which is why
      containers, dedicated users and short time limits exist;
    - prompt injection, and why narrow credentials matter more than
      approvals.
- **Compared with the alternatives,** as a table:
  - AI Commander (a machine code pasted into the AI client grants access; no
    command log at the relay);
  - giving the agent an SSH key, or an MCP SSH server (standing access, no
    per-agent scope, often no authentication);
  - VS Code tunnels;
  - GitHub self-hosted runners;
  - running a local agent (Claude Code, Codex) on the machine itself.

  The table covers who can use the machine, for how long, where credentials
  live, what is logged, and how you stop it.

## Stages

Each stage ships with tests and a live check on real machines:
- `ssh m1` (macOS, Apple Silicon);
- bench-1 (Linux);
- a WSL2 machine for stage 1's Windows check;
- deployed on lite1b or lite4b.

### Stage 1: computers that run commands and jobs, and move files

**Builds:**
- requests, cards and approval;
- enrollment;
- the daemon;
- tickets;
- `list`/`info`/`notes`/`exec`/`run`/`jobs`/`logs`/`kill`/`put`/`get`;
- per-agent grants in the Connectors menu;
- both options (a time limit, extend up to 8 h; or none with `--service`);
- `--exclusive`;
- aliases and mentions;
- the Settings page;
- audit at the hub and on the machine;
- the skill section and docs (replacing `self-hosting/reverse-ssh-access`),
  including the trust-model page;
- the egress reservation;
- macOS and Linux, plus Windows via WSL2.

**Leaves out:** containers, sensors, credentials passthrough.

**Done when:**
- An agent asks for your Mac for 1 hour.
- You approve and paste the line.
- The agent builds a Docker image, sends a directory and fetches results.
- You extend the session once.
- The session ends on time and kills a running job.
- On bench-1 without a time limit: two agents run jobs, one `--exclusive`, and
  each sees the other's jobs; the machine reboots and comes back with
  `--service`.
- The audit and the local log agree.
- Tests:
  - a revoke racing a ticket issue never yields a usable ticket;
  - a ticket from before a revocation is refused by an online daemon;
  - a replayed ticket is refused, also after a daemon restart;
  - a skewed laptop clock still enforces the time limit;
  - a collaborator added to the agent's project stops new tickets.

### Stage 2: containers

**Builds:**
- rootless podman with fixed flags;
- persistent containers and `--fresh`;
- images chosen by the agent, with digests logged and pruning;
- approved mounts;
- scratch soft quota reported in every result;
- `--gpu` with the warning;
- container options on requests and cards.

**Done when:**
- An agent tests an installer on a fresh `ubuntu:22.04` and on `fedora`.
- A mount marked `:ro` refuses writes.
- Scratch over its quota stops the job with a clear message.
- A GPU job runs on a GPU machine.

### Stage 3: sensors and credentials

**Builds:**
- exit watchers on computers (`sensor watch exit --computer`, `run --wake`), with an inter-bay push plus kick;
- "back online" and "time limit ended" watchers;
- `--wake`;
- connector passthrough (`--with github`) with output masking;
- job leases for credentials (renewed while the job runs, capped at 24 h).

**Done when:**
- A 2-hour job wakes the agent within seconds of ending, including when it
  ended while the laptop slept.
- `git push` from a job works with `--with github`, and the token appears
  neither on disk nor in the agent's output.

### Stage 4: provider connectors (RunPod first, then Lambda, others)

**The connector itself:**
- an **account connection** to the provider, where the hub holds the API key
  or OAuth token in the external-credentials store and **agents never get
  it**;
- **limits** you set when connecting: $/hour, $ per month, how many machines,
  allowed GPU types and regions, "destroy after N hours idle".

**Agent operations, at the hub:**
- `cocalc computer provider offers runpod --gpu-mem 48G`;
- `cocalc computer provider create runpod --offer … --image … --name @a100`.

The hub checks the limits, creates the machine with a startup command that
installs the CLI and runs `connect` with a **pre-approved enrollment code**
bound to that machine, and the machine appears as a computer with
`origin = provider`.

**Machine lifecycle:**
- stop/destroy from CoCalc, with cost shown on the computer page;
- **auto-destroy** when idle or at the end of a time limit;
- destroying it also disconnects it.

**Done when:** the agent can, within the limits and with no credential ever
shown to it, carry out "give me a container with a GPU of at least 48 GB, run
this training job, bring back the checkpoint, and destroy the machine".

### Stage 5: kernels, the browser, ports

**Builds:**
- **remote Jupyter kernels over the computer connection:** a launcher like
  `jupyter/kernel/remote-launcher.ts` whose transport is a ticketed stream
  instead of ssh. A notebook picks "Python on @a100". This completes "set up a
  remote kernel on a RunPod GPU you create" without SSH or credentials;
- **the shared browser's computer mode** (#939) on the same connection,
  replacing its own `ssh -R`;
- **port forwarding** for one port per ticket, to view a web server running on
  the computer (TensorBoard) in the shared browser.

### Stage 6: more

**Builds:**
- **named secrets by reference** (`--secret HF_TOKEN`): account secrets
  switched on per agent, masked in output;
- **native Windows** (PowerShell exec, Job Objects for process groups);
- **sharing a computer with a specific collaborator's agents**, as an explicit
  per-person grant, if wanted;
- **cloud identity without stored keys:** CoCalc issues short-lived OIDC
  tokens to jobs that AWS and GCP trust.

## Rules stage 1 must get right (so later stages don't redo it)

1. **The ticket covers every operation.**
   - It names the operation kind and a typed parameter set. Stage 5's
     `kernel` and `port` are new kinds, not a new protocol.
   - The daemon reports a **capability list** at connect (`exec`, `run`,
     `files`, `container`, `gpu`, later `kernel`, `port`). The hub issues only
     tickets for capabilities present.
2. **Computers have an `origin`** from day one (`user` or `provider:<id>`), and
   enrollment codes can be *pre-approved* by a provider connection. Stage 4
   adds the issuer, not a second enrollment path.
3. **Options are one typed object** (`ComputerOptions`) used by requests,
   cards, the line, the daemon and the hub alike. Containers, mounts, scratch
   and GPU are fields from the start, even if stage 1 rejects them.
4. **The data path never goes through the hub.** Transfers and output streams
   go through the router to the daemon, so kernels and port forwarding inherit
   the same flow control.
5. **One grant per agent per computer** (`agent_computer_grants`), not one per
   agent. Fresh auth for every enable. Shown in the Connectors menu with the
   connector grants, and usable by sensors' `uses`.
6. **Names and mentions** use the shared pattern, and the CLI resolves
   `@alias` everywhere.
7. **Jobs are durable on the machine and mirrored at the hub.** Sensors in
   stage 3 and provider idle-detection in stage 4 read the mirror.
8. **The ticket protocol is complete from the start:**
   - a schema version and signing-key ids, with key rotation;
   - grant and computer revisions, with a revision floor pushed on
     revocation;
   - persisted nonces, or "not before the daemon started";
   - a hub-relative clock;
   - a binding to the run's lease;
   - rate limits per run and per computer;
   - check, sign and audit in one transaction.
9. **The private-project rule** (decision 15) is enforced at the hub on every
   ticket.
   - The Connectors menu shows computers as unavailable in shared projects,
     with the reason.
   - Requests from shared projects are refused.
   - When a collaborator is added, the owner is told that computers stopped
     working there.
10. **Cross-bay routing, rehoming (blocked until migrated) and account
    deletion** are handled for the new tables from the start.
11. **Options come from the line and are enforced by the daemon;** the hub
    can narrow but never widen them.
12. **Output and job logs are data, not instructions,** and the agent-facing
    CLI output says so.
13. **The daemon is small, self-contained and tidy:**
   - one directory;
   - one daemon per user per machine;
   - old versions removed;
   - `uninstall`;
   - no dependency the standalone CLI can't load (#937).

## Open questions

None right now: William answered revision 2's questions (decisions 7, 14–18).
The security review may raise new ones.

## Prior art and lessons

- **[AI Commander](https://aicommander.dev/)** is almost exactly this as a
  product.
  - What it is: an outbound agent on your machine, used by AI clients over MCP
    or REST, with detached jobs, GPU reservations, files up to 100 MiB, and
    $49/month for the paid tier.
  - **Validation** that people want and pay for it.
  - **Weaker access model:** a "machine code" pasted into the AI client grants
    access, so a bearer secret ends up in chat transcripts. Ours is tied to the
    account and checked per turn.
  - **Privacy over audit:** "The relay does not log or store commands". We
    record metadata by default.
  - **Machine notes,** adopted here.
  - **The architectural difference:** they connect a desktop harness (Claude
    Code, Codex) through MCP. We host the agents, which gives sensors, global
    job visibility, connectors and memory.
- **[GitHub self-hosted runners](https://devclass.com/2024/01/15/spotlight-on-github-self-hosted-runners-again-as-researcher-demonstrates-attack-on-pytorch-code)**
  are the closest architecture: outbound polling over 443, a short-lived
  registration token, jobs.
  - Persistent runners accumulate residue (cached credentials, tools, planted
    processes) and were attacked when strangers could trigger jobs
    ([guide](https://open-exam-prep.com/study-guides/github-actions/runner-infrastructure-and-management/ch07-sec03-runner-security-ephemeral)).
  - So: only your own agents, containers with `--fresh`, and tokens that live
    for one job.
- **[AWS SSM Session Manager](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-logging.html):**
  an outbound agent with access checked by IAM. Logging interactive sessions
  is fragile: logs are truncated without `screen`. We log structured
  operations and have no terminals.
- **[VS Code Remote Tunnels](https://www.mintlify.com/microsoft/vscode/cli/tunnel)
  and VS Code Server ([HN](https://news.ycombinator.com/item?id=49822555)):**
  - Tunnels are abused as hidden backdoors (signed binary, trusted outbound
    destination, missed by security tools;
    [report](https://spyderbat.com/blog/visual-studio-code-remote-tunnel)).
    Hence "always visible".
  - VS Code Server leaves 3–6 GB in `~/.vscode-server` and dozens of stale
    sessions on shared clusters. Hence "small and tidy, one daemon per user".
- **[Teleport](https://goteleport.com/learn/infrastructure-identity/just-in-time-access/)
  and [Tailscale SSH](https://tailscale.com/kb/1193/tailscale-ssh):**
  - Time-limited access, re-authentication periods (12 h in Tailscale), and
    session recording.
  - Teleport's [Beams](https://goteleport.com/docs/beams/) (throwaway microVMs
    for agents with delegated identity, "no secrets, no static API keys") point
    the same way as our credentials plan.
- **[SSH multiplexing for agents](https://www.codewrecks.com/post/ai/give-ssh-access/):**
  the human authenticates, the agent uses the open connection, and revocation
  is unilateral. The same principle as ours, done by hand.
- **[The Cursor/Railway incident, April 2026](https://mondoo.com/blog/5-lessons-from-9-seconds-ai-agent-deleted-production-database):**
  an agent deleted a production database and its backups with a standing,
  all-powerful token it found. Narrow, short-lived credentials matter more
  than approving commands.
- **[MCP SSH servers](https://blakecrosley.com/blog/mcp-servers-are-the-new-attack-surface):**
  many local shell servers without authentication. We keep one checkpoint, the
  hub, and no local shell server.
- **[AgentsRoom Remote Fleet](https://agentsroom.dev/features/remote-fleet):**
  the inverse model, with agents running on each machine and one window over
  all of them.
