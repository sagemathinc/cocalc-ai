# CoCalc Agent-First UI RFC (Codex-First)

Status: Draft (reset)
Owner: CoCalc team
Date: 2026-02-17

## 1. Executive Summary

CoCalc should become an agent-first collaborative platform by making one runtime path dominant:

- Codex session runtime (existing, robust, persistent)
- chat-thread-backed state (existing)
- typed CoCalc capability surface (evolving)

The immediate product strategy is:

1. Reuse existing chat/Codex infrastructure everywhere possible.
2. Replace one-off LLM UI features with agent intents routed into Codex sessions.
3. Make sessions first-class in the workspace UI (global, contextual, and flyout).
4. Optimize for subscription-backed usage economics by prioritizing Codex-only flows.

## 2. Why This Reset

We already have a production-usable Codex/chat integration with long-running turn robustness, refresh resilience, and practical UX. Building a second parallel agent harness would slow delivery and reduce reliability.

The right move is to standardize on the existing substrate and expand it.

Relevant current code:

- [src/packages/frontend/chat/chatroom.tsx](./src/packages/frontend/chat/chatroom.tsx)
- [src/packages/frontend/chat/actions.ts](./src/packages/frontend/chat/actions.ts)
- [src/packages/frontend/chat/register.ts](./src/packages/frontend/chat/register.ts)
- [src/packages/frontend/project/new/navigator-shell.tsx](./src/packages/frontend/project/new/navigator-shell.tsx)
- [src/packages/frontend/project/page/home-page/index.tsx](./src/packages/frontend/project/page/home-page/index.tsx)

## 3. Core Assumptions (Feb 2026)

1. Subscription-backed access is critical for adoption and unit economics.
2. For SDK-integrated workflows, Codex is the practical subscription-backed path.
3. Metered API-key-only flows should be fallback, not primary UX.
4. In launchpad mode, sandboxing and snapshots enable stronger default execution permissions.
5. In lite mode, mode controls and approvals remain more important.

## 4. Product Principles

1. One session system across all surfaces.
2. One execution runtime for agent tasks (Codex).
3. One policy layer for approvals and auditing.
4. Context-aware entrypoints, not duplicate implementations.
5. Replace special-case LLM helpers with general agent intents over time.

## 5. Goal and Non-Goals

### 5.1 Goal

Make CoCalc feel like an environment where users ask for outcomes, and agents execute them safely with persistent context.

### 5.2 Non-Goals (v1)

- Multi-provider model orchestration in core agent UX.
- Fully autonomous background agents without user-visible policy controls.
- Immediate replacement of every legacy helper in one release.

## 6. Agent Session as First-Class Primitive

Define:

- agent session = Codex session = chat thread-backed execution context

A session has:

- identity
- scope
- runtime mode
- working directory policy
- provenance (how started)
- lifecycle (active, archived)

## 7. UI Surfaces

### 7.1 Global Navigator

A globally available session UI, decoupled from user-created `.chat` files, but still backed by a hidden chat file.

Current anchor:

- [src/packages/frontend/project/new/navigator-shell.tsx](./src/packages/frontend/project/new/navigator-shell.tsx)

### 7.2 Contextual Agent Entry

From notebook/editor/error states, entrypoints should start or resume a session with pre-filled context and intent.

Examples:

- "Fix this notebook error"
- "Explain this traceback"
- "Refactor this function"

### 7.3 Agents Flyout

Add an "Agents" flyout listing recent sessions for this workspace/user, with status and resume actions.

Use existing flyout patterns in:

- [src/packages/frontend/project/page/flyouts](./src/packages/frontend/project/page/flyouts)

## 8. Session Backing Storage

Use two layers:

1. Chat file: authoritative conversation + detailed trace rendering.
2. AKV index: lightweight session metadata for fast listing/filtering and cross-surface discovery.

AKV reference:

- [src/packages/conat/sync/akv.ts](./src/packages/conat/sync/akv.ts)

### 8.1 Chat Backing Path Policy

- Lite: single navigator file per user runtime.
- Launchpad/project: per-user navigator file in project home.

Path must be absolute and directory-created before opening sync.

### 8.2 AKV Metadata Schema (v1)

Store one row per session key plus optional event keys.

Session record fields:

- `session_id`
- `project_id`
- `account_id`
- `chat_path`
- `thread_key`
- `title`
- `created_at`
- `updated_at`
- `status` (`active|idle|running|archived|failed`)
- `entrypoint` (`global|file|notebook|error-button|command-palette|api`)
- `working_directory`
- `mode` (`read-only|workspace-write|full-access`)
- `model`
- `reasoning`
- `last_error`

Suggested key shape:

- `agent/session/<account_id>/<project_id>/<session_id>`

Optional append-only event keys:

- `agent/event/<account_id>/<project_id>/<session_id>/<timestamp>`

Use `sqlite(...)` queries on AKV stream for efficient flyout list operations.

(COMMENT: there's basically one thing to do which is "get all data" -- it'll send it all in a single MsgPack chunk efficiently; that should be fine for this application since it's not much data.  You can also get updates on change.  The dkv.ts thing right next to akv.ts automates all this.)

## 9. Working Directory Policy

Default resolution:

1. If file is inside a git repo: repo root.
2. Else if file is under HOME: HOME.
3. Else: containing directory.

Rules:

- Always visible in UI.
- User can override per session.
- Override persists with session metadata.

(COMMENT: I think we had trouble implementing setting a different workspace root after starting the session so right now changing the working directory is disabled. But we should just assume we'll be able to figure this out somehow, e.g,. worse case, we can make a new session and copy the context from the old session.)

## 10. Safety and Execution Policy

### 10.1 Launchpad

Default mode target: `full-access` in sandbox.

Rationale:

- stronger isolation
- upcoming btrfs snapshot-before/after-turn model

### 10.2 Lite

Default mode target: conservative (`read-only` or `workspace-write`), with escalation prompts.

### 10.3 Approvals

Keep explicit approvals for:

- destructive operations
- dependency/install actions
- credential-sensitive actions
- cross-project/account mutations

## 11. Replace Legacy LLM Features with Agent Intents

Inventory and migrate existing LLM touchpoints under one intent adapter layer.

Scope to survey:

- mention flows and assistants across editors
- notebook helper buttons
- context-specific explain/fix UIs

Intent adapter contract:

- `intent_type`
- `context_collectors`
- `preflight_actions`
- `prompt_template`
- `mode_hint`
- `working_dir_hint`

Example notebook-error intent:

1. Save notebook.
2. Capture traceback/cell context.
3. Start or reuse agent session.
4. Ask agent to reproduce and fix.
5. If install/upgrade needed, request user approval.

(COMMENT: we should remember to add to the UI that users _can_ paste images in and the AI will see them. That's something we never had before.  E.g., for latex user can draw a diagram and ask for a tikz to be added to a file.) 

## 12. Reuse Strategy (Do Not Fork Runtime)

Reuse existing components and behavior where possible:

- [src/packages/frontend/chat/chatroom.tsx](./src/packages/frontend/chat/chatroom.tsx)
- [src/packages/frontend/chat/side-chat.tsx](./src/packages/frontend/chat/side-chat.tsx)
- [src/packages/frontend/chat/chatroom-layout.tsx](./src/packages/frontend/chat/chatroom-layout.tsx)
- [src/packages/frontend/chat/codex.tsx](./src/packages/frontend/chat/codex.tsx)
- [src/packages/frontend/chat/acp-api.ts](./src/packages/frontend/chat/acp-api.ts)

Do not create a second planner/executor stack for navigator.

## 13. UX Plan

### 13.1 Baseline

- Project home includes global navigator session view.
- `+New` no longer hosts navigator.
  - Right now "+new" does have a "Create with AI" input form; this will be replaced by an agent, with the context telling it that you want to create a file.  You'll type a sentence to describe what you want.  The agent may scan the current directory, look at installed software, install software, etc., etc., in the course of making your new file.  So this isn't the navigator, but will be an agent UI point.
- Session always opens at most recent thread and scrolls bottom.
  - (NOTE: there's a bug where often chats scroll to the top when you hide/show them, which is annoying.  We'll fix this. Basically our chatlog scroll preservation code has a bug.)

### 13.2 Next UX Additions

- session header with:  (NOTE: we have most of this already)
  - model/reasoning/mode badges
  - working directory display
  - clear/new/archive/open-thread actions
- rich trace panel toggle for advanced users
- "handoff to workspace agent" action

### 13.3 Agents Flyout

- show recent sessions with status and updated time
- one-click resume
- archive/unarchive
- filter by entrypoint and mode

## 14. Collaboration Model

Near-term:

- sessions are user-scoped by default

Future:

- opt-in shared sessions per workspace
- explicit ownership and visibility controls
- immutable audit trail for shared sessions

In a full chatroom (a .chat file) sessions are collaborative. That's already implemented.

Each turn is user scoped which is important for properly respecting the terms of usage of subscriptions.

## 15. Implementation Phases

### Phase 0: Inventory and Mapping

- Enumerate all current frontend LLM features.
- Classify each as `replace`, `keep temporary`, or `drop`.
- Define top 10 intents.

### Phase 1: Session Index + Agents Flyout Skeleton

- Add AKV metadata writer on session creation/update.
- Build flyout list UI backed by AKV query (actually, use DKV and get realtime updates on any change).
- Add resume/open controls.

### Phase 2: Intent Adapters (High Value)

Migrate first:

- notebook error help  (this is by far the most popular feature)
- explain/fix current file
- dependency/install assistance

### Phase 3: Context Entry Standardization

- command palette agent entry
- editor toolbar actions
- notebook output/error action hooks

### Phase 4: Legacy LLM UI Decommission

- progressively route remaining one-off helpers to intents
- keep temporary compatibility flags

### Phase 5: Launchpad Safety Tightening

- snapshot-integrated approval UX
- post-turn diff and rollback affordances
- decision about how many snapshots to retain

## 16. Metrics

Primary:

- task success rate
- time-to-first-useful-action
- median time-to-resolution for notebook errors
- percentage of legacy LLM interactions replaced by session-based agent intents

Operational:

- approval prompt frequency and acceptance rate
- failure categories (tooling, policy, runtime)
- session resume rate

Economic:

- subscription-backed turn ratio
- metered-key fallback ratio

## 17. Risks and Mitigations

Risk: inconsistent behavior across entrypoints.

- Mitigation: route all entrypoints through intent adapter + same session runtime.

Risk: AKV metadata drift from chat truth.

- Mitigation: periodic reconcile job and lightweight repair on session open.

Risk: excessive complexity in UI.

- Mitigation: default simple view, advanced trace behind toggle.

Risk: permission confusion in lite vs launchpad.

- Mitigation: explicit mode badges + clear escalation prompts.

## 18. Immediate Next Tasks

1. Implement DKV session index writer/reader module under frontend AI/chat integration layer.
2. Add "Agents" flyout panel shell with recent-session list.
3. Define first three intent adapters with notebook/file context collectors.
4. Wire one notebook error button to intent adapter path.
5. Add session header controls (new/archive/open-thread).

## 19. Open Questions

1. Should archived sessions stay in same backing chat file or rotate to archive file sets?  (ANS: cocalc seems to do fine even with 1000's of messages in a single file... but 10K would probably start to be too much.  But imagine a project that's been in heavy use for a year: definitely the file contents should get rotated out.  That could be done in a generic way that works for any .chat file, e.g., if the file is foo.chat, then periodically old messages get rotated out to another file, e.g., .foo.0.chat, .foo.1.chat, etc., and in the chat UI at the top of each thread with rotated out messages, there is a link to open .foo.0.chat, etc.   The old messages are also still in TimeTravel history.    Basically the answer is in the longrun not everything can be stored forever in one .chat file... but I don't know the best strategy.   It _is_ really nice and transparent that chat history is just a jsonl file though.)
2. How aggressive should auto-reuse be versus creating new sessions for contextual actions?  (ANS: I think this is somewhat hard to answer without using it a lot.  My feeling so far is that codex is amazingly good at autocompaction and handling context. Amazing.  So this might be something where the default is very often to use an existing session, but the user can explicitly request a new one.   I feel like the context built up over weeks of usage of a single session is itself **very valuable**. It's almost like training a student or employee. It's important to allow various customization so users can keep track of these: editing the title, color, icon, custom image file -- we have most of this already for chat threads).
3. What is the default retention policy for session metadata and traces in lite mode?  (ANS: traces are stored in an AKV and it might have a ttl.  I don't know.  It seems like this should be something users can customize in account/project settings.)
4. Which collaboration model should be first for shared sessions in launchpad?  (ANS: I think it already exists in chatrooms - each turn is initiated by a specific user. ??)

## 20. Decision

Proceed with Codex-first, session-first architecture using chat runtime reuse and AKV metadata indexing. Replace one-off LLM helpers incrementally via intent adapters.