# Codex Auth for Launchpad / Project-Runner

## Goal

Make `codex exec` work reliably in project-runner environments with **three auth sources** and clear precedence:

1. User ChatGPT subscription (per-user, highest priority)
2. Project OpenAI API key
3. Account OpenAI API key
4. Site-wide OpenAI API key (lowest priority)

Also enforce:

- Auth isolation across collaborators
- No key leakage for site-wide key mode
- Turn kill/cutoff for cost control

## Current constraints and observed gaps

- Codex container identity is effectively project-scoped today in [src/packages/project-host/codex-project.ts](./src/packages/project-host/codex-project.ts), so collaborator credentials can bleed between turns.
- ACP request path already includes `account_id` and `project_id` in [src/packages/conat/ai/acp/types.ts](./src/packages/conat/ai/acp/types.ts), so we can resolve auth per turn.
- Project-host currently mounts a single global `~/.codex` into Codex containers in [src/packages/project-host/codex-project.ts](./src/packages/project-host/codex-project.ts), which is not safe for multi-user auth.

## Architecture decision

Use **auth-context keyed runtimes**:

- One Codex container per `{project_id, auth_context_fingerprint}`.
- One Codex home dir per `auth_context_fingerprint`.
- Resolve auth at turn start on project-host (not in frontend).

This keeps subscription tokens isolated and allows concurrent turns by collaborators with different credentials.

## Auth precedence and policy

For each turn (`account_id`, `project_id`):

1. If account has active ChatGPT subscription auth, use it.
2. Else if project has OpenAI key, use it.
3. Else if account has OpenAI key, use it.
4. Else if site-wide OpenAI key exists, use it.
5. Else fail with clear error.

Rules:

- Subscription credential is only usable by its owning `account_id`.
- Project key is usable by any collaborator with Codex access for that project.
- Site key never gets exposed directly inside workspace-accessible paths.

## Phase plan

### Phase 1: Auth data model and secure storage

1. Add a dedicated credential registry (Postgres) for Codex auth blobs:
   - `codex_credentials(id, scope, owner_account_id, project_id, kind, encrypted_payload, metadata, created, updated, revoked)`
   - `scope ∈ {account, project, site}`
   - `kind ∈ {chatgpt_subscription, openai_api_key}`
2. Add encryption-at-rest helper following existing server secret patterns (similar style to [src/packages/server/project-backup/index.ts](./src/packages/server/project-backup/index.ts) and [src/packages/database/settings/secret-settings.ts](./src/packages/database/settings/secret-settings.ts)).
3. Add migration + typed access module in server package (new module under `src/packages/server/codex-auth/`).
4. Keep API key plaintext out of logs and responses.

### Phase 2: Server APIs for credential lifecycle

1. Account APIs:
   - Set/clear account OpenAI API key
   - Start subscription device auth
   - Poll subscription login status
   - Revoke subscription credential
2. Project APIs:
   - Set/clear project OpenAI API key (collaborator permission checks)
3. Admin APIs:
   - Set/clear site-wide OpenAI API key (admin only)
   - Configure default per-turn hard limits for site-key mode
4. Add resolve endpoint:
   - Input: `{account_id, project_id}`
   - Output: signed short-lived auth descriptor (no raw site key in response to frontend)

### Phase 3: Subscription device-auth flow

1. Implement device flow service on backend:
   - Run `codex login --device-auth` in an isolated temp `CODEX_HOME` or call equivalent login library path.
   - Capture verification URL + user code.
   - Poll completion and persist resulting auth material (`auth.json` equivalent) encrypted.
2. Store subscription metadata for enforcement:
   - OpenAI account id / email (if available from token claims)
   - Plan info (if available)
3. Only allow use when turn `account_id` matches credential owner.

### Phase 4: Project-host auth resolution and runtime materialization

1. Add project-host module (new `src/packages/project-host/codex-auth.ts`) that:
   - Resolves effective auth source for each turn (using server API + fallback cache)
   - Produces `AuthRuntimeConfig`:
     - `authContextFingerprint`
     - env overrides (`OPENAI_API_KEY` and/or provider/base URL)
     - optional per-context `CODEX_HOME` mount path
2. Materialize per-context Codex home:
   - e.g. `/btrfs/codex-auth/<fingerprint>/auth.json`
   - ownership/permissions locked down (`0700` dir, `0600` files)
3. Remove global shared Codex home mount behavior for project-host Codex runs.

### Phase 5: Container keying and spawn-path changes

1. Extend spawn interface in [src/packages/ai/acp/codex-project.ts](./src/packages/ai/acp/codex-project.ts):
   - include resolved auth runtime context
2. Update [src/packages/project-host/codex-project.ts](./src/packages/project-host/codex-project.ts):
   - container name becomes `codex-<project>-<authhash>`
   - lease/refcount key includes auth hash
   - mount per-auth `CODEX_HOME`
   - inject auth env from resolved context
3. Ensure two users in same project with different auth contexts get different containers and isolated state.

### Phase 6: Site-key protection, metering, and kill switches

1. Introduce an OpenAI proxy/gateway for **site-wide key mode**:
   - inject real site key server-side
   - require signed project-host token
   - per-account/project attribution
2. Enforce hard runtime limits:
   - max wall clock duration per turn
   - max spend budget per turn (site-key mode)
3. On limit breach:
   - interrupt session via existing ACP interrupt path in [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts)
   - hard-kill process/container if graceful interrupt fails
4. Return explicit “stopped due to budget/timeout” status to chat log.

### Phase 7: Frontend UX

1. Account settings:
   - “Connect ChatGPT subscription” (device auth)
   - “Set account OpenAI API key”
   - Show active source and precedence explanation
2. Project settings:
   - “Set project OpenAI API key”
   - Show whether project key overrides account/site keys
3. Admin settings:
   - Site-wide key config and limits
4. Chat/Codex panel:
   - show effective auth source per turn (subscription / project key / account key / site key)
   - show stop reason if throttled/killed

### Phase 8: Tests and rollout

1. Unit tests:
   - precedence resolver
   - auth ownership checks
   - auth-context fingerprint stability
2. Integration tests:
   - two collaborators, same project, different auth -> isolated containers
   - overlapping turns do not cross credentials
   - site-key budget cutoff interrupts running turn
3. Rollout flags:
   - `COCALC_CODEX_AUTH_V2`
   - `COCALC_CODEX_SITE_PROXY_ENABLED`
4. Gradual enablement:
   - Stage A: API key sources only
   - Stage B: subscription device-auth
   - Stage C: site-key proxy + billing enforcement mandatory

## Concrete file touchpoints

- Codex container lifecycle: [src/packages/project-host/codex-project.ts](./src/packages/project-host/codex-project.ts)
- ACP evaluate path / interrupts: [src/packages/lite/hub/acp/index.ts](./src/packages/lite/hub/acp/index.ts)
- ACP request/typing: [src/packages/conat/ai/acp/types.ts](./src/packages/conat/ai/acp/types.ts)
- Codex exec spawn integration: [src/packages/ai/acp/codex-exec.ts](./src/packages/ai/acp/codex-exec.ts)
- Project-host startup wiring: [src/packages/project-host/main.ts](./src/packages/project-host/main.ts)
- Site settings (existing site OpenAI key): [src/packages/util/db-schema/site-settings-extras.ts](./src/packages/util/db-schema/site-settings-extras.ts)

## Open questions to settle before implementation

1. Should account/project API keys be proxied too (for unified metering), or passed directly as env/auth.json? ANS: YES.  for project scope, one user may want to set an api key on a project (or later an organization, with limits) and all collabs on the project then use the api key, but they don't want anybody to actually know the api key.      Account scope seems less important though.    
2. Do we want a hard policy that subscription auth is single-user and non-shareable even among project owners (recommended: yes)?  ANSWER: We want this if and only if it is required by the terms of service of OpenAI.  I looked: _"You may not share your account credentials or make your account available to anyone else and are responsible for all activities that occur under your account. "_
3. For site-key mode, what is the default hard cap policy:
   - max minutes per turn
   - max dollars per turn
   - max concurrent turns per account/project
   - ANS: we just need to shut them off when they hit the limits; we have general limits associated with membership tiers.
4. Should we allow fallback from subscription to key if subscription refresh fails mid-turn, or fail-fast?  ANS: good question. Probably fail fast is better.

## Definition of done

- All four precedence sources implemented and observable.
- Auth isolation proven by concurrent-collaborator tests.
- Site-wide key never exposed to users/project files/containers directly.
- Turn cutoff works reliably for timeout and budget breach.