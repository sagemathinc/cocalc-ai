# Frontend Assistant to Codex Migration

TODO

- [ ] discuss eliminating ALL of the langchain non-coding agent use of LLM's entirely; they are already completely removed from the UI, but cause coding confusing, maintenance concerns, backend complexity, security issues, but aren't used.
- [ ] add some good codex integration with the TERMINAL (maybe warp or something could be inspiration?)

## Goal

Replace the legacy frontend "Assistant" and one-shot LLM integrations with the
Codex/ACP agent stack, routed through visible chat or Navigator threads.

This is a frontend product migration plan, not a backend runtime plan. It
assumes the current Codex/ACP runtime, browser tooling, and chat integration
are now stable enough to support user-facing assistant workflows.

## Product Rules

1. Assistant actions route through Codex/ACP, not legacy one-shot LLM actions.
2. Users should see one coherent timeline for assistant work, not hidden side
   effects.
3. Successful assistant actions should apply edits directly when safe. The user
   should not need to copy/paste AI output back into documents.
4. The large orange `AI Assistant` button should be replaced with a subtler
   Codex/agent affordance once parity is reached.
5. Fast assistant flows should be able to use `gpt-5.4-mini`; deeper coding
   flows can still opt into larger Codex models.
6. Live sync/RTC document state is the source of truth. Assistant flows should
   not depend on saving files to disk before work begins.

## Current State

The most complete inventory currently lives in `src/.agents/alpha.md` under
`P3. Migrate all existing assistant/LLM paths to Codex + agent framework`.
This file extracts that inventory into a dedicated execution plan for frontend
work.

What is already partly migrated:

- Notebook error repair already has a `Fix with Agent` path:
  - `src/packages/frontend/jupyter/llm/error.tsx`
  - `src/packages/frontend/project/new/navigator-intents.ts`
- Workspace/floating agent chat is now good enough to serve as the frontend
  target for assistant flows.

What is still legacy:

- The title-bar `AI Assistant` path still routes through legacy LLM UI:
  - `src/packages/frontend/frame-editors/frame-tree/commands/generic-commands.tsx`
  - `src/packages/frontend/frame-editors/llm/llm-assistant-button.tsx`
  - `src/packages/frontend/frame-editors/llm/create-chat.ts`
- `HelpMeFix` still exists beside the newer notebook agent route.
- Several Jupyter/editor/chat/generation actions still use dedicated LLM flows
  instead of a common Codex intent contract.

## Inventory

| Entry point                     | Current code path                                                                                                                              | Current state            | Target route                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------ |
| Editor title bar `AI Assistant` | `frame-editors/frame-tree/commands/generic-commands.tsx` -> `frame-editors/llm/llm-assistant-button.tsx` -> `frame-editors/llm/create-chat.ts` | Legacy LLM path          | Navigator/Codex intent router                    |
| Help Me Fix family              | `frame-editors/llm/help-me-fix.tsx`, `frame-editors/llm/help-me-fix-utils.ts`, file-type consumers                                             | Legacy LLM path          | Navigator/Codex intent router                    |
| Notebook `Fix with Agent`       | `jupyter/llm/error.tsx`                                                                                                                        | Partly migrated          | Keep and use as reference path                   |
| Jupyter cell AI tool            | `jupyter/llm/cell-tool.tsx`                                                                                                                    | Legacy LLM path          | Navigator/Codex intent router                    |
| Jupyter AI generate cell        | `jupyter/insert-cell/ai-cell-generator.tsx`                                                                                                    | Legacy LLM path          | Codex intent with direct cell apply              |
| AI Generate Document            | `project/page/home-page/ai-generate-document.tsx` and related call sites                                                                       | Legacy LLM path          | Codex intent with direct file creation           |
| AI formula generator            | `codemirror/extensions/ai-formula.tsx`, `editors/slate/format/insert-ai-formula.ts`                                                            | Legacy LLM path          | Codex intent with in-place apply                 |
| Chat summarize/regenerate       | `chat/llm-msg-summarize.tsx`, `chat/llm-msg-regenerate.tsx`, `chat/actions/llm.ts`                                                             | Mixed special-case flows | Codex-backed chat intents or explicit exceptions |
| Host AI recommendations         | `hosts/components/host-ai-assist.tsx`, `hosts/hooks/use-host-ai.ts`                                                                            | Legacy LLM path          | Codex recommendation intent                      |

## Migration Contract

Every migrated assistant trigger should emit one intent envelope through the
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
   of truth. If the browser has unsaved edits, the agent should still work on
   the current sync state.
3. Prefer backend live-document APIs and sync-aware mutations over on-disk file
   edits.
4. For document types that do not yet have adequate live mutation APIs, add
   backend/CLI support instead of falling back to stale filesystem reads.
5. Long-running agent work must remain robust across browser refreshes or
   disconnects. The user should be able to refresh and continue seeing live
   updates driven by the same underlying sync document state.
6. Queue into the visible Codex/Navigator timeline by default, with explicit
   immediate-send override only when needed.
7. Return direct edits/applies for normal success paths.

## Execution Waves

### Wave 1: Help Me Fix and notebook repair

Why first:

- Highest user value.
- The notebook `Fix with Agent` path already exists and can serve as the
  reference implementation.

Tasks:

- Replace `HelpMeFix` one-shot sends with Codex intent dispatch.
- Keep existing button placements initially; change backend behavior first.
- Standardize on a floating agent popup or current Navigator thread behavior.

Done when:

- Notebook, LaTeX, Rmd/Qmd, formatter, and related fix flows all land in a
  visible Codex timeline and apply fixes directly when safe.
- Notebook repairs and edits happen through live sync state, so unsaved changes,
  browser refreshes, and long-running agent work remain coherent.

### Wave 2: Replace the title-bar Assistant

Tasks:

- Replace the current `AI Assistant` affordance with a Codex-first action.
- Reduce visual prominence of the current orange button.
- Preserve current high-value presets only if they map cleanly to Codex intent
  presets.

Done when:

- There is no production title-bar assistant path that still depends on the
  legacy `frame-editors/llm/*` send flow.

### Wave 3: Jupyter/editor generation tools

Tasks:

- Route the cell AI tool through Codex.
- Route notebook cell generation through Codex with direct insert/apply.
- Route document generation and formula generation through Codex with direct
  apply.

Done when:

- Generation results can be inserted or applied directly without copy/paste.

### Wave 4: Chat and host special cases

Tasks:

- Decide which special chat actions should become Codex intents versus remain
  explicit product-specific helpers.
- Route host recommendation through Codex if the interaction model remains
  useful.

Done when:

- All remaining assistant-like production flows are either Codex-routed or
  explicitly documented as intentional exceptions.

## Code Areas Likely To Shrink Or Disappear

- `src/packages/frontend/frame-editors/llm/llm-assistant-button.tsx`
- `src/packages/frontend/frame-editors/llm/create-chat.ts`
- parts of `src/packages/frontend/frame-editors/llm/help-me-fix.tsx`
- LLM-specific frontend UI that only exists to paper over missing agent support

## Immediate Next Slice

1. Migrate the Help Me Fix family to the same Codex routing used by notebook
   `Fix with Agent`.
2. Define the live-document mutation contract for assistant flows: chat, tasks,
   Jupyter, and other sync-backed documents must be edited through backend/CLI
   APIs instead of disk.
3. Replace the title-bar `AI Assistant` button with a Codex-first launcher once
   Wave 1 is stable enough to reuse its intent routing.