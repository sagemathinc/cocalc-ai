# Codex, CoCalc, And Launchpad Integration Polish

Last refreshed: April 23, 2026

## Executive Summary

Codex inside CoCalc now works well enough to dogfood real Launchpad workflows:

- Codex app-server runs inside projects.
- ChatGPT subscription auth and API-key fallback work.
- Generated images can be surfaced as blob-backed markdown.
- Launchpad project-host routing is stable enough for normal Codex turns.
- The CoCalc CLI can be made available inside Codex turns.
- Agent-mode CLI auth now reaches the hub using `COCALC_API_URL` and a bearer
  token instead of accidentally treating project runtime `CONAT_SERVER` as the
  initial account endpoint.

This is a major milestone, but the integration still feels opportunistic rather
than first-class. Agents can eventually accomplish many tasks, but they still
take brittle paths, hit low-quality errors, and sometimes need to discover the
right CoCalc command by trial and error. That wastes turns and makes the system
feel less capable than it is.

The next phase should make Codex in CoCalc feel like a native, reliable
operator of the user's live workspace.

A critical enabling requirement is a simple way to kick off exactly one real
Codex turn, like a user does in the browser, preferably from a Chromium-backed
test harness. Without that, every integration fix is too dependent on manual
dogfooding and ad hoc screenshots.

## Product Goal

When a user asks Codex about their CoCalc work, Codex should reliably understand
and operate on the live CoCalc context:

- open browser tabs,
- selected workspace,
- live editor contents,
- notebooks and running kernels,
- terminals,
- project files,
- project settings,
- snapshots/backups,
- generated images and blob outputs.

The user should not have to know whether the needed data lives in:

- the hub,
- the browser session service,
- a project-host Conat service,
- the project runtime filesystem,
- the file server,
- the notebook runtime,
- the chat long-term log.

Codex and the CoCalc CLI should choose the right path automatically.

## Current Baseline

### Working

- Agent runtime env includes the key identity variables:
  - `COCALC_ACCOUNT_ID`
  - `COCALC_AGENT_TOKEN`
  - `COCALC_API_URL`
  - `COCALC_BEARER_TOKEN`
  - `COCALC_BROWSER_ID`
  - `COCALC_CLI_AGENT_MODE`
  - `COCALC_PROJECT_ID`
- CLI agent mode now prefers the hub URL for its initial account context when a
  bearer token and `COCALC_API_URL` are present.
- The CLI can then use routed project-host clients for project-scoped services.
- `browser files --browser ... --project-id ...` can list live open
  files/tabs in the user's browser session.
- `browser screenshot` can capture live browser state and has been useful for
  checking live editor content.
- Codex can answer browser-tab and live-editing questions after falling back to
  working commands.

### Recently Fixed

- `missing project_secret for project auth` from agent-mode CLI calls.
- Initial CLI connection using project runtime `CONAT_SERVER` instead of the
  hub `COCALC_API_URL`.
- Project-host Conat auth now defensively accepts bearer auth before
  project-secret auth.
- `browser files` accepts `--project-id`, and `browser tabs` is a user-facing
  alias.
- The active Codex runtime guidance now recommends `browser files` first for
  open-tab/file questions.

### Still Fragile

- `browser workspace-state` can fail with:
  - `quickjs sandbox execution failed: [object Object]`
- `browser exec` can fail with the same opaque QuickJS error.
- Agents often inspect `exec-api` or retry raw `browser exec` when a higher
  signal typed command exists.
- Error messages often expose implementation details but not user-actionable
  recovery steps.
- There is no compact launchpad-specific smoke test that proves a Codex turn can
  use the CLI to query browser state, project files, and notebook state.

## Integration Model

The CLI should behave like the browser:

- Account and browser-session questions start at the hub.
  - But we need to be aware of `/home/user/cocalc-ai/src/.agents/scalable-architecture.md` , which is now mostly implemented.
- Project file, terminal, notebook, sync, and filesystem questions route to the
  project-host that owns the project.
- Runtime-local commands execute inside the project container only when that is
  the right source of truth.
- Live browser UI state is authoritative for selection, viewport, open tabs,
  and unsaved editor state.
- Live notebook state is authoritative for notebook cells, outputs, kernel
  state, and running executions.
- Filesystem state is authoritative only for saved content.

This distinction must be encoded in tools and skills so agents do not have to
infer it repeatedly.

## Priority Workstreams

### 1. Browser Automation Reliability

Fix the current brittle path for live browser inspection.

Tasks:

- Fix `browser workspace-state` QuickJS sandbox failures.
- Fix `browser exec` QuickJS sandbox failures for simple API calls such as
  `api.listOpenFiles()`.
- Serialize sandbox errors as structured JSON with useful fields:
  - error name,
  - message,
  - stack when available,
  - policy/posture,
  - rejected API call if known.
- Add regression tests for QuickJS error serialization.
- Add a live smoke for:
  - `browser files`,
  - `browser workspace-state`,
  - `browser screenshot`,
  - `browser exec-api`,
  - a minimal `browser exec` call.

Acceptance criteria:

- A Codex turn can answer "what browser tabs do I have open?" using a single
  successful command.
- QuickJS failures no longer render as `[object Object]`.

### 2. CLI Command Ergonomics

Make high-signal commands consistent and discoverable.

Tasks:

- Add `--project-id` to `browser files` as an alias/filter parallel to other
  browser commands. (Done.)
- Make `browser files` the documented command for open tab/file listing. (Done.)
- Consider `browser tabs` as a user-facing alias for `browser files`. (Done.)
- Ensure `browser workspace-state` clearly documents that it is for workspace
  selection/records, not just open tabs.
- Improve `browser --help` examples for agent-mode usage:
  - exact browser id,
  - exact project id,
  - no session discovery under agent auth unless explicitly allowed.
- Add CLI tests for option compatibility.

Acceptance criteria:

- Neighboring browser commands use consistent project targeting flags.
- Agents can choose the right command from help text without trial and error.

### 3. CoCalc Skill / Agent Instructions

Update the skill and system guidance so Codex chooses robust paths first.

Tasks:

- For "what tabs/files are open?", use:
  - `browser files --browser "$COCALC_BROWSER_ID" --project-id "$COCALC_PROJECT_ID"`
- Use `workspace-state` only for questions involving:
  - selected workspace,
  - workspace records,
  - workspace-scoped chat.
- Use screenshots when the question is about visible unsaved UI state.
- Use notebook CLI APIs for notebook content/execution instead of reading
  `.ipynb` JSON directly.
- Prefer typed browser actions over raw `browser exec` when available.
- Add explicit fallback order for common user questions:
  - open tabs,
  - active tab,
  - live editor content,
  - notebook cells,
  - terminal history,
  - project settings,
  - snapshots/backups.

Acceptance criteria:

- A fresh Codex turn uses the correct first command for common CoCalc questions.
- The agent does not ask the user to paste state that the CLI can fetch.

### 4. Launchpad Agent Auth Smoke Tests

Add a systematic test plan for the path that matters most.

Tasks:

- Create a small smoke script or checklist for a live Launchpad dev server:
  - start a project,
  - open a chat,
  - verify runtime env contains the agent identity variables,
  - run `browser files`,
  - run `browser screenshot`,
  - run one project-host file command,
  - run one notebook command if a notebook is open.
- Verify both paths:
  - ChatGPT subscription auth,
  - API-key fallback auth.
- Verify project-host move/restart does not leave stale CLI auth state.
- Record expected failure messages for expired ChatGPT auth and missing API key.

Acceptance criteria:

- One command or checklist can validate the full "Codex can operate CoCalc"
  loop after a build.
- Failures clearly identify whether the broken layer is hub auth, project-host
  auth, browser-session auth, or runtime env injection.

### 5. One-Turn Chromium Harness

Make it easy to start exactly one Codex turn through the real Launchpad UI.

Initial implementation: `src/scripts/dev/codex-launchpad-one-turn-chromium.mjs`
and `pnpm smoke:codex-launchpad-ui`.

This is the highest-value test harness for the integration because it exercises
the same path as a user:

- browser UI,
- chat composer,
- ACP request creation,
- app-server startup,
- project runtime env injection,
- CLI calls from inside the turn,
- streamed activity log,
- final persisted chat response.

Tasks:

- Add a Chromium-backed script or browser harness action that:
  - opens a target Launchpad project/chat,
  - waits for chat readiness,
  - submits one prompt,
  - waits for that single turn to finish,
  - captures the activity log,
  - captures the final chat message,
  - exits without starting a second turn.
- Support prompts that verify common integration paths:
  - "what browser tabs do I have open?"
  - "what number is visible in this open editor?"
  - "list cells in the open notebook"
  - "generate a small image and return the blob markdown"
- Make the harness deterministic:
  - explicit API URL,
  - explicit browser id or spawned Chromium session,
  - explicit project id,
  - one prompt,
  - one turn,
  - bounded timeout,
  - JSON artifact output.
- Store artifacts under a predictable path:
  - prompt,
  - activity log,
  - final answer,
  - screenshots on failure,
  - browser console errors,
  - relevant CLI JSON output.
- Add a "dev quick run" mode that uses the current live browser session and a
  "clean spawned Chromium" mode that starts its own browser.

Acceptance criteria:

- A developer can run one command after a build and get a pass/fail result for
  "Codex can use CoCalc from a real Launchpad chat turn."
- The harness does not depend on manually copying text from the activity drawer.
- Failed turns leave enough artifacts to identify whether the failure is in UI,
  ACP/app-server, runtime env, CLI auth, browser automation, or project-host
  routing.

### 6. Error UX And Recovery

Make failures useful to users and to Codex.

Tasks:

- Split primary turn failure from stderr/log-tail diagnostics in the chat UI.
- Detect auth-specific Codex failures:
  - expired ChatGPT token,
  - missing API key,
  - missing bearer token,
  - project-host token issuance failure.
- Surface a button/modal to reauthenticate instead of showing raw red logs.
- Add retry classification for transient stream failures.
- In CLI JSON errors, include:
  - command,
  - layer (`hub`, `browser-session`, `project-host`, `project-runtime`),
  - retryable boolean when known,
  - suggested next command when known.

Acceptance criteria:

- A normal user can recover from expired ChatGPT auth without reading raw logs.
- An agent can decide whether to retry, reauth, fallback, or stop.

### 7. Native CoCalc Artifacts From Codex

Make generated outputs first-class CoCalc objects.

(USER: I think this is done already)

Tasks:

- Ensure generated images always become CoCalc blobs when possible.
- Show generated images inline in chat using blob markdown.
- Keep `.codex/generated_images` as cache only, not the user-facing artifact.
- Provide copy-markdown affordances in activity logs.
- Add a stable metadata model for generated assets:
  - source turn,
  - prompt,
  - blob uuid,
  - filename,
  - MIME type.

Acceptance criteria:

- Generated images are immediately reusable in markdown/html/chat.
- The user never has to find files in `.codex/generated_images`.

## Suggested First Implementation Pass

1. Fix QuickJS error serialization.
2. Fix or bypass the `workspace-state` QuickJS failure.
3. Add `--project-id` support to `browser files`. (Done.)
4. Add the one-turn Chromium harness for Launchpad Codex chat. (Done.)
5. Update the CoCalc skill/instructions for tab listing and live editor checks.
   (Runtime guidance done; skill/checklist updates still need follow-up.)
6. Add one Launchpad smoke script/checklist.

This sequence targets the observed false starts directly and should make the
next dogfooding session much cleaner.

## Non-goals

- Redesign Codex app-server.
- Replace the CoCalc CLI with a new tool protocol.
- Make raw browser JavaScript the primary integration path.
- Make project filesystem reads stand in for live editor/notebook state.
- Solve every Launchpad operations issue before improving the agent UX.

## Risks

- Overusing raw browser exec can create a security and reliability burden.
- Underusing browser state can make Codex answer stale saved-file data instead
  of live unsaved UI state.
- Routing mistakes between hub and project-host can reintroduce confusing auth
  errors.
- If the skill is updated without matching CLI reliability fixes, agents may
  still spend turns on fallbacks.

## Success Criteria

Codex-in-CoCalc should feel native when it can:

- tell the user what tabs are open,
- identify the active file,
- inspect visible unsaved editor content,
- inspect and run notebook cells,
- use terminals safely,
- edit files through normal CoCalc project services,
- generate reusable blob-backed images,
- survive project restarts and browser reconnects,
- explain actionable auth/retry steps when something fails.

The near-term bar is not "perfect autonomous IDE." The near-term bar is: common
CoCalc questions should work on the first path Codex chooses.

