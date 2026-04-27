# Codex-Only AI Cleanup Plan

## Goal

Reduce CoCalc AI complexity until the product is clearly and narrowly centered
on Codex/ACP coding agents.

This is not a backward-compatibility project. The priority is:

- less code
- fewer exposed endpoints
- fewer confusing concepts
- fewer provider/vendor branches
- a codebase that is easier for coding agents to understand and modify safely

The correct default is deletion, not hiding.

## Product Decisions

1. CoCalc AI is a Codex/ACP agent product, not a generic model-vendor product.
2. Site admin configuration should expose only the OpenAI integration needed for
   Codex.
3. `openai_enabled` means the OpenAI integration is allowed. It does not mean a
   site API key is configured.
4. Users may rely on their own subscriptions. Site-wide OpenAI usage is
   optional.
5. The old one-shot model-evaluation stack should be deleted once Codex usage,
   planning, and billing no longer depend on it.
6. The old equation/formula AI feature should be deleted, not migrated.
7. New names should prefer `ai`, `agent`, and `codex`. The term `llm` should be
   treated as legacy/internal only and removed where practical.

## Keep vs Delete

### Keep

Keep and continue building:

- ACP/Codex runtime and worker paths:
  - `src/packages/ai/acp/*`
  - `src/packages/lite/hub/acp/*`
  - `src/packages/conat/ai/acp/*`
  - `src/packages/project-host/codex/*`
- frontend chat / agent UX that already fronts Codex:
  - `src/packages/frontend/chat/*`
  - Codex/Navigator entry points under `src/packages/frontend/project/new/*`
  - Codex-backed assistant surfaces that happen to live under legacy
    `frame-editors/llm` or `jupyter/llm` paths for now
- usage / entitlement / throttling concepts, but renamed and split away from
  the legacy generic model runtime

### Delete

Delete completely once dependencies are removed:

- generic model-vendor runtime:
  - `src/packages/ai/llm/*`
  - `src/packages/server/llm/*`
  - `src/packages/lite/hub/llm.ts`
  - `src/packages/conat/llm/*`
  - `src/packages/server/conat/llm.ts`
- old generic HTTP/API surfaces:
  - `src/packages/http-api/pages/api/v2/llm/*`
  - `src/packages/http-api/pages/api/v2/openai/chatgpt.ts`
- old frontend model-selection / vendor UI:
  - `src/packages/frontend/account/useLanguageModelSetting.tsx`
  - `src/packages/frontend/account/user-defined-llm.tsx`
  - `src/packages/frontend/frame-editors/llm/llm-selector.tsx`
  - `src/packages/frontend/frame-editors/llm/use-llm-menu-options.tsx`
  - `src/packages/frontend/admin/llm/*`
- one-shot AI features that do not fit the Codex product:
  - `src/packages/frontend/codemirror/extensions/ai-formula.tsx`
  - related formula command wiring and strings
  - AI document-generation flows that only existed because the old stack could
    not directly edit documents

## Important Constraint

Do not mass-delete directories based only on old names.

In particular:

- `src/packages/frontend/frame-editors/llm/*`
- `src/packages/frontend/jupyter/llm/*`

must be audited file-by-file. Some of that code is already Codex/ACP product
code and should be renamed later, not deleted immediately.

This matters directly for codebase clarity for agents. A misleading path name is
bad, but deleting working Codex entry points because the folder says `llm` would
be worse.

## Current Legacy Inventory

### 1. Admin site settings still expose the old generic AI stack

Files:

- `src/packages/util/db-schema/site-defaults.ts`
- `src/packages/util/db-schema/site-settings-extras.ts`
- `src/packages/frontend/admin/site-settings/index.tsx`
- `src/packages/frontend/admin/site-settings/row-entry-inner.tsx`
- `src/packages/util/db-schema/site-settings-public.ts`
- `src/packages/frontend/customize.tsx`

Current problems:

- the admin UI still exposes multiple providers
- `openai_enabled` defaults to off
- `openai_api_key` is still treated as required when OpenAI is enabled
- site settings still publish old model/provider configuration into frontend
  customize state
- admin rendering still has special-case UI for `default_llm`,
  `selectable_llms`, Ollama, and custom OpenAI

### 2. OpenAI integration availability is still coupled to site API key presence

Files:

- `src/packages/server/conat/api/system.ts`
- `src/packages/lite/hub/api.ts`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/lite/hub/settings.ts`

Current problems:

- site OpenAI integration is treated as unavailable unless the site key exists
- that does not match the actual product direction where users may provide their
  own subscriptions

### 3. Generic model runtime is still live

Files:

- `src/packages/server/llm/index.ts`
- `src/packages/ai/llm/evaluate-lc.ts`
- `src/packages/lite/hub/llm.ts`
- `src/packages/conat/llm/server.ts`
- `src/packages/server/conat/llm.ts`
- `src/packages/http-api/pages/api/v2/llm/evaluate.ts`
- `src/packages/http-api/pages/api/v2/llm/model-costs.ts`
- `src/packages/http-api/pages/api/v2/openai/chatgpt.ts`

Current problems:

- multiple providers and evaluation paths are still present
- langchain-based infrastructure is still in the backend
- stale endpoints increase maintenance and security surface area

### 4. Agent planning still depends on the old generic runtime

Files:

- `src/packages/server/conat/api/agent.ts`
- `src/packages/lite/hub/agent.ts`

Current problems:

- planner model selection still depends on `default_llm`
- planner execution still calls the generic server model-evaluation stack

### 5. Frontend account/admin/vendor-selection UX still exists

Files:

- `src/packages/frontend/account/other-settings.tsx`
- `src/packages/frontend/account/useLanguageModelSetting.tsx`
- `src/packages/frontend/account/user-defined-llm.tsx`
- `src/packages/frontend/frame-editors/llm/llm-selector.tsx`
- `src/packages/frontend/frame-editors/llm/use-llm-menu-options.tsx`
- `src/packages/frontend/admin/llm/admin-llm-test.tsx`
- `src/packages/frontend/client/llm.ts`
- `src/packages/frontend/chat/actions/llm.ts`

Current problems:

- vendor/model selection still appears as a user-facing product concept
- direct model-evaluation code still exists in frontend paths
- admin still has tooling for the old stack

### 6. The old AI formula/equation feature still exists

Delete this whole feature rather than trying to preserve it.

Files:

- `src/packages/frontend/codemirror/extensions/ai-formula.tsx`
- `src/packages/frontend/editors/slate/format/insert-ai-formula.ts`
- `src/packages/frontend/editors/slate/format/commands.ts`
- `src/packages/frontend/codemirror/extensions/edit-selection.ts`
- editor integrations in:
  - `src/packages/frontend/frame-editors/markdown-editor/editor.ts`
  - `src/packages/frontend/frame-editors/latex-editor/editor.ts`
  - `src/packages/frontend/frame-editors/rmd-editor/editor.ts`
  - `src/packages/frontend/frame-editors/qmd-editor/editor.ts`

Also remove related i18n strings, command wiring, and any marketing/product text
that advertises formula AI.

### 7. Usage/billing still uses legacy `llm` naming and some old server helpers

Files:

- `src/packages/server/conat/api/hosts.ts`
- `src/packages/server/llm/usage-status.ts`
- `src/packages/server/llm/usage-units.ts`
- `src/packages/util/membership-tier-templates.ts`
- `src/packages/frontend/admin/membership-tiers.tsx`
- `src/packages/frontend/account/membership-status.tsx`
- `src/packages/frontend/public/content/pricing-page.tsx`

Current problems:

- Codex usage and entitlement logic still depends on helpers in the old generic
  stack
- product names still say `llm` even when the real concept is Codex/AI usage

## Execution Plan

### Phase 1: Simplify admin AI settings aggressively

Objective:

- make the admin AI configuration match the real product immediately

Changes:

- keep only OpenAI-related settings in the admin AI section
- default `openai_enabled` to `yes`
- default `agent_openai_codex_enabled` to `yes`
- remove the rule that `openai_api_key` is required when OpenAI is enabled
- remove old provider settings from the admin settings UI entirely
- remove `default_llm`, `selectable_llms`, and `user_defined_llm` from admin UI

Files:

- `src/packages/util/db-schema/site-defaults.ts`
- `src/packages/util/db-schema/site-settings-extras.ts`
- `src/packages/frontend/admin/site-settings/index.tsx`
- `src/packages/frontend/admin/site-settings/row-entry-inner.tsx`
- `src/packages/util/db-schema/site-settings-public.ts`
- `src/packages/frontend/customize.tsx`

Deletion policy:

- prefer deleting obsolete schema/config/UI entries instead of leaving dead
  hidden branches

### Phase 2: Decouple OpenAI enablement from site API key presence

Objective:

- a site may allow OpenAI/Codex even when no site key is configured

Changes:

- redefine availability checks so `openai_enabled` means integration allowed
- treat the site API key as optional site-funded usage, not as the gate for the
  whole feature
- preserve the admin ability to explicitly disable OpenAI entirely

Files:

- `src/packages/server/conat/api/system.ts`
- `src/packages/lite/hub/api.ts`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/lite/hub/settings.ts`

### Phase 3: Split Codex metering and planning away from the generic runtime

Objective:

- make it possible to delete `server/llm` without breaking Codex

Changes:

- move usage/accounting helpers needed by Codex out of the legacy `server/llm`
  area
- replace planner dependence on `default_llm` and generic model evaluation
- make the planner either:
  - Codex-native, or
  - deterministic/local if that is sufficient

Files:

- `src/packages/server/conat/api/agent.ts`
- `src/packages/lite/hub/agent.ts`
- `src/packages/server/conat/api/hosts.ts`
- `src/packages/server/llm/usage-status.ts`
- `src/packages/server/llm/usage-units.ts`
- any new replacement package/path for Codex usage accounting

Design rule:

- after this phase, Codex runtime and Codex accounting should not require the
  old generic multi-provider evaluation stack

### Phase 4: Delete the generic model runtime and exposed endpoints

Objective:

- remove dead complexity and security surface area

Delete:

- `src/packages/ai/llm/*`
- `src/packages/server/llm/*` after phase 3 replacements exist
- `src/packages/lite/hub/llm.ts`
- `src/packages/conat/llm/*`
- `src/packages/server/conat/llm.ts`
- `src/packages/http-api/pages/api/v2/llm/*`
- `src/packages/http-api/pages/api/v2/openai/chatgpt.ts`

Also remove:

- startup wiring that initializes the old generic model server
- package exports for old `llm` transport APIs
- LangChain dependencies that are no longer needed

Likely package manifest changes:

- `src/packages/ai/package.json`
- `src/packages/server/package.json`
- `src/packages/conat/package.json`
- `src/packages/lite/package.json`

### Phase 5: Delete old frontend AI/vendor/model-selection UX

Objective:

- remove the old generic AI product surface

Delete:

- `src/packages/frontend/account/useLanguageModelSetting.tsx`
- `src/packages/frontend/account/user-defined-llm.tsx`
- `src/packages/frontend/frame-editors/llm/llm-selector.tsx`
- `src/packages/frontend/frame-editors/llm/use-llm-menu-options.tsx`
- `src/packages/frontend/admin/llm/*`

Refactor:

- `src/packages/frontend/account/other-settings.tsx`
- `src/packages/frontend/customize.tsx`
- any remaining account/admin UI that talks about choosing model vendors

Result:

- users should see a Codex/Agent product, not a vendor-selection console

### Phase 6: Delete the AI formula/equation feature completely

Objective:

- remove a feature that no longer fits the product and adds confusing legacy AI
  wiring

Delete:

- `src/packages/frontend/codemirror/extensions/ai-formula.tsx`
- formula insertion helpers and commands
- editor toolbar/menu entries that invoke formula AI
- related translation keys and feature descriptions

Search targets to clean:

- `ai_formula`
- `ai_gen_formula`
- `codemirror.extensions.ai_formula`
- `command.format.ai_formula`

This phase should remove the feature as if it never existed.

### Phase 7: Rename surviving `llm` concepts and paths to `ai`, `agent`, or `codex`

Objective:

- make the resulting codebase clearer to coding agents and humans

Rename:

- user-facing text that says “Language Model”, “LLM”, or vendor-selection terms
- remaining technical identifiers where the underlying concept is now AI/Codex
- leftover directories such as frontend Codex product code living under
  `frame-editors/llm` or `jupyter/llm`

Important rule:

- rename only after deletion is done enough that we are renaming stable
  surviving concepts rather than shuffling legacy code around

### Phase 8: Final dependency and surface audit

Objective:

- prove the old generic AI stack is truly gone

Checklist:

- no production code imports `@cocalc/server/llm`
- no production code imports `@cocalc/ai/llm`
- no live HTTP route under `/api/v2/llm/*`
- no admin/vendor UI for Anthropic, Google Vertex, Mistral, Ollama, custom
  OpenAI, or user-defined models
- no formula AI feature
- no site setting dependency that incorrectly requires a site OpenAI key
- no `default_llm`, `selectable_llms`, or `user_defined_llm` product concepts
  remaining

## Recommended Order Of Implementation

1. Phase 1: admin AI settings cleanup
2. Phase 2: decouple OpenAI enablement from site API key presence
3. Phase 3: split Codex planning/metering away from the generic runtime
4. Phase 4: delete generic runtime and endpoints
5. Phase 5: delete vendor/model-selection frontend and admin UX
6. Phase 6: delete the AI formula/equation feature
7. Phase 7: rename surviving `llm` paths and identifiers
8. Phase 8: final audit and dependency cleanup

## Success Criteria

The cleanup is done when all of the following are true:

- the only production AI runtime path is Codex/ACP
- OpenAI is the only provider concept left in admin settings
- OpenAI can be enabled without a site API key
- admins can still explicitly disable OpenAI
- no generic model-evaluation backend remains
- no stale AI endpoints remain
- no vendor/model-selection product UI remains
- the formula/equation AI feature is gone
- surviving code uses `ai`, `agent`, or `codex` terminology by default
- the repository is materially easier for coding agents to understand and edit
