# Project-Host Shared Browser Session Plan

## Goal

Replace the current "mint a fresh hub-issued bearer token for every browser ->
project-host reconnect" model with a shared, host-local browser session on each
project-host.

This session should be used by:

- browser -> project-host Conat websocket auth
- private/self-managed app server HTTP and websocket proxy auth
- other direct browser -> project-host request paths that currently need their
  own short-lived bootstrap token flow

The result should be:

- much faster reconnect to a project-host after network changes
- reconnect that is mostly independent of hub health
- lower steady-state load on the central hub
- simpler and more uniform app-server/private-port auth

## Why This Matters

The current routed project-host reconnect path is fragile because it couples one
browser reconnect to too many things:

- main hub transport health
- route refresh / host metadata refresh
- fresh project-host auth token minting through the hub
- frontend reconnect/backoff logic
- token invalidation and retry timing

This has repeatedly led to:

- minute-scale reconnects after a network switch
- reconnect behavior that is highly sensitive to incidental timing
- reconnect logic that is hard to reason about and easy to regress

App-server/private-port auth is also more complex than it should be because it
has its own per-request or per-link bootstrap path instead of reusing a shared
browser identity session on the project-host.

## High-Level Architecture

Introduce one **host-local browser session cookie** on each project-host.

### Bootstrap model

1. Browser first reaches a project-host using the existing short-lived
   hub-issued host-scoped bearer.
2. Project-host verifies that bearer and sets a host-local `HttpOnly` browser
   session cookie.
3. Later browser -> project-host reconnects use that cookie directly.
4. Project-host performs project/subject authorization locally on every request.
5. Hub is only needed when:
   - there is no valid browser session cookie
   - the cookie expired
   - the account/session was revoked
   - the browser needs to connect to a different host

### Important distinction

The long-lived thing becomes the **host-local session**, not the hub-issued
bearer.

That means:

- keep the hub-issued bearer short-lived
- make the host-local session comparatively long-lived
- let project-host enforce revocation and authorization on every request

## Intended Security Model

The shared browser session cookie should assert only:

- authenticated `account_id`
- `iat`
- `exp`
- nonce / signature material

It should **not** encode project membership or subject permissions.

Those remain local decisions on the project-host:

- Conat subject authorization continues in
  `src/packages/project-host/conat-auth.ts`
- HTTP/app-server/private-port authorization continues in
  `src/packages/project-host/http-proxy-auth.ts`

This is the same key architectural choice we already use:

- central hub establishes identity
- project-host decides what that identity may access locally

## Relationship To Existing HTTP App Proxy Auth

We already have a close precedent:

- `src/packages/project-host/http-proxy-auth.ts`
- `docs/project-host-auth.md`

Today, project-host HTTP proxy auth already does:

- short-lived bearer bootstrap
- host-local `HttpOnly` session cookie
- local revocation and collaborator checks

The problem is that this is currently specialized to HTTP/app proxy traffic and
not shared cleanly with browser -> project-host Conat websocket auth.

The end state should be:

- one shared project-host browser session concept
- Conat websocket auth consumes it
- private app-server/self-managed-port proxy auth consumes it
- public app auth remains separate

## Desired End State

### Browser -> project-host Conat

- first connect may require hub bearer bootstrap
- reconnect should usually use only the host-local browser session cookie
- reconnect should not require touching the hub in the common case

### Private app-server / self-managed ports

- once the browser already has a valid host-local session cookie, opening a
  private app URL on that host should not need a separate bespoke auth dance
- project-host should authorize the request using the same host-local session
  plus per-project collaborator checks

### Central hub

- mints short-lived bootstrap bearers
- propagates revocation state
- remains control-plane authority
- is no longer in the hot reconnect path for already-established project-host
  browser sessions

## Recommended Concrete Design

### 1. Add a shared host-local browser session module

Create a shared module under `src/packages/project-host/` for:

- issuing a signed browser session token
- verifying it
- reading it from cookies
- clearing it

This should be parallel to existing HTTP proxy session handling, but with a
design intended for reuse by both Conat and HTTP proxy code.

The token payload should include:

- `account_id`
- `iat`
- `exp`
- nonce

It should be signed using a host-local secret already trusted by the
project-host runtime.

### 2. Add a dedicated bootstrap endpoint for Conat session auth

Do **not** try to make the first version depend on socket.io handshake response
cookie semantics.

Instead add a small explicit bootstrap endpoint, e.g.:

- `POST /conat/auth/bootstrap`

Input:

- bearer token in header or body

Behavior:

- verify hub-issued project-host bearer
- check revocation
- set host-local browser session cookie
- return `204` or a tiny JSON success payload

This makes the bootstrap flow much easier to reason about and test.

### 3. Teach Conat auth to accept browser session cookies first

Update `src/packages/project-host/conat-auth.ts` so browser auth order becomes:

1. trusted local/system/project auth paths already in place
2. shared host-local browser session cookie
3. short-lived hub-issued bearer fallback

If cookie auth succeeds:

- identify the browser as `account_id`
- use the existing subject policy / collaborator checks
- do not require a fresh hub round trip

### 4. Unify private app-server auth around the same browser session

Refactor `src/packages/project-host/http-proxy-auth.ts` to use the same shared
browser session abstraction instead of maintaining a partially separate session
format and cookie story.

Important:

- private/authenticated app-server and self-managed port traffic should use the
  shared browser session
- public app handling remains separate
- cookies must continue to be stripped before proxying upstream to apps

### 5. Simplify frontend routed project-host logic

Update `src/packages/frontend/conat/client.ts` so it has a simple model:

- ensure route to host
- ensure browser session bootstrap exists for that host if needed
- connect directly to project-host
- on reconnect, prefer reusing the existing browser session cookie
- only fall back to hub bearer bootstrap when the host explicitly says the
  browser session is missing/expired/revoked

This should let us delete a significant amount of retry-specific complexity
whose only purpose today is to recover from token mint / auth bootstrap issues.

## Scope Boundaries

### In scope

- browser -> project-host Conat auth
- private/self-managed app-server auth
- host-local browser session cookie
- revocation compatibility
- reconnect simplification and performance

### Out of scope

- public app auth model
- project runtime internal auth
- hub <-> host service auth
- general app-server feature work unrelated to auth/session establishment

## Implementation Phases

### Phase 1: Shared session primitives

Implement:

- shared project-host browser session token issue/verify helpers
- cookie name/constants
- tests for token issue/verify/expiry/revocation handling

Likely files:

- new shared module under `src/packages/project-host/`
- `src/packages/project-host/http-proxy-auth.ts`
- tests near existing HTTP auth tests

### Phase 2: Conat bootstrap endpoint

Implement:

- bootstrap endpoint that accepts a valid hub-issued bearer
- sets the host-local browser session cookie
- clears/replaces old incompatible session state

Likely files:

- `src/packages/project-host/main.ts`
- `src/packages/project-host/http-proxy-auth.ts` or a sibling module
- route wiring/tests

### Phase 3: Conat auth uses cookie sessions

Implement:

- `src/packages/project-host/conat-auth.ts` reads shared browser session cookie
- revocation checks applied to cookie-authenticated sessions
- bearer fallback retained for bootstrap and compatibility

Validation:

- direct browser -> project-host Conat connect with cookie only
- reconnect after network switch with no hub token mint

### Phase 4: Frontend bootstrap + reconnect simplification

Implement:

- frontend bootstrap helper:
  - "ensure project-host browser session for host X"
- routed reconnect uses bootstrap only on missing/expired/revoked session
- remove token-specific reconnect churn where possible

Likely files:

- `src/packages/frontend/conat/client.ts`
- `src/packages/frontend/conat/client.test.ts`

### Phase 5: Private app-server auth simplification

Implement:

- private app/self-managed-port proxy auth uses the shared browser session
- remove redundant separate bootstrap logic where possible
- keep public app rules separate

Likely files:

- `src/packages/project-host/http-proxy-auth.ts`
- `src/packages/frontend/project/app-server-panel.tsx`
- any private app URL generation helpers

### Phase 6: Cleanup

After the new flow is stable:

- remove obsolete project-host bearer refresh complexity from frontend
- reduce duplicated HTTP-vs-Conat session code
- update docs

## App Server Simplification Goals

This redesign should explicitly simplify the private app/server path.

### Current problem

Private app-server auth currently has its own partially separate flow, and that
path has been brittle in the face of recent multibay/routing changes.

### Intended simplification

If the browser already has a valid host-local session on a project-host, then:

- opening a self-managed port on that same host should work without another
  bespoke auth bootstrap
- the project-host proxy simply checks:
  - who is this account?
  - is this account allowed to access this project/path?

That is a much simpler model than "generate per-link/per-request bootstrap auth
state again."

## Testing Plan

### Unit/integration tests

Add tests for:

- session issue/verify
- revocation invalidates session-authenticated browser access
- Conat auth accepts session cookie
- Conat reconnect uses existing session cookie without hub token mint
- Conat fallback to bearer bootstrap when no cookie exists
- private app proxy accepts session cookie
- private app proxy rejects revoked session

### Browser-driven tests

Add real QA scenarios for:

1. Load page, connect to project-host, switch networks within a minute.
   Expected: reconnect without hub token mint in the common case.

2. Load page, idle past bearer expiry but keep browser session alive, then
   switch networks.
   Expected: reconnect still succeeds from host-local session.

3. Clear browser session cookie and reconnect.
   Expected: one bootstrap via hub bearer, then normal operation.

4. Revoke/sign-out-everywhere while browser session exists.
   Expected: project-host blocks further access and disconnects active sessions.

5. Open private app/self-managed port after project-host session already exists.
   Expected: no separate bespoke auth/bootstrap failure path.

## Risks / Open Questions

### 1. Cookie scope and browser policy

We must choose cookie attributes that work for our browser/project-host origin
relationship.

Need to verify carefully:

- `Domain`
- `Path`
- `Secure`
- `SameSite`

Especially if any deployments are truly cross-site rather than merely
cross-origin.

### 2. One shared cookie vs separate Conat/HTTP cookies

Default recommendation:

- one shared host-local browser session abstraction
- potentially separate cookie names/paths only if browser behavior or migration
  needs it

We should bias toward one concept, not two parallel auth systems.

### 3. Revocation propagation

This design depends on project-host having timely revocation information.

That is already required by the current HTTP proxy session design, so this is
not a new problem, but the testing burden is real.

### 4. Host migration

The session is host-local.

If a project moves to a different host, the browser must bootstrap a session on
the destination host. That is expected and acceptable.

## Recommended Next Step

Do not spend many more iterations trying to make the current hub-token-based
project-host reconnect path perfect.

Instead:

1. implement the shared project-host browser session primitive
2. use it for Conat reconnect first
3. then simplify private app-server auth around the same session

This is the most direct path to:

- fast reconnect
- robust reconnect
- lower hub load
- simpler app-server auth
