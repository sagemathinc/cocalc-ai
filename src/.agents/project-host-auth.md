# Project-Host Auth Implementation Checklist

Branch scope: implement robust browser -> project-host Conat authentication and subject authorization.

## Principles

- Authenticate once per websocket connection using short-lived host-scoped token.
- Authorize each publish/subscribe using local ACL state on project-host.
- Keep auth policy logic shared across central and project-host implementations.
- Optimize for quick collaborator grant propagation and scalable host behavior.

## Checklist

- [x] Create shared auth policy module under `src/packages/conat/auth/`.
- [x] Refactor central hub auth code to reuse shared policy logic from `src/packages/server/conat/socketio/auth.ts`.
- [x] Add project-host auth adapter that uses shared policy + project-host collaborator lookups.
- [x] Replace permissive `getUser: async () => ({ account_id })` in project-host Conat startup.

### Token issuance and verification

- [x] Add central RPC to issue project-host auth token (host-scoped, short TTL).
- [x] Define token claims and validation rules (`sub`, `aud`, `exp`, `iat`, `jti`).
- [ ] Implement signing key config and key id (`kid`) support.
- [x] Implement project-host token verification path in websocket handshake.

### Frontend wiring

- [x] Add per-host token manager in frontend conat client.
- [x] Attach token via socket.io `auth` for routed project-host connections.
- [x] Refresh token before expiry and retry once on auth failure.

### ACL data plane

- [ ] Implement project-host in-memory ACL indexes for collaborator checks.
- [ ] Add hub -> host collaborator delta stream and handlers.
- [ ] Ensure fast grant propagation path (seconds target).
- [ ] Add bounded periodic reconcile (recently modified + active projects only).
- [ ] Add on-demand single-project ACL refresh for unknown project checks.

### Authorization behavior

- [x] Enforce account-scoped hub subjects (`hub.account.<id>.api`) per authenticated identity.
- [x] Enforce project subject access based on local collaborator ACL.
- [x] Enforce inbox/public/common conat subject rules consistent with central policy.
- [x] Deny by default for unknown/unsupported subject classes.

### Caching and performance

- [x] Share/port auth decision LRU cache logic for repeated checks.
- [ ] Add TTL and invalidation strategy tied to ACL updates.
- [ ] Validate memory footprint under high project counts.

### Observability and ops

- [ ] Add structured logs for token verify failures and deny reasons.
- [ ] Add metrics for allow/deny, delta lag, reconcile duration, on-demand fetches.
- [ ] Add health/debug endpoint or trace hooks for ACL cache state summaries.

### Tests

- [ ] Unit tests for shared subject policy logic.
- [ ] Unit tests for project-host adapter collaborator cases.
- [ ] Integration tests for add-collaborator fast grant behavior.
- [ ] Integration tests for revoke behavior and stale-token scenarios.
- [ ] Scale-oriented test for hosts with large project sets.

## Deferred / Out of Scope Here

- Full provider API key proxy architecture.
- Broader non-conat project-host auth hardening not directly related to websocket subject auth.
