# CoCalc-AI Alpha Release Plan

## Purpose

This document defines the execution plan for the first alpha release of CoCalc-AI using items currently tagged `#alpha` in `/home/wstein/cocalc.com/work/wstein.tasks.md`.

Goals:

- keep scope tight enough to ship,
- make dependencies explicit,
- define what "done" means for each item,
- avoid hidden blockers between phases.

### Alpha Release

Start alpha testing by the end of first week of March 2026:

- https://alpha.cocalc.ai will be made live with a registration token
- Launchpad available: https://software.cocalc.ai/software/cocalc-launchpad/index.html 
- Cocalc-Plus available: https://software.cocalc.ai/software/cocalc-plus/index.html 
- CoCalc-CLI available: https://software.cocalc.ai/software/cocalc/index.html 
- All AI functionality via codex.
- Blog Post
- Video

## Release Scope

- **In scope:** tasks tagged `#alpha0`, `#alpha1`, `#alpha2`.
- **Out of scope for first alpha:** everything else unless it blocks an in-scope item.

## Definition of Done (Global)

A phase is complete only if:

1. Each task has a reproducible manual test that passes.
2. The relevant smoke path passes end-to-end in both lite and launchpad where applicable.
3. Regressions are captured by at least one automated test where practical.
4. No known `#blocker` remains in that phase.

---

## Phase Alpha0 (Boot and Lifecycle Correctness)

These are hard prerequisites for reliable tester onboarding.

### A0.1 (done) Launchpad host/project status gating in frontend

**Task:** "frontend UI for working with projects need to be much more aware of host status"

**Done when:**

- Start actions are disabled when host is not `running+online`.
- Project status cannot display `running` if host is not `running+online`.
- Attempting start while host is offline gives a clear action path (e.g., move/start host).

**Depends on:** backend host status truth being accurate and timely.

---

### A0.2 (done) New project start fails: rootfs not mounted

**Task:** "starting any new project says rootfs is not mounted"

**Done when:**

- Fresh project creation + first open never hits `rootfs is not mounted`.
- If mount does fail, user gets a deterministic recovery path and non-silent error.

**Depends on:** provisioning/mount sequencing in project-host lifecycle.

---

### A0.3 (done) New project assigned/started before host ready

**Task:** "creating new project VERY slow; do not assign/start until host is ready"

**Done when:**

- No assignment/start attempt occurs before host has confirmed ready state.
- Explorer no longer shows early "no subscribers matching fs.project-..." race errors.

**Depends on:** host readiness signal contract and queueing logic.

---

### A0.4 (done) First terminal on new project hangs

**Task:** "terminal on new project hangs immediately"

**Done when:**

- First terminal on a newly created project opens reliably without restart.
- No transient "Restarting" spinner regression caused by duplicate start attempts.

**Depends on:** A0.2 + A0.3 (mount/readiness races).

---

### A0.5 (done) Lite codex shows false “unconfigured”

**Task:** "in lite mode chat with codex says unconfigured"

**Done when:**

- Lite always reflects actual local codex config state.
- No spurious `unconfigured` badge when codex is available.

**Depends on:** none of A0.1-A0.4 (can run in parallel).

---

## Phase Alpha1 (Auth, Security, and Host Operations)

These items lock down secure multi-user cloud behavior.

### A1.1 Port impersonate user/auth token to launchpad (+ CLI)

**Task:** "port impersonate user/auth token to launchpad (not Next.js)"

**Done when:**

- Launchpad can mint/validate user-scoped auth tokens without Next.js dependency.
- CoCalc CLI path supports the same token flow.

**Depends on:** stable host/project identity model from Alpha0.

---

### A1.2 (done) Project-host selection only allows definitely running hosts

**Task:** "project-host selection for workspace - only allow working definitely running hosts"

**Done when:**

- Selector filters invalid/offline/unknown hosts.
- Selection behavior matches runtime start constraints from A0.1.

**Depends on:** A0.1 host status semantics.

---

### A1.3 Host stop should not fail on missing project volume

**Task:** "stopping a project host shouldn't fail because some project volume doesn't exist"

**Done when:**

- Stop flow tolerates "project volume missing" as non-fatal for stop.
- Fatal errors are limited to truly safety-critical cases.

**Depends on:** none; can be implemented in parallel with A1.1.

---

### A1.4 Extensible secure project proxies

**Task:** "make project proxies easily extensible ... token must be in URL"

**Done when:**

- Proxy routes are declarative/extensible.
- Token validation is centralized and enforced for all proxy entries.
- Starting secure web services does not require ad hoc route hacks.

**Depends on:** A1.1 token plumbing.

---

### A1.5 Plus/Launchpad startup port conflict handling

**Task:** "refuse to run with clear error if ports in use or auto-find port"

**Done when:**

- Launchpad refuses startup with actionable error if fixed ports conflict.
- If `PORT` is unset, it chooses an available port deterministically.

**Depends on:** none.

---

## Phase Alpha2 (Editor/UX Stability and Agent Capability)

These are high-visibility issues for tester confidence.

### A2.1 (done) Plus/Lite drag-and-drop upload broken on remote machines

**Task:** "plus/lite drag-n-drop upload doesn't work"

**Done when:**

- Drag-drop upload works on remote-hosted plus/lite sessions.
- At least one automated test covers regression risk.

**Depends on:** none.

---

### A2.2 (done) Slate image resize crash

**Task:** "resizing image in markdown block mode crashes (`saveValue` error)"

**Done when:**

- Resize no longer throws.
- Resize persists correctly and can be undone/redone.

**Depends on:** none.

---

### A2.3 Slate quote backspace data-loss bug

**Task:** "backspace in quote deletes prior content"

**Done when:**

- Backspace behavior matches expected quote merge semantics.
- Regression tests cover both reported reproduction cases.

**Depends on:** none.

---

### A2.4 (done - basic) Agent/codex first - turns include CLI info + skill for browser use

**Task:** "codex turns have agent CLI information and skill"

**Done when:**

- Default codex session in home page includes required agent context.
- Flyout exposes an Agents tab and removes obsolete non-agent path.
- Make all AI/LLM functionality work via Codex (i.e., no 1-off copilot assistant functionality).

**Depends on:** can run independently; validate against A1 auth model for cloud mode.

#### A2.4a (started) Lite thread routing and intent injection

For lite mode, all assistant-style entry points should route into one coherent codex thread by default.

Design:

- Keep exactly one primary Navigator thread per lite workspace/session.
- Route assistant entry points into that thread as explicit intent messages.
- Reuse the active thread unless the user explicitly starts a new session.
- If a codex turn is in progress, queue a new intent and let user choose:
  - add to current turn, or
  - start new turn.
- Show every injected intent in the thread feed (no hidden side channel).

Intent envelope (minimum fields):

- `source`: notebook-error | selection | terminal | latex | explorer | manual
- `goal`: short natural-language objective
- `context`: file path(s), selection/error text, cwd, timestamp, project id
- `open_target`: optional file/tab to focus after action

Done when:

- Triggering "Help me fix this" from notebook/editor/latex opens or focuses Navigator.
- The generated intent appears in the same visible Navigator thread.
- No one-off hidden chats are created by entry points.

---

#### A2.4b (done) Floating Navigator panel UX

Provide a docked/floating presentation of the same Navigator thread component used on project-home.

Design constraints:

- Same underlying chat thread/state/component everywhere (no parallel chat implementation).
- Fast open/close toggle and keyboard shortcut.
- Resizable panel width/height; persistent size/position per browser (use localStorage).
- Support two modes:
  - docked left panel (default),
  - floating overlay panel.
- Panel can pin/unpin; unpinned auto-hides on narrow screens.
- Opening from an entry point auto-focuses input and scrolls to bottom.

Done when:

- Notebook/latex/editor users can invoke Navigator without leaving their current file context.
- Panel renders the same codex controls/config bar as project-home.
- Session/thread continuity is preserved across page navigations and refreshes.

---

### A2.5 Jupyter with no default kernel shows blank notebook

**Task:** "if no default kernel, notebook is blank"

**Done when:**

- Notebook auto-prompts kernel selection (or equivalent flow) instead of blank view.
- User can recover without reload/workaround.

**Depends on:** none.

---

## Dependency Audit (Critical Path)

### Hard critical path

1. **A0.2 + A0.3** (mount/readiness correctness)
2. **A0.4** (terminal first-open hang)
3. **A0.1** (frontend lifecycle gating)
4. **A1.1** (token/auth flow into launchpad+CLI)
5. **A1.4** (secure proxy extensibility)

Without these, alpha testers will hit immediate operational failures in cloud workflows.

### Medium dependencies

- **A1.2** depends on status semantics from **A0.1**.
- **A2.4** should validate against **A1.1** in cloud contexts.

### Parallelizable workstreams

- Stream S1 (Launchpad lifecycle): A0.1, A0.2, A0.3, A0.4
- Stream S2 (Auth/proxy): A1.1, A1.4
- Stream S3 (Host operations): A1.3, A1.5, A1.2
- Stream S4 (Editor/Jupyter/lite UX): A0.5, A2.1, A2.2, A2.3, A2.5, A2.4

---

## Suggested Execution Order

1. Finish **Alpha0** fully before broad external testing.
2. Start **A1.1** in parallel with late Alpha0 since it is a long-pole item.
3. Complete remaining **Alpha1**.
4. Use **Alpha2** as stabilization before widening tester cohort.

---

## Exit Criteria for First External Alpha

Ship to external alpha testers only when:

- Alpha0 complete,
- A1.1 + A1.4 complete,
- no known data-loss bugs remain in editor path (A2.2/A2.3),
- upload and notebook baseline usability are functional (A2.1/A2.5).

# Details

## Codex chat integration planning

### P2. (done) Expose CoCalc CLI + browser control to Codex turns (before P3)

Principle: deliver one secure runtime contract that lets Codex call `cocalc` via `cocalc-cli` during turns, then reuse that for all assistant migrations.

#### P2.1 Turn context contract (frontend -> ACP)

Add browser/session targeting fields to ACP turn metadata so backend can issue scoped credentials and deterministic CLI defaults.

Fields to include in turn context:

- `browser_id` (current browser session id)
- `project_id` (already present)
- `account_id` (already present in ACP request)

Done when:

- Every Codex turn from chat/navigator includes `browser_id`.
- Backend can reliably identify the initiating browser session.

---

#### P2.2 Codex turn environment contract (backend -> codex subprocess)

For each turn, inject env vars that make CLI/browser automation immediately usable:

- `COCALC_API_URL`
- `COCALC_BEARER_TOKEN` (short-lived, scoped)
- `COCALC_ACCOUNT_ID`
- `COCALC_PROJECT_ID`
- `COCALC_BROWSER_ID`
- `COCALC_CLI_BIN` (optional explicit binary path)

Done when:

- A Codex turn can run `cocalc browser session list` and `cocalc browser exec ...` with no extra auth/login setup.
- Tokens are per-turn/per-scope and expire.

---

#### P2.3 Auth/scoping policy for agent-issued credentials

Use least privilege by default:

- browser automation scope (read/write browser session state)
- workspace/project scope (only selected workspace unless explicitly escalated)
- explicit TTL (short-lived bearer)

Lite mode:

- Reuse existing agent token path and connection-info mechanics.

Launchpad mode:

- Mint scoped bearer via server/project-host auth path tied to account+project+browser context.

Done when:

- Agent token cannot be reused for unrelated account/workspace operations.
- Revocation/expiry behavior is deterministic and logged.

---

#### P2.4 Make `cocalc` CLI available in Codex runtimes

Launchpad project-host codex runtime:

- Ensure `cocalc` (or `cocalc-cli`) is present in PATH inside codex execution container.
- Keep version aligned with server release.

CoCalc-plus:

- Bundle CLI into plus SEA distribution and expose:
  - `cocalc-plus cli ...`
- Ensure Codex subprocess PATH includes plus binary location.

Done when:

- In launchpad and plus, Codex can execute CLI commands without install steps.
- `--version` and `browser exec-api` work inside turn runtime.

---

#### P2.5 Agent skill packaging for CLI/browser workflows

Ship a first-party skill available to Codex sessions that includes:

- command cookbook for common browser tasks
- safe patterns (`exec-api` inspect first, then `browser exec`)
- fallback behavior when multiple browser sessions are active
- examples for open/close tabs, summarize active workspace, apply small edits

Done when:

- Codex uses skill-guided commands in traces for browser tasks.
- Prompt size remains small (skill file/tooling, not giant inline system prompt).

---

#### P2.6 Vertical-slice rollout (required ordering)

1. Lite-only end-to-end slice:
   - inject env + browser id + CLI path + skill
   - verify with local `/home/wstein/bin/cocalc-cli`
2. Launchpad slice:
   - scoped bearer minting + container PATH wiring
3. Plus slice:
   - `cocalc-plus cli` in SEA + PATH wiring

Done when:

- Same prompt succeeds across lite, launchpad, plus with only runtime-specific auth differences.

---

#### P2.7 Acceptance tests

Manual acceptance prompts:

1. "List my open tabs and close non-chat tabs."
2. "Open README.md and summarize it."
3. "Sort open file tabs by on-disk mtime."

Operational checks:

- each action appears in agent trace
- token scope/expiry enforced
- cancellation works for long `browser exec` jobs

Done when:

- The three prompts run successfully in lite and launchpad.
- Failure modes are actionable (no silent no-op behavior).

---

### P3. Migrate all existing assistant/LLM paths to Codex + agent framework

P3 starts only after P2 is stable, since migrated entry points must rely on the same agent runtime contract.

#### P3.1 Inventory and classify all entry points

Create a complete list of assistant invocations across frontend (notebook, editor, latex, terminals, etc.), grouped by:

- intent type (explain/fix/edit/run/summarize)
- context requirements
- required permissions

Done when:

- Every current assistant trigger is mapped to a codex intent adapter.

##### P3.1a Inventory snapshot (2026-02-25)

The table below is the current inventory of production assistant/LLM entry points in `src/packages/frontend`, classified by intent, required context, and permission profile.

| Entry point | Current code path | Intent type | Context requirements | Permission profile | Target Codex adapter |
| --- | --- | --- | --- | --- | --- |
| Editor title bar "AI Assistant" command (code/markdown/latex/rmd/qmd/csv/html/slides/jupyter/task/terminal/chat/whiteboard) | `frame-editors/frame-tree/commands/generic-commands.tsx` -> `frame-editors/llm/llm-assistant-button.tsx` -> `frame-editors/llm/create-chat.ts` | explain/fix/review/edit | active file path, language, selected scope (selection/cell/page/all), terminal/editor type | read file context + write chat thread | `intent:editor-assistant` (terminal path specialized as `intent:terminal-assistant`) |
| Help Me Fix button family (formatter, latex errors/gutters, Rmd/Qmd build logs, Jupyter error panel) | `frame-editors/llm/help-me-fix.tsx`, `frame-editors/llm/help-me-fix-utils.ts`, consumers in `frame-editors/...` and `jupyter/llm/error.tsx` | fix-error | error text, optional line, truncated source context, language/file metadata | read file/error context + write chat thread | `intent:error-fix` |
| Jupyter "Fix with Agent" (new route) | `jupyter/llm/error.tsx` -> `project/new/navigator-intents.ts` -> `project/new/navigator-shell.tsx` | fix-error | traceback, cell input, notebook path | read notebook context + write navigator thread | `intent:notebook-error` (already routed) |
| Jupyter per-cell AI tool (Ask/Explain/Bugfix/Modify/Improve/Document/Translate/Proofread/Formulize/Translate text) | `jupyter/llm/cell-tool.tsx` | explain/fix/edit/translate/document | current cell input, optional output, optional surrounding cells, kernel/language | read notebook context + write chat thread | `intent:jupyter-cell-assistant` |
| Jupyter "Generate cell using AI" | `jupyter/insert-cell/ai-cell-generator.tsx` | generate/edit | user prompt, insertion position, neighboring cells, kernel/language | read notebook + write notebook cells | `intent:jupyter-generate-cell` |
| "AI Generate Document" modal/button (home page, +New, title bar) | `project/page/home-page/ai-generate-document.tsx` (+ call sites in `project/new/*`, `frame-editors/frame-tree/title-bar.tsx`) | generate-document | prompt, target extension, optional page size/kernel | write new file/notebook + open tab (+ optional run/build follow-up) | `intent:document-generate` |
| AI formula generator (CodeMirror + Slate integration) | `codemirror/extensions/ai-formula.tsx`, `codemirror/extensions/edit-selection.ts`, `editors/slate/format/insert-ai-formula.ts` | generate-formula/edit | selected text or free-form formula prompt, mode (`tex`/`md`) | write current editor selection | `intent:formula-generate` |
| Chat "Summarize thread" action | `chat/llm-msg-summarize.tsx` -> `chat/actions.ts::summarizeThread` | summarize | thread message history, participant names | read thread + write chat message | `intent:chat-summarize` |
| Chat "Regenerate" action | `chat/llm-msg-regenerate.tsx` -> `chat/actions.ts::regenerateLLMResponse` -> `chat/actions/llm.ts` | regenerate/edit | target message + ancestor thread history | write assistant reply in thread | `intent:chat-regenerate` |
| Chat @mentions / model-driven turns (`@chatgpt`, `@codex`, thread model) | `chat/actions/llm.ts`, `chat/actions.ts` | ask/explain/fix/edit (free-form) | chat thread history, mention/model selector | write chat reply (Codex path may execute tools based on session mode) | `intent:chat-turn` |
| Hosts "AI Assist" recommendations | `hosts/components/host-ai-assist.tsx` -> `hosts/hooks/use-host-ai.ts` | recommend/plan | host catalog summary, budget, preferred region group | no filesystem write; can apply recommendations to host form state | `intent:host-recommendation` |

##### P3.1b Grouped classification

1. Chat-injection intents (no immediate file mutation): `intent:editor-assistant`, `intent:terminal-assistant`, `intent:error-fix`, `intent:jupyter-cell-assistant`, `intent:chat-summarize`, `intent:chat-regenerate`, `intent:chat-turn`, `intent:notebook-error`.
2. Content-generation intents with direct edits/writes: `intent:jupyter-generate-cell`, `intent:document-generate`, `intent:formula-generate`.
3. Product-planning/recommendation intents: `intent:host-recommendation`.

##### P3.1c Out of scope for P3 migration (keep as tooling)

These call LLM APIs but are not user-facing assistant workflows and should not block P3:

- Account custom-LLM "Test" UI: `account/user-defined-llm.tsx`
- Admin LLM test panel: `admin/llm/admin-llm-test.tsx`

##### P3.1d Completion checklist

- [x] Enumerate frontend assistant/LLM entry points.
- [x] Classify each by intent, context, and permissions.
- [x] Assign a target Codex intent adapter for each trigger.
- [ ] Implement adapters and route all triggers through Navigator/Codex (P3.2).

---

#### P3.2 Route all entry points into coherent Navigator/Codex thread model

Objective:

- Route every assistant trigger through one visible Navigator/Codex timeline.
- Replace one-off LLM calls with intent-driven agent turns.
- Enforce product rule: user should not need to copy/paste AI output back into documents.

##### P3.2a Intent router contract

All migrated entry points call one frontend router (existing foundation: `navigator-intents.ts`):

- `dispatchNavigatorPromptIntent({ prompt, tag, forceCodex })`

Extend the payload into an explicit intent envelope (serialized into prompt + metadata):

- `source`: editor-assistant | help-me-fix | jupyter-cell | jupyter-generate | doc-generate | formula | chat-summarize | chat-regenerate | host-recommendation
- `intent`: `intent:*` adapter id from P3.1
- `goal`: concise natural-language objective
- `context`: file path(s), selection, errors, notebook cell id/range, kernel, cwd, target language/model, etc.
- `open_target`: optional UI target to focus after edits
- `permissions_hint`: read-only | workspace-write | needs-approval
- `mutation_mode`: none | in-place-edit | create-file | run-command

Done when:

- Every migrated trigger emits this envelope through the same router.

##### P3.2b Execution semantics (single thread, agent-first)

1. Thread model

- Always target the visible Navigator thread (project-scoped).
- No hidden side threads for assistant-originated actions.
- If a turn is active: queue by default, with explicit immediate-send override.

2. No copy/paste rule

- Successful intents should apply edits directly when safe.
- Agent responses should include what changed and where, not just prose.

3. Preflight consistency

- Before dispatch, attempt to save dirty source documents (best-effort).
- Include document identity + timestamp/hash hints in context for conflict awareness.

4. Apply path preference

- Prefer browser/RTC-aware edits (via CoCalc CLI browser exec) when target docs are open.
- Fallback to workspace file edits + open/focus target file if RTC route is unavailable.
- Avoid silent divergence between on-disk and in-memory state.

5. Safety + audit

- Approval gate for destructive actions or package/system mutations when policy requires it.
- Timetravel remains primary undo mechanism.
- Non-blocking follow-up: add explicit agent-authored markers in timetravel history.

Done when:

- Users can follow assistant-originated actions in one shared timeline, and edits are applied directly in most successful runs.

##### P3.2c Migration order (highest impact first)

1. Wave 1: Help Me Fix family (`intent:error-fix`, `intent:notebook-error`)

- Replace all `HelpMeFix` one-shot sends with Navigator intent routing.
- Keep existing buttons/placement initially; change backend behavior first.

2. Wave 2: Editor/Jupyter assistant surfaces (`intent:editor-assistant`, `intent:jupyter-cell-assistant`)

- Route title-bar Assistant and Jupyter cell tool into intent router.
- Preserve UX affordances while removing direct one-shot LLM path.

3. Wave 3: Generation flows (`intent:jupyter-generate-cell`, `intent:document-generate`, `intent:formula-generate`)

- Keep preview UX where useful, but execution/apply goes through agent route.
- Ensure generated output can be directly inserted/applied without copy/paste.

4. Wave 4: Chat/host special intents (`intent:chat-summarize`, `intent:chat-regenerate`, `intent:host-recommendation`)

- Move remaining special flows to adapters or keep explicitly scoped exceptions with rationale.

Done when:

- Waves 1-3 are fully routed; wave 4 is either routed or explicitly documented as intentionally separate.

##### P3.2d Acceptance criteria

Manual acceptance checks:

1. Trigger Help Me Fix from notebook/latex/rmd/qmd/formatter and verify:

- intent appears in Navigator thread,
- agent proposes/applies fix,
- no manual copy/paste needed for standard fix flow.

2. Trigger editor Assistant and Jupyter cell tool:

- both route into same Navigator timeline,
- active-turn queue/immediate behavior is correct.

3. Trigger document/cell/formula generation:

- generated result can be applied directly,
- target doc/tab focuses correctly,
- undo via timetravel works.

Done when:

- Users can follow all migrated assistant actions in a coherent timeline with direct-apply behavior.

---

#### P3.3 Remove legacy assistant code paths

- Delete obsolete UI/actions once codex adapters reach parity.
- Keep only Codex-first pathways for alpha.

Done when:

- No remaining production assistant path bypasses Codex.
- Docs and UI labels reflect the Codex-only model.

---

### P2/P3 dependency summary

Hard dependency:

- P3 depends on P2 runtime contract (env/auth/CLI/skill) being available and reliable.

Execution:

1. P2 complete (Lite -> Launchpad -> Plus)
2. P3 migration by entry-point priority (highest traffic first)