## Assistant Agent Golden Path

This document defines the exact end-to-end contract for replacing the legacy
frontend Assistant flow with a workspace-scoped Codex agent flow in CoCalc Lite.

Target environment:

- server: `http://localhost:7003`
- environment source: `pnpm -s dev:env:lite`
- project id: `00000000-1000-4000-8000-000000000000`

Do not use `localhost:7000` for development validation. That server is for
dogfooding chat with Codex, not for validating the dev bundle.

## Goal

Make the title-bar Assistant behave like one long-lived Codex agent per
workspace by default.

The Assistant should stop behaving like a one-shot prompt launcher that spawns
new threads unpredictably.

## Canonical Scenario

Use one markdown file inside a workspace and drive two Assistant interactions in
sequence.

Suggested fixture path:

- `/home/wstein/scratch/cocalc-lite3-lite-daemon/assistant/assistant-agent-golden.md`

Suggested workspace root:

- `/home/wstein/scratch/cocalc-lite3-lite-daemon/assistant`

## Acceptance Criteria

### First interaction

1. Open the fixture file inside the `assistant` workspace.
2. Open the title-bar Assistant.
3. Enter a short request.
4. Submit the request.

Expected:

- the Assistant popover closes immediately
- the floating agent dock opens
- exactly one workspace chat thread is selected
- the visible root user message equals the typed request
- the selected thread key is non-empty
- the selected workspace remains `assistant`

### Second interaction

1. Reopen the title-bar Assistant from the same workspace.
2. Submit a second short request.

Expected:

- no new root thread is created
- the floating dock remains on the same selected thread key as the first send
- the second user prompt is visible in that same thread

### Non-goals for the first golden path

These matter, but are not required for the first passing harness:

- prompt quality
- agent output quality
- notebook/terminal support
- refresh persistence
- perfect speed tuning

## Required Runtime Evidence

Every autonomous run should capture:

- API URL
- browser id
- project id
- target file path
- selected workspace
- first selected thread key
- second selected thread key
- whether each user prompt became visible

## Known Failure Signatures

- Assistant popover stays open and allows duplicate submit
- first send creates a thread but the prompt disappears
- second send creates a different thread
- wrong workspace chat path is targeted
- floating dock opens on the wrong session
- prompt lands in chat file but is not visible in the selected thread

## Harness Strategy

Use the browser harness on a spawned Lite Chromium session, pinned to
`localhost:7003`.

The harness should:

1. open the fixture file URL
2. click the title-bar Assistant button
3. type the first prompt and submit
4. record the dock `data-selectedThreadKey`
5. assert the first prompt is visible
6. reopen the Assistant
7. type the second prompt and submit
8. assert the dock `data-selectedThreadKey` is unchanged
9. assert the second prompt is visible

## Commands

Run the dedicated helper:

```bash
cd src
./scripts/dev/run-assistant-agent-golden-lite.sh
```

That helper is expected to:

- apply `dev:env:lite`
- ensure the fixture file exists
- ensure the workspace exists
- spawn a dedicated headless Chromium session
- run the browser harness plan
- destroy the spawned session on exit

## Policy

Do not continue broad Assistant/Codex frontend work until this golden path is
passing reliably.
