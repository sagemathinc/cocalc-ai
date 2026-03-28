# Frontend Assistant to Codex Migration

## Status

This migration is well underway, but it is not finished.

What is now substantially done:

- Workspace assistant flows use the visible `Agents` chat surface, not the old
  floating dock.
- Workspace chat reset / clear-thread behavior exists and is scriptable.
- Jupyter `Fix with Agent` and `Generate with Agent` are routed through Codex.
- Agent popup dialogs reuse the real chat composer.
- Live notebook mutation now goes through durable backend `project jupyter`
  operations rather than browser-only mutation.
- The Jupyter + Codex flow works end-to-end on both Lite and hub/launchpad.

What is still not done:

- Several frontend assistant entrypoints still route through legacy one-shot LLM
  code.
- Old LangChain-based non-agent backend evaluation code still exists.
- Model-selection / vendor / pricing / admin UI from the old one-shot LLM world
  still exists.
- Host recommendation and terminal-assistant workflows still need proper
  Codex-first product designs.

## Goal

Replace the legacy frontend "Assistant" and one-shot LLM integrations with the
Codex/ACP agent stack, routed through visible chat or Navigator threads.

This is a frontend product migration plan, but it now explicitly includes the
backend/CLI capabilities required to make agent workflows robust:

- live document mutation through backend APIs
- durable notebook operations through `project jupyter`
- future terminal and host-management control through `cocalc-cli`

## Product Decisions

1. Assistant actions route through Codex/ACP, not legacy one-shot LLM actions.
2. Users should see one coherent timeline for assistant work, not hidden side
   effects.
3. Successful assistant actions should apply edits directly when safe. The user
   should not need to copy/paste AI output back into documents.
4. Live sync/RTC document state is the source of truth. Assistant flows should
   not depend on saving files to disk before work begins.
5. The old floating assistant surface is gone. The primary frontend target is
   the visible workspace `Agents` flyout/chat surface.
6. The initial launch is Codex-only.
7. Future support for other coding agents such as Claude Code is plausible, so
   the architecture should avoid baking OpenAI/Codex assumptions too deeply into
   frontend product concepts.

## Deletion / Retention Decisions

### Delete as product concepts

These should not be migrated one-for-one. They should be removed as distinct
frontend product ideas:

- chat summarize
- chat regenerate
- legacy one-shot `HelpMeFix` send flows
- legacy title-bar `AI Assistant` flow
- legacy one-shot formula/document-generation flows that exist only because the
  old stack could not directly edit live documents

### Replace, not merely delete

These should be replaced with Codex-first workflows backed by `cocalc-cli` and
backend APIs:

- host AI recommendation
- terminal assistant behavior

### Keep and repurpose

Do not blindly delete accounting / throttling / entitlement infrastructure.

We still need:

- usage tracking
- per-user throttling / limits
- site-admin API-key-backed usage controls
- support for users bringing their own subscription and possibly their own API
  key

What should go away is the old non-agent evaluation stack and its product/UI
 surface, not the necessary accounting and policy controls.

## Current State

The most complete historical inventory originally lived in
`src/.agents/alpha.md` under
`P3. Migrate all existing assistant/LLM paths to Codex + agent framework`.
This file is now the current execution plan.

### Already migrated enough to use as reference paths

- Notebook `Fix with Agent`:
  - `src/packages/frontend/jupyter/llm/error.tsx`
- Notebook cell generation with Agent:
  - `src/packages/frontend/jupyter/insert-cell/ai-cell-generator.tsx`
- Jupyter cell tool / Agent surface:
  - `src/packages/frontend/jupyter/llm/cell-tool.tsx`
- Shared workspace agent routing:
  - `src/packages/frontend/project/new/navigator-intents.ts`
- Popup agent composer using the real chat composer:
  - `src/packages/frontend/frame-editors/llm/popup-agent-composer.tsx`

### Still legacy

- Title-bar assistant path:
  - `src/packages/frontend/frame-editors/llm/llm-assistant-button.tsx`
  - `src/packages/frontend/frame-editors/llm/create-chat.ts`
  - title-bar wiring in `src/packages/frontend/frame-editors/frame-tree/*`
- `HelpMeFix` family:
  - `src/packages/frontend/frame-editors/llm/help-me-fix.tsx`
  - `src/packages/frontend/frame-editors/llm/help-me-fix-utils.ts`
  - file-type-specific callers in LaTeX/Rmd/Qmd/formatter flows
- AI document generation:
  - `src/packages/frontend/project/page/home-page/ai-generate-document.tsx`
- AI formula generation:
  - `src/packages/frontend/codemirror/extensions/ai-formula.tsx`
  - `src/packages/frontend/editors/slate/format/insert-ai-formula.ts`
- Host AI recommendation:
  - `src/packages/frontend/hosts/components/host-ai-assist.tsx`
  - `src/packages/frontend/hosts/hooks/use-host-ai.ts`

### Legacy backend / config stack still present

- old one-shot backend evaluation stack:
  - `src/packages/server/llm/*`
  - `src/packages/ai/llm/evaluate-lc.ts`
- old HTTP/API surfaces:
  - `src/packages/http-api/pages/api/v2/llm/*`
  - `src/packages/http-api/pages/api/v2/openai/chatgpt.ts`
- old model/provider configuration and admin UI:
  - `src/packages/util/db-schema/llm-utils.ts`
  - `src/packages/util/db-schema/site-defaults.ts`
  - `src/packages/util/db-schema/site-settings-extras.ts`
  - `src/packages/frontend/admin/llm/*`
  - frontend model-selection/account settings related to the old stack

## Inventory

| Entry point | Current code path | Current state | Target route |
| --- | --- | --- | --- |
| Editor title bar assistant | `frame-editors/frame-tree/commands/generic-commands.tsx` -> `frame-editors/llm/llm-assistant-button.tsx` -> `frame-editors/llm/create-chat.ts` | Legacy one-shot path | Replace with Codex-first launcher or remove |
| Help Me Fix family | `frame-editors/llm/help-me-fix.tsx`, `frame-editors/llm/help-me-fix-utils.ts`, file-type consumers | Legacy one-shot path | Route through shared Codex intent and direct apply |
| Notebook `Fix with Agent` | `jupyter/llm/error.tsx` | Migrated reference path | Keep |
| Jupyter cell Agent tool | `jupyter/llm/cell-tool.tsx` | Substantially migrated | Keep and refine |
| Jupyter generate cell | `jupyter/insert-cell/ai-cell-generator.tsx` | Substantially migrated | Keep and refine |
| AI Generate Document | `project/page/home-page/ai-generate-document.tsx` | Legacy one-shot path | Codex intent with direct file creation |
| AI formula generator | `codemirror/extensions/ai-formula.tsx`, `editors/slate/format/insert-ai-formula.ts` | Legacy one-shot path | Codex intent with in-place apply |
| Chat summarize/regenerate | `chat/llm-msg-summarize.tsx`, `chat/llm-msg-regenerate.tsx`, `chat/actions/llm.ts` | Old product concept | Delete |
| Host AI recommendations | `hosts/components/host-ai-assist.tsx`, `hosts/hooks/use-host-ai.ts` | Legacy one-shot path | Replace with CLI-backed Codex workflow |
| Terminal assistant | no real product path yet | Missing | Add CLI-backed Codex workflow |

## Migration Contract

Every surviving assistant trigger should emit one intent envelope through the
same frontend router.

Required fields:

- `source`
- `intent`
- `goal`
- `context`
- `open_target`
- `permissions_hint`
- `mutation_mode`

Existing foundation:

- `src/packages/frontend/project/new/navigator-intents.ts`

Target semantics:

1. Always operate on the in-memory sync version of the target document when a
   live document API exists.
2. Do not rely on filesystem state or pre-dispatch saves as the primary source
   of truth.
3. Prefer backend live-document APIs and sync-aware mutations over on-disk file
   edits.
4. For document types that do not yet have adequate live mutation APIs, add
   backend/CLI support instead of falling back to stale filesystem reads.
5. Long-running agent work must remain robust across browser refreshes or
   disconnects.
6. Queue into the visible Codex/Navigator timeline by default.
7. Return direct edits/applies for normal success paths.
8. Prefer `cocalc-cli` capability surfaces over giant handcrafted frontend
   prompts. The agent should gather additional facts itself via tools.

## New Architectural Decisions

### Hosts

The old host AI recommendation design should be replaced, not ported.

Target direction:

- make `cocalc-cli` able to inspect and manage the same host/project data that
  the hosts page uses
- let Codex gather pricing, machine availability, quotas, and relevant state by
  itself through CLI tools
- implement an approval/policy layer for high-impact actions such as starting,
  resizing, or purchasing resources

This is important to the frontend-assistant project, but it is a separate
backend/CLI capability project as well.

### Terminal

We need terminal-first Codex integration.

Target direction:

- `cocalc-cli` must be able to read recent terminal state for a specific
  terminal session
- `cocalc-cli` must be able to send input to a specific terminal session
- Codex should be able to help with interactive terminal situations, e.g.
  getting a user out of `vim`, fixing a broken shell prompt, or resuming a
  long-running process safely

This requires new terminal capabilities, not just a frontend button.

## Execution Waves

### Wave 0: Stabilize and document what is already working

Tasks:

- update this plan to reflect the current post-Jupyter state
- keep Lite and hub Jupyter Codex regressions passing
- keep the `Agents` workspace surface as the primary assistant UI

Done when:

- this file matches reality
- Jupyter agent flows remain durable on Lite and hub

### Wave 1: Remove remaining legacy frontend assistant entrypoints

Tasks:

- replace or remove the title-bar assistant path
- replace the `HelpMeFix` family with shared Codex intent routing
- replace AI document generation with direct Codex file creation
- replace AI formula generation with direct Codex in-place apply
- delete chat summarize/regenerate as product concepts

Done when:

- no production frontend assistant entrypoint depends on legacy
  `frame-editors/llm/*` one-shot send flows
- there are no user-facing chat summarize/regenerate product affordances left

### Wave 2: Add missing Codex-first capability surfaces

Tasks:

- add CLI-backed host inspection / recommendation capabilities
- add terminal read/write capabilities and a terminal Codex workflow
- define approval/policy UX for high-impact host and terminal actions

Done when:

- host recommendations are tool-driven and Codex-first
- terminal help is possible through explicit terminal session tooling

### Wave 3: Delete the old non-agent LLM stack

Tasks:

- remove old frontend model-selection UI that only exists for one-shot LLM use
- remove old backend LangChain evaluation stack
- remove obsolete `/api/v2/llm/*` and related one-shot APIs
- remove obsolete vendor/model configuration that no longer applies
- preserve and repurpose only accounting / throttling / entitlement logic that
  Codex/ACP still needs

Done when:

- there is no production one-shot LangChain/browser-orchestrated assistant path
  left in the product
- remaining billing/usage logic is clearly about agent usage, not generic model
  selection

## Concrete Checklist

### Frontend assistant migration

- [x] Remove the floating assistant dock as a primary product surface.
- [x] Make workspace `Agents` the primary assistant surface.
- [x] Migrate Jupyter notebook repair to Codex-backed live notebook actions.
- [x] Migrate Jupyter generate-cell flow to Codex-backed live notebook actions.
- [x] Reuse the real chat composer in popup agent dialogs.
- [ ] Replace the title-bar assistant path.
- [ ] Delete/replace `HelpMeFix` callers.
- [ ] Replace AI document generation.
- [ ] Replace AI formula generation.
- [ ] Delete chat summarize/regenerate.

### Backend / CLI capability work

- [x] Add durable backend notebook mutation through `project jupyter`.
- [x] Add `project jupyter exec` for multi-step notebook work.
- [x] Make Jupyter Codex flows work on Lite.
- [x] Make Jupyter Codex flows work on hub/launchpad.
- [ ] Add host-management CLI surfaces sufficient for agent-driven
  recommendation / action.
- [ ] Add terminal read/write CLI surfaces sufficient for agent-driven help.
- [ ] Add approval/policy support for high-impact host and terminal actions.

### Legacy LLM deletion

- [ ] Remove old frontend model-selection UI tied only to one-shot LLM flows.
- [ ] Remove old frontend/admin provider configuration tied only to one-shot LLM
  flows.
- [ ] Remove `src/packages/server/llm/*` after callers are gone.
- [ ] Remove `src/packages/ai/llm/evaluate-lc.ts` and related LangChain
  dependencies after callers are gone.
- [ ] Remove obsolete `/api/v2/llm/*` and related one-shot APIs.
- [ ] Keep and document only the usage tracking / throttling / entitlement logic
  still needed for Codex/ACP.

## Immediate Next Slice

1. Replace the title-bar assistant path.
2. Delete/replace the `HelpMeFix` family.
3. Delete chat summarize/regenerate.
4. Start designing the host CLI surface required to replace host AI
   recommendation.
5. Start designing terminal read/write CLI support required for terminal-first
   Codex help.
6. After the remaining frontend entrypoints are gone, begin deleting the old
   LangChain one-shot stack package by package.
