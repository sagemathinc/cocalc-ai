# API-First Connector: Phase 1 Implementation Map

This tracks the contract in [the API-first connector plan](https://github.com/sagemathinc/cocalc-ai/pull/696). The release target is one ordinary account-owned API key model. ACP only issues, renews, and revokes a managed instance of that model. Source was rechecked through `a97d99800a` on 2026-09-27. This is an implementation map, not completion of phases 1-4 or production approval; see the [validation report](api-first-live-validation-2026-09-26.md) for evidence and open gates.

## Existing paths

| Boundary              | Current path                                                                            | Required change                                                                                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Key owner and storage | `server/api/manage.ts`, `api_keys`                                                      | Add a versioned scope and revision; adapt existing capability/allowlist rows without widening them.                                                                                                              |
| Cluster key lookup    | `server/accounts/cluster-directory.ts`                                                  | Carry the same scope, revision, and expiry; stale replicas must fail closed.                                                                                                                                     |
| Hub HTTP              | `http-api/pages/api/conat/hub.ts`, `server/api/http-api-key-policy.ts`                  | Allow only classified RPCs and retain the authenticated principal.                                                                                                                                               |
| Hub Conat             | `server/conat/socketio/auth.ts`, `conat/core/server.ts`, `conat/auth/subject-policy.ts` | API-key sockets now use random connection-specific reply namespaces and periodic authoritative revalidation. Method/resource authorization still applies; stable primary identities determine connection limits. |
| Project list          | `projects.listProjectSummaries`, CLI `core/api-key-hub.ts`, `core/project-resolve.ts`   | Scoped CLI discovery now uses the bounded summary API and exact-project lookup, not unrestricted `db.userQuery`.                                                                                                 |
| Host exchange         | `server/conat/api/hosts-connection-auth.ts`, `conat/auth/project-host-token.ts`         | Bind the parent key, revision, exact project, host placement, capabilities, viewer policy, service subjects, reply namespace, and expiry. Ordinary account host tokens cannot stand in for a scoped key.         |
| Host enforcement      | `project-host/conat-auth.ts`, viewer file service                                       | Admit only signed, correctly placed scoped-key subjects. Revalidate the parent and membership during long-lived sessions.                                                                                        |
| API Keys UI           | `frontend/components/api-keys.tsx`                                                      | Extract one scope editor/summary used by manual keys and the CoCalc connector.                                                                                                                                   |
| ACP turn              | `project-host/codex/codex-project.ts` and trusted run state                             | Issue only from a verified live native turn binding; renewal requires the same lease; revocation remains possible after the lease ends.                                                                          |

## Canonical scope and compatibility

Store `scope: { version: 1, account: capability[], projects: grant[], all_projects?: defaultGrant }` and a monotonically increasing `scope_revision`. Each explicit project grant has one exact project ID, explicit capabilities, and optionally a read-only viewer policy. An exact grant overrides, rather than unions with, the all-projects default. All-projects access remains limited by the owner's current authority and membership invalidation. Reject duplicate grants, unknown fields/capabilities, invalid combinations, missing/ambiguous policies, and over-limit scopes. Sort canonical sets so equivalent input has one representation. A project grant never grants account-wide discovery, and a full-runtime preset expands to reviewed data-plane capabilities only.

Current parser limits are 100 explicit projects, 32 roots per viewer policy, and 64 KiB canonical scope. These do not themselves prove aggregate traffic or lifecycle budgets. Full runtime expands to `file:read`, `file:write`, `project:exec`, `project:read`, and `project:write`; it does not include management scopes. Read-only grants require viewer roots and protected-namespace exclusions; execution/write grants cannot claim directory confinement.

Rows with no `scope` retain their current meaning: account capabilities stay account-wide, and each existing project capability applies to each ID in the old allowlist. All evaluators consume the adapted canonical scope. No new mixed scope is flattened into the legacy columns. A service that does not understand scope version 1 rejects the key. Editing or deleting a key increments or invalidates its revision before any new derived credential is issued.

## Auth and lifecycle decisions

The account home bay is authoritative for key status. Project owning bay determines current membership; host bay issues host-bound access. A cached positive authorization expires at most 30 seconds after validation began, is clamped to credential expiry and placement generation, and is not extended by traffic or failure to refresh. Every new logical command requires admission. Continuous terminal, Jupyter, sync, preview, and proxy traffic loses credential-backed access within that bound after revocation; a detached process may continue under the established full-runtime trust model.

The derived host token is a distinct version accepted only by the narrow project-host verifier. Its signed claims or immutable server reference bind parent key ID/revision, owner, project, host and placement generation, exact capability set, viewer-policy hash, allowed service subjects/reply namespace, and expiry. It cannot authenticate on Hub/account subjects or fall back to ordinary account host-token behavior. Host migration requires a new exchange. An unavailable authority denies new admission and cannot extend existing sessions.

Managed issuance is bound server-side to `(human, native agent, source project, live run/turn, configuration ID+revision, key ID)`. Idempotency uses the whole verified tuple. Agent input cannot select another identity, run, configuration, or key. Manual keys use the same resource authorization and can be used by external clients. Management actions use separate scopes and the shared exact-action human approval path; selecting such a scope permits a request, never self-approval.

The first implemented management group is `api-key:revoke:request`, through `server/api/key-actions.ts`, `key-action-store.ts`, and `key-action-routing.ts`: request revocation of another manual key, then obtain an authoritative human fresh-auth decision at account home. Cross-bay backend validation and rendered keyboard rejection/approval under a dev-elevated session are recorded in the report. Interactive step-up and stale-review UI races remain unverified. Other management groups are future separately scoped API additions, not permanent exclusions for agents.

Hub sockets revalidate every 15 seconds with a 10-second fail-closed timeout. Live manual-key sockets through all three dev bays disconnected within 13.1 seconds of scope edits/deletion and 193 ms of expiry in the recorded fixtures. Established synthetic project subscriptions disconnected within 14.8 seconds of membership loss, even after membership restoration; this is not a load or outage bound. Host tokens require fresh authorization on renewal. The CLI uses a private credential file and source-project versus scoped-target routing without broader fallback. Notebook output and input recovery now have manual-key live evidence; this does not establish terminal/sync/preview/proxy or managed-turn parity. A copied bearer credential can still be used during its active lifetime; provenance identifies issuance context, not the process making every request.

## Delivery order and evidence

1. Prove list, per-project full/viewer grants, budgets, host exchange, and revocation with manually issued keys through raw API and the ordinary CLI.
2. Mount the shared editor in API Keys settings; verify round-trip, keyboard/focus, mobile width, light/dark theme, and revocation.
3. Add the single CoCalc connector as configuration plus trusted turn-key lifecycle. Repeat the manual-key authorization matrix with turn-issued keys.

Test all changes against source A, full B, viewer C, and absent D on different hosts/bays. For viewer C, cover traversal, symlinks, protected namespaces, special files, archives, snapshots, search, previews, and races. For managed keys, cover substitutions, renewal/crash/finalization, copied keys, and session revocation under continuous traffic. Keep the plan's proposed limits finite and adjust only with measured evidence.

## Open Completion Gates

### HTTP proxy implementation and remaining validation

Source audit at `1c715ca290` confirmed that full-runtime proxy/preview parity was
not implemented. `project-host/http-proxy-auth.ts` explicitly rejected API-key
child tokens; its regression test preserves that boundary. CLI
`project proxy curl` used `resolveProxyUrl` in `cli/src/bin/main.ts`, which
resolved hosts through account-level Hub calls, then used cookie-based HTTP
requests. Private-app bootstrap similarly calls the ordinary host-token issuer.
These are not supported scoped-key transports and cannot count as passing the
full-runtime acceptance matrix.

The existing 29 `http-proxy-auth.test.ts` cases pass at this audit. They prove
the current HTTP boundary, not successful scoped proxy use or live revocation.

The implementation must provide a distinct, explicitly scoped HTTP
exchange/admission path, not remove the existing child-token rejection. Bind
the parent key/revision, account, exact project/placement/host, requested HTTP
service target, and short expiry through the same authoritative key policy.
Executable app access requires runtime authority; a viewer grant must not gain
access to an arbitrary app merely because its responses are HTTP reads. Any
static preview support must enforce the viewer filesystem policy independently.

HTTP requests, indefinite responses, and upgraded sockets must all lose access
within the documented revocation bound, with no promotion into an ordinary
account session. CLI target resolution and authentication must use the selected
scoped credential without account-cookie or host-lookup fallback. Test isolated
manual-key clients first, including negative audience/target cases and continuous
stream revocation, then replay with managed keys. Existing rejection stays in
place until that end-to-end path is implemented and verified.

The first implementation step adds an opt-in signed HTTP token and separate
verifier in `conat/auth/project-host-token.ts`: `phat-http-v1`, audience
`project-host-http:<host>`, exact project and port, existing parent/revision and
placement binding, and the same 25-second parent-clamped lifetime. It requires
`project:exec`, not merely file read. Neither verifier accepts the other
transport's credential. Nineteen token tests and 64 existing host HTTP/Conat
tests passed; the Conat build passed. Those token primitives alone did not grant
usable proxy access.

At `84ff8908f2`, the public exchange accepts a validated exact HTTP port, checks
runtime authority before placement lookup, and uses the same account-home and
host-bay issuer. Host admission consumes a dedicated per-request header before
browser-cookie handling, verifies current local membership/placement, and does
not create cookies. Response/socket timers enforce signed expiry. CLI proxy URL
and curl use the selected manual/managed key, not broad host lookup or operator
cookies; URLs contain no credential, paths stay within the selected target, and
redirects are not followed. Focused endpoint, command, host, and build checks
pass. This is implementation evidence, not the live acceptance matrix.

Subsequent deployment and private review reached `b4f85a382a41`. The installed
ordinary CLI's scoped HTTP request and raw HTTP negative checks now pass on
the public test route. Independent review passed the buffered-body deadline,
mixed-credential stripping, and pre/post-header abort fixes. Live probes show
no-header requests terminate with a 502 and continuous streams terminate in
about 25 seconds, without waiting for the client's safety timeout. See the
validation report for exact builds, timings, and the earlier failed probes.
A further manual-key WebSocket upgrade/continuous-egress probe terminated
within 25 seconds, including app-side closure, after deletion during traffic.
Managed replay, bidirectional application recovery, authority outages,
private-app hostname bootstrap, and viewer static preview remain open gates.
Loopback deadline and late-timer regressions are not a production load bound.

### Remaining Gates

- Replay the full acceptance matrix with managed keys, including source loss, cancellation, process reuse, and crash expiry.
- Complete long-lived command-family parity and authority-outage validation; passing notebook cases cover only the recorded scenarios.
- Extend manual HTTP regrant and Hub subscription evidence to managed keys and project-host session families. At `a97d99800a`, explicit manual scope consent allocates a new issuance sequence; uncached authentication avoids stale revision mismatches. Disposable bay-0/bay-1 project tests through all three bays prove renewed scope access while restoration, name-only edits, and expiry edits retain denial. Automatic renewal must not revive revoked project authority.
- Exercise active account/host migration, directory faults, and clustered RPC-interest withdrawal, beyond empty-project rehome.
- Manual-key creation, scoped directory/lifetime reload and editing, all-projects defaults with explicit overrides, deletion, and rendered approval/rejection now have live browser evidence. Both shared editor surfaces passed the recorded dark-mode desktop/mobile and focused accessibility checks. Native 200% browser zoom, interactive step-up, stale-review UI races, and broader theme/state coverage remain open; see the report for exact boundaries.
- Audit aggregate resource budgets, historical upgrades, and remaining credential-handling failure paths.
- Obtain pinned independent review of transport follow-ups; accepted requests are not completed reviews.
