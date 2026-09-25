# My Agents Workspace: First-Slice Progress

Date: 2026-09-17

Implementation branch: `feature/my-agents-workspace`

Tested implementation head: `83d99cba246c87925485a022e8c7563b592fd381`

Foundation: `origin/main` plus the artifact work from PR #509. Agent messaging is
already present in `origin/main`.

## Implemented

- `/agents` and `/agents/<agent-id>` application routes, with My Agents before
  Projects in the top navigation.
- Default-off **Enable My Agents Page (Experimental)** account preference and
  normal post-sign-in landing behavior for opted-in accounts.
- Registry-only named-agent directory. The page never scans project filesystems
  or promotes unregistered chats.
- Personal search, pins, recent order, custom drag order, keyboard move controls,
  and durable bounded account metadata.
- New Agent with an existing project, validated working directory, unique name,
  optional description, hidden chat storage, registration, and a first-request
  draft. Creation alone does not send or start compute.
- Full existing chat/frame-tree workspace, including the artifact workbench and
  existing terminal frame support. Project pages remain an explicit escape hatch.
- Lazy mounting on first visit, persistent hide/show switching, explicit Close
  workspace recovery, and hidden-view focus release.
- Selected-agent project/sharing context and specific retry/unavailable states.
- A selected-thread-only, five-message read-only preview while the full editor
  initializes. It reuses current project-host routing, starts no compute, and
  closes its temporary session when the full editor is ready.
- Registered agents in Quick Navigation without opening one project session per
  directory row.
- Narrow-screen list/workspace transitions and a persistent management link.
- Integrated documentation under the docs package.

## Verification

- `pnpm -C src build:dev` passed. The only warning was the pre-existing inability
  to open `/home/user/.cache/cocalc/project/log`.
- Frontend typecheck and `pnpm -C src lint:frontend` passed.
- Eight focused suites passed: 41 tests covering preview bounds/lifetime,
  organization persistence, sign-in routing, Quick Navigation, direct agent
  routing, and the workspace preference.
- The exact tested head was compiled into the static development bundle and
  exercised at `https://lite1b.cocalc.ai` using the existing Chromium session.
- Live checks passed for directory rendering, desktop agent switching, selected
  URL updates, persistent mounted workspaces, hidden-view focus release,
  explicit close/reopen, New Agent controls, and narrow-screen list/workspace
  transitions. No alert errors were present.

## Remaining Qualification

- The running lite1b hub predates the direct-route allowlist change. Live tests
  therefore entered through `/static/app.html?target=...`; direct route handling
  is unit-tested and requires the normal hub deployment/restart to verify live.
- Complete two-human/read-only and cross-bay acceptance remains to be run for
  this page. The implementation uses existing project ownership/routing and
  permission checks rather than adding a new access path.
- Artifact editing, feedback origin, attachments, streaming, approvals, and
  terminal frames are inherited components and build successfully, but the full
  end-to-end acceptance matrix in the plan has not yet been repeated from My
  Agents with two humans.
- Quick Navigation lists registered agents. Direct numbered selection of an
  artifact or terminal frame inside a hidden agent workspace is not yet added.
- A dedicated terminal-artifact descriptor is deferred. Existing frame controls
  can open terminals; a new convenience action must first preserve the thread's
  configured working directory and must not disturb artifact tabs.
- Browser reload does not retain the in-memory set of previously mounted hidden
  workspaces; the selected agent and existing chat/frame persistence do restore.
- Long-session browser memory and cold-directory timing still need measurement
  with a realistically large registered-agent directory.

## Operational Notes

- The account preference is discoverability and home-page behavior, not an
  authorization boundary. Disabling it does not delete agents, revoke links, or
  stop work.
- Reading a chat and the bounded preview use project-host file/chat services and
  do not start project compute. Sending, terminals, and execution retain their
  normal startup and admission behavior.
- Hidden workspaces remain mounted intentionally. **Close workspace** releases a
  view without deleting its agent or stopping server-side work.
