# CoCalc UI Agent RFC (Navigator + Builder)

Status: Draft
Owner: CoCalc team
Date: 2026-02-06

## 1. Problem

CoCalc already supports powerful coding-agent workflows in `.chat` threads (e.g., Codex sessions), but there is still too much friction between "I want to do something in CoCalc" and "the agent is now helping me do it".

We need an agent-first product surface where:

- users immediately discover agent capabilities
- common CoCalc tasks are fast and reliable
- complex/long-running coding work escalates naturally to a coding agent thread
- the model works in both `cocalc-plus` and `launchpad/rocket`

## 2. Product Goals

- Users can use natural language for common CoCalc actions from anywhere.
- Agent can perform meaningful UI/control-plane tasks with high reliability.
- Agent can escalate to deep coding work without losing context.
- System remains safe, auditable, and policy-driven in multiuser mode.
- Billing model supports "users pay OpenAI; users pay CoCalc for software".

## 3. Non-Goals

- No fully autonomous background agent that can mutate arbitrary state without policy checks.
- No first-pass support for many different agent providers in the UI.
- No requirement to solve every install/build workflow in v1.

## 4. Proposal: Two-Tier Agent Model

### 4.1 Navigator Agent (UI/control-plane)

Primary role:

- handle short CoCalc operations
- navigate/open/set/configure
- perform scoped actions through typed tools
- ask for confirmation for side effects

Examples:

- Open last five files.
- Set workspace color to orange.
- Add quick launcher entry for `rmd`.
- Launch JupyterLab server.
- Add collaborator to a workspace.

### 4.2 Builder Agent (coding/deep execution)

Primary role:

- code edits, shell workflows, repo operations, debugging
- long multi-turn tasks with real execution context

Examples:

- clone/build/install workflows
- notebook/script generation plus dependency setup
- grading pipelines and rubric automation

### 4.3 Handoff Rule

Navigator should hand off to Builder when:

- task requires multi-file code edits or shell-heavy work
- task duration exceeds short-action budget
- user requests deep implementation explicitly

Handoff must preserve:

- user intent summary
- relevant object ids (workspace/project/file/thread)
- permission context and pending approvals

## 5. Runtime Architecture

Single logical architecture, different runtime constraints.

### 5.1 Shared layers

- Agent UI surface
- Orchestrator/router
- Tool gateway
- Policy/approval engine
- Thread/task store with audit log

### 5.2 cocalc-plus

- Runtime local to user machine/session.
- Default trust posture similar to JupyterLab/VS Code.
- Still enforce action checkpoints for destructive operations.

### 5.3 launchpad/rocket

- Per-user isolated runtime (podman/vm scoped).
- Strict capability boundary between control-plane and workspace runtime.
- Short-lived credentials, explicit approvals, complete audit trail.

## 6. UI Entry Points

Make the agent obvious and continuously available.

- Global top-bar entry: "Ask CoCalc".
- Command palette (`Cmd/Ctrl+K`) with NL task input.
- Launcher card in `+New`: "Describe what you want to do".
- Existing `.chat` for deep sessions remains first-class.
- Contextual empty-state prompts (files/projects/settings).

## 7. Task and Thread Model

Unify quick actions and long sessions under one task abstraction.

- Quick action task:
  - small panel
  - action preview
  - short log
- Escalated thread task:
  - full `.chat`/agent session
  - resumable and shareable
- Searchable history:
  - by workspace/project/user
  - by object ids and action type

## 8. Capability and Action Model

Use typed actions with policy checks.

### 8.1 Core action shape

- `action_type`
- `target`
- `args`
- `risk_level`
- `requires_confirmation`
- `idempotency_key`
- `audit_context`

### 8.2 Categories

- Read-only inspect/search/list
- UI/navigation state changes
- Workspace/project metadata updates
- collaborator/access changes
- file/server operations
- shell/install operations (Builder domain)

### 8.3 Policy defaults

- Read-only actions: auto-allow.
- Non-destructive writes: allow with logging.
- Destructive/billing/network/install/collaborator changes: explicit confirm.

## 9. Billing and Authentication Model

Target model:

- Users pay OpenAI for model usage.
- Users pay CoCalc for software/platform value.

Practical model options:

- Primary: user signs in and authorizes OpenAI-backed usage path.
- Fallback A: BYO API key.
- Fallback B: site/org-managed key.
- Fallback C: limited free tier or read-only assistant.

Product requirement:

- clear per-task usage visibility
- no surprising hidden spend paths

## 10. Why Coding-Agent Navigator (with constraints)

### Pros

- Composable and general, fewer one-off tools required.
- Can solve long-tail workflows by writing/running small code via SDK.
- Better leverage of coding-agent capabilities users already value.

### Cons

- Latency can be higher.
- More safety risk without strict execution policy.
- Less deterministic for simple tasks if used for everything.

### Decision

Use a hybrid:

- fast-path deterministic tool routing for common intents
- coding-agent fallback for complex intents
- policy engine executes side effects, not raw model output

## 11. Detailed Implementation Plan

This plan is architecture-first and API-surface-first. The key idea is to avoid hand-writing dozens of brittle one-off adapters and instead expose a typed, policy-gated CoCalc control plane that a coding agent can compose.

### 11.1 Package and Ownership

Primary location:

- `@cocalc/ai/agent-sdk` (recommended)

Concrete path options:

- [src/packages/ai/agent-sdk](./src/packages/ai/agent-sdk) in the existing `@cocalc/ai` module
- or a dedicated package if boundaries become cleaner later

Rationale:

- keeps agent-specific contracts near other AI features
- makes SDK discoverable for both Navigator and Builder integration
- avoids scattering action definitions across frontend-only code

### 11.2 Source-of-Truth API Surfaces

SDK capabilities should be generated/derived from these surfaces first:

- [src/packages/conat/hub/api](./src/packages/conat/hub/api)
- [src/packages/conat/project/api](./src/packages/conat/project/api)
- [src/packages/frontend/project_actions.ts](./src/packages/frontend/project_actions.ts)
- [src/packages/frontend/frame-editors](./src/packages/frontend/frame-editors)

Design rule:

- if a user can do it in CoCalc, it should either be directly represented in the SDK or intentionally excluded with a documented reason.

### 11.3 Control Plane Contract (what the model executes)

Define a single action envelope:

- `action_type`
- `target`
- `args`
- `risk_level`
- `requires_confirmation`
- `idempotency_key`
- `audit_context`

Define deterministic task states:

- `created -> planned -> awaiting_confirmation -> running -> completed|failed|cancelled`

Define risk classes:

- `read`, `write`, `destructive`, `access`, `billing`, `network`, `install`

### 11.4 Metadata-Driven Capability Registry

Build a registry generator that outputs:

- `CapabilityDescriptor[]` (typed)
- machine-readable JSON manifest for planner grounding
- docs pages for humans

Each descriptor includes:

- name, namespace, summary
- argument schema (zod/json-schema)
- preconditions (e.g., requires active file/editor)
- side-effect scope (UI-only, project, account, system)
- undo availability
- launchpad safety notes and required capability token scopes

### 11.5 Adapter Strategy: thin wrappers, not bespoke workflows

Implement adapters as thin typed wrappers over existing APIs:

- `hub.*` wrappers over `conat/hub/api`
- `project.*` wrappers over `conat/project/api`
- `ui.*` wrappers over frontend action surfaces
- `editor.*` wrappers by editor domain (chat, whiteboard, notebook, etc.)

Do not encode business workflows in adapters. Workflows stay in planner scripts that compose these primitives.

### 11.6 Planner Architecture (hybrid)

Two routing paths:

- Fast path:
  - deterministic mapping for common intents
  - low latency and predictable UX
- Coding path:
  - coding agent writes/executes small TS/JS plans against `agent-sdk`
  - mandatory execution through policy executor (no raw side effects)

Handoff to Builder/Codex thread when:

- task is long-running, shell-heavy, or deep coding
- user requests implementation work explicitly

### 11.7 Policy and Execution Kernel

Build a runtime executor that:

- validates actions against schemas
- checks policy + capability token scope
- requests confirmations when needed
- executes and logs every action with correlation id
- supports dry-run/preview mode

This is the hard safety boundary:

- models can propose plans
- only executor can mutate state

### 11.8 UX for Low-Typing and Accessibility-First Use

Required surfaces:

- global "Ask CoCalc" entry (always visible)
- command palette NL input
- voice input option
- task panel with:
  - readable plan preview
  - one-click confirm/deny
  - progress stream
  - undo where possible

For users who mostly click/scroll:

- support "one prompt -> many structured actions"
- keep all non-trivial actions inspectable before execution

### 11.9 Persistence, Memory, and Replay

Store task records with:

- prompt
- planned actions
- confirmations
- execution results
- object ids touched

Capabilities:

- searchable history
- "run again with small edits"
- quick recipe creation from successful runs

### 11.10 Milestones

M1: SDK foundation

- action envelope + task state machine + registry format
- generator scaffolding over hub/project surfaces

M2: End-to-end Navigator slice

- top-bar Ask CoCalc
- fast-path + executor + confirmation UI
- first meaningful cross-surface tasks

M3: Coding-path composability

- coding planner scripts against `@cocalc/ai/agent-sdk`
- handoff protocol into Builder/Codex threads

M4: Full-surface expansion

- expand registry across frontend/editor action domains
- add coverage for chat, whiteboard, notebook, launcher, collaborators

M5: Launchpad hardening

- per-user capability tokens
- strict multi-tenant policy validation
- full auditability for admin environments

### 11.11 Test Plan

- Unit tests:
  - schema validation
  - policy decisions
  - registry generation
- Integration tests:
  - adapters against test projects/workspaces
- Golden tests:
  - NL prompt -> planned action sequence
- Security tests:
  - token scope violations
  - forbidden cross-tenant attempts
- Regression tests:
  - editor/domain-specific action contracts

### 11.12 MVP Exit Criteria

MVP is complete when:

- users can reliably complete representative cross-surface tasks from prompts
- coding-path plans can compose primitives without bypassing policy
- action transparency (preview/log/replay) is good enough for trust
- launchpad mode passes isolation and audit requirements
- overall UX is meaningfully usable for low-typing workflows

### 11.13 Execution Plan V2 (Reactive Loop + Catalog + Script)

This supersedes the old "static list plan then run first action" approach.
The target runtime is an observe-act loop with retrieval-based tool grounding.

#### 11.13.1 Architecture Decisions

- Use Codex-first planning/execution in `cocalc-plus` (subscription-backed path).
- Keep execution policy-gated via SDK executor; model never mutates state directly.
- Replace full-manifest-in-context with retrieval:
  - `catalog.search(query)` for ranked action ids
  - `catalog.describe(actionType)` for exact schema/examples
- Keep full manifest available for debug/admin only, not default model context.
- Add `script.run` for branching/loops/composition, still under policy controls.
- Treat runtime location as a first-class routing dimension:
  - `browser`
  - `project`
  - `project-host`
  - `hub`

#### 11.13.2 Runtime Protocol (single turn)

Loop until done/cancel/error/max-steps:

1. observe
  - current goal
  - prior steps + observations
  - selected capability context (from catalog tools)
2. decide
  - `next_action` or `done`
3. execute
  - validate args
  - policy check
  - run action
4. observe result
  - structured observation payload
  - append to loop history

Stop conditions:

- `done`
- blocked awaiting confirmation
- hard error
- step budget exceeded

#### 11.13.3 API Changes

Add to `hub.agent.*`:

- `run`
  - starts/continues reactive loop
  - returns step stream or step batch + final status
- `catalog_search`
  - query + filters -> ranked action summaries
- `catalog_describe`
  - action type -> full schema/examples/risk/policy info

Keep existing:

- `manifest` (debug)
- `execute` (single action executor boundary)

#### 11.13.4 Catalog Model

Each action descriptor includes:

- `actionType`, namespace, summary
- arg schema (JSON schema from zod input schema)
- usage examples (at least 1 happy-path)
- risk/scope/confirmation defaults
- tags/keywords for retrieval

Catalog storage:

- in-memory index (startup built from registry)
- deterministic ranking function (keyword + namespace + risk filters)
- no LLM dependency for search

#### 11.13.5 Script Mode

New capability:

- `script.run` (TypeScript only, first version)

Execution model:

- script receives a minimal SDK object (`cc`) with approved primitives
- all side-effectful calls go through the same policy executor
- supports dry-run and confirmation checkpoints

Runtime model (required):

- `script.run` accepts an explicit runtime target:
  - `browser` for UI state work (tabs, layout, focused editor)
  - `project` for workspace file/process tasks
  - `project-host` for host-local project operations with better locality
  - `hub` for control-plane/database-local tasks
- action descriptors must declare allowed runtimes; orchestrator rejects invalid placements.

Use cases:

- conditional logic ("if exists then ... else ...")
- loops over many projects/files
- mixed operations requiring intermediate computation

#### 11.13.6 Frontend UX Plan

Navigator shell should show:

- live step timeline (`plan`, `execute`, `observe`)
- current step index and status
- confirmation pauses with resume
- final summary

Debug mode:

- full raw planner output
- chosen catalog calls (`search`, `describe`)
- per-step action envelopes

Default mode:

- concise task progress + user-safe details
- progressive disclosure:
  - collapsed by default
  - expandable details for advanced/debug users

#### 11.13.7 Implementation Phases

P1: Loop engine foundation (lite mode first)

- implement `hub.agent.run` using Codex in a step loop
- keep using existing `execute` for actual actions
- wire confirmations and resume token/state

Acceptance:

- can solve conditional prompt patterns without precomputed static plan
- blocked steps pause and can resume

P2: Catalog tools

- implement `catalog_search` and `catalog_describe`
- planner prompt updated to use catalog tools before proposing actions

Acceptance:

- no full manifest required in planner context
- rename/move args use canonical names consistently

P3: Script mode MVP

- add `script.run` action and runtime
- include policy interception and dry-run

Acceptance:

- "if/else + loop" prompts execute correctly via script mode
- all writes still audited and policy-gated

P4: UI action surface (`ui.tabs.*`) in plus mode

- `ui.tabs.list`, `ui.tabs.close`, `ui.tabs.reorder`
- bridge frontend state actions into executor-safe adapters

Acceptance:

- prompts like "close non-chat tabs" and "sort tabs by mtime" work end-to-end

P5: Launchpad adaptation

- capability token scoping
- strict tenant boundary checks
- audit hardening
- snapshot-backed policy mode for eligible filesystem mutations:
  - pre-action btrfs snapshot
  - execute
  - verify/review window
  - TTL-based snapshot cleanup
  - exclude irreversible cross-boundary actions (billing/access/network-external)

Acceptance:

- same API contract works with launchpad constraints
- security tests pass for cross-tenant denial

#### 11.13.8 Testing Plan (concrete)

- unit:
  - loop state transitions
  - catalog ranking/describe correctness
  - script policy interception
- integration (lite):
  - conditional file tasks
  - multi-step tasks with confirmation
  - recovery after interrupted run
- UI:
  - timeline renders full step sequence
  - pause/resume UX

#### 11.13.9 Immediate Build Queue

1. Add `hub.agent.run` (lite) with step-loop state.
2. Add `catalog_search` and `catalog_describe` over registry.
3. Update navigator shell to consume `run` stream and timeline.
4. Add `script.run` scaffolding and first guarded runtime.
5. Add first `ui.tabs.*` adapters in plus mode.

## 12. Success Metrics

- Time-to-first-successful-agent-task.
- % of users who use agent in first session.
- completion rate by action class.
- escalation rate (Navigator -> Builder) and success after handoff.
- user-reported trust and usefulness.

## 13. Open Questions

- Exact OpenAI auth path to align with ChatGPT subscription expectations.
- Best UI for mixed quick tasks + long threads.
- policy defaults for educational multiuser deployments.
- how much local install management to include in Navigator vs Builder.

## 14. Immediate Next Steps

- Stand up `@cocalc/ai/agent-sdk` package skeleton.
- Implement capability registry generator for hub/project APIs first.
- Define action envelope + policy executor + confirmation flow.
- Implement thin wrapper adapters (`hub`, `project`, `ui`) with strict typing.
- Add Navigator shell UI wired to plan preview and executor.
- Add coding-path planner that can script against the SDK.
- Add Builder/Codex handoff preserving full task context.
