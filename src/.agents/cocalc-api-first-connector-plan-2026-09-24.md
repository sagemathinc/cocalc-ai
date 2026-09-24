# API-First CoCalc Connector and Shared API-Key Permissions

Date: 2026-09-24
Status: proposal for review; this PR contains a plan only

## Decision

Build one **CoCalc connector** using ordinary account-owned, scoped CoCalc API
keys. Improve the API and API-key system first. Agents then use the same CLI,
API operations, permission checks, and credential lifecycle as other clients.

Use one shared privilege editor in both **Account settings > API Keys** and the
**CoCalc connector**. Scope selection, project selection, directory rules,
validation, and permission summaries must come from the same components and
contract. Only the surrounding credential lifecycle differs.

Start implementation from a fresh branch and PR. Reuse useful UI components
and tests from earlier connector work selectively. This plan replaces separate
project-access and account-project-listing connectors with one CoCalc connector
backed by shared API permissions. Do not ship overlapping connector choices.

Success is a general API improvement, even if it requires more work than the
specialized implementations. Every new delegated capability should be useful
to an ordinary API client before an agent receives it.

## The Model Users See

> Connect CoCalc to this agent. Choose what it can do and which projects it can
> access. Each time you run the agent, it gets a temporary API key with these
> permissions. CoCalc revokes that key when the turn ends. You can disconnect it
> or reduce its permissions at any time.

For example, one configuration can allow:

- Listing the human's projects, without reading their files.
- Full project runtime access to project B.
- Reading selected directories in project C, without writing or executing there.

The same configuration can be used when creating a manual API key. An agent
does not need a separate project-connection protocol or a special listing API.

Explain the trust boundary where the user enables the connector:

> Processes and collaborators in the agent's project may be able to use its
> temporary key while your turn is active. Information the agent reads may be
> saved in the shared project or conversation. Revoking access does not undo
> changes or stop work already started in another project.

Full runtime access includes code execution and the resulting access to project
files, credentials, and network. It is the existing project-runtime trust model.
Viewer access uses the shared read-only project policy. Do not suggest that a
viewer restriction protects data from a different, broader credential already
available in the source project.

## Initial Scope

The replacement must provide the useful behavior of both existing connectors:

1. Account project discovery through ordinary `cocalc project list`.
2. Full runtime access to explicitly selected projects, including files,
   execution, terminals, Jupyter, and other advertised project-local CLI APIs.
3. Read-only file access to selected projects, with whole-project or explicit
   directory restrictions, available to manual API keys as well as agents.
4. The shared privilege editor and per-turn credential provisioning.

For this release, require the issuing human to be an owner or full collaborator
on each explicitly selected target project, including for a read-only key. The
human must also remain a full collaborator on the agent's source project. Listing
projects follows the ordinary account-visible project-list contract; visibility
alone does not grant file or runtime access.

Later additions such as project creation, collaborator information, VM
management, and human-confirmed deletion are API work followed by exposing the
supported privileges in the shared editor. Existing supported API capabilities
must keep working, but completing those additional product workflows is not a
prerequisite for this release.

Messaging reliability, Agent Network delivery, cross-human steering policy,
third-party connectors, and a general workflow/approval engine are out of scope.
Keep the existing rejection of cross-human steering. Fine-grained write-without-
execute policies should be developed in the shared human/API model later.

## Existing Foundations and Gaps

The existing [account-key contract](scoped-account-api-keys-contract.md) already
chooses one account-owned key model. Preserve that decision; do not introduce
another project-owned or agent-only key species. Historical audit documents
describe past decisions, not proof of the current implementation's security.

| Area                         | Existing implementation to inspect/reuse                                                                                                 | Work required                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Key storage and management   | `packages/server/api/manage.ts`, `packages/util/db-schema/api-keys.ts`                                                                   | Extend scope representation and shared lifecycle; retain hashed secrets and account ownership.            |
| Capability evaluation        | `packages/server/api/api-key-scope.ts`                                                                                                   | Preserve privileges per target; share validation and evaluation.                                          |
| HTTP and Conat authorization | `packages/server/api/http-api-key-policy.ts`, `packages/server/conat/socketio/auth.ts`, Hub dispatch                                     | Carry the authenticated key principal through supported transports; enforce equivalent endpoint policies. |
| Host credentials             | `packages/conat/auth/project-host-token.ts`, `packages/server/conat/api/hosts-connection-auth.ts`, `packages/project-host/conat-auth.ts` | Preserve parent key scope and revocation through exchange and established sessions.                       |
| Account-home key directory   | `packages/server/inter-bay/accounts.ts` and existing key lookup                                                                          | Preserve ownership, revisions, expiration, and revocation across bays.                                    |
| Project discovery            | `packages/server/projects/list-account-window.ts`, `packages/database/postgres/account-project-index.ts`, ordinary CLI project commands  | Define and enforce the standard `project:list` response/search contract.                                  |
| Viewer files                 | `packages/util/project-access.ts`, existing viewer filesystem service                                                                    | Accept the general key's read policy without changing the human's collaborator role.                      |
| API-key UI                   | `packages/frontend/components/api-keys.tsx`, `packages/frontend/account/settings/api-keys.tsx`                                           | Extract and improve a reusable scope editor.                                                              |
| Project selection            | `packages/frontend/projects/select-project.tsx`                                                                                          | Reuse the existing selector and relevant improvements from the prior PR.                                  |
| ACP lifecycle                | `packages/project-host/codex/codex-project.ts`, ACP turn start/finalization                                                              | Request, deliver, renew, and revoke ordinary scoped keys.                                                 |

The current capability vocabulary includes `project:list`, but that alone does
not establish that the ordinary CLI can use it across every transport. Current
HTTP Hub API-key support is an explicit small allowlist; websocket Hub/account
RPC access has separate restrictions. Preserve default denial while adding the
specific supported paths. Do not enable broad account RPC access merely because
the key authenticates as an account.

## Shared Permission Contract

### Resource-specific grants

An account owns the key. Authorization combines its explicit scope with the
account's current authority and the operation's normal rules. A key cannot
create authority its owner lacks, become a browser session, satisfy fresh auth,
or mint broader credentials.

Use a versioned, canonical scope representation that distinguishes account-wide
capabilities from per-project grants. Illustrative shape, not final field names:

```ts
type ApiKeyScope = {
  version: 1;
  account: ApiKeyCapability[]; // e.g. project:list
  projects: Array<{
    project_id: string;
    capabilities: ApiKeyCapability[];
    viewer_read_policy?: ProjectViewerReadPolicy;
  }>;
};
```

Capabilities on B never apply to C. The key's account capability list cannot
contain project-runtime privileges. A project grant cannot contain account-wide
privileges. Reject invalid combinations, unknown privileges, duplicate ambiguous
grants, and policies that cannot be enforced. Empty or malformed scope never
means unrestricted access.

Build on the existing vocabulary. A UI preset such as **Full project access**
expands to a documented, reviewed set of explicit capabilities. It is not a
wildcard that automatically inherits future API methods. `project:exec` already
implies broad runtime authority; do not claim that directory restrictions still
confine that runtime. First support useful full-runtime and read-only presets;
only expose finer combinations after their shared API semantics are verified.

Old `capabilities` plus `allowed_project_ids` keys must retain exactly their old
meaning: project capabilities apply to each previously allowed project. Add a
deterministic adapter/migration and one canonical evaluator. Never flatten a new
mixed-permission scope back into a union of capabilities and projects. Older
services that cannot interpret the new representation must deny it.

### One capability catalog and policy implementation

Share capability identifiers, labels, explanations, target requirements, and
supported combinations between the API-key UI, connector UI, CLI help, and
server validation. Server policy still enforces authorization independently of
what the UI offers. Add explicit endpoint-to-capability mappings for supported
operations; unclassified methods remain denied.

Preserve `auth_method=api_key`, key ID/revision, owner, and effective scope through
HTTP, Conat dispatch, inter-bay forwarding, and project-host token exchange.
Client-supplied account IDs, scopes, or attribution cannot replace authenticated
principal data. Derived credentials must be no broader than their parent and
remain invalidatable through that parent. Agent provenance is attribution, not
a second permission evaluator.

### Project-list contract

Define a useful, explicit response for `project:list` in the ordinary API. A
reasonable initial projection is project ID, title, description, scalar state,
and last-edited time. Review the final field set as a product/API contract before
implementation. Do not serialize arbitrary database rows or raw state JSON.

Search should initially match the documented returned text fields. Filtering
must not silently reveal otherwise ungranted descriptions, labels, internal
state, or collaborator information through whether a project matches. Document
pagination and hidden/deleted-project semantics consistently for human API and
agent callers. Project IDs remain machine identifiers; UI summaries use titles.

Listing grants no file access, execution, collaborator enumeration, or project
mutation. Exact target metadata needed to route a permitted project operation
must be available under that project's grant without forcing the user to grant
account-wide project discovery.

### Directory restrictions

Implement directory restrictions as general read-only API-key permissions.
Reuse `ProjectViewerReadPolicy` and the viewer service's filesystem enforcement,
including its shared exclusions and canonical-path handling. The effective
credential policy narrows the account's authority; do not change the account's
role in the project to obtain viewer behavior.

The editor offers whole project or specific directories; the latter accepts
literal project-home-relative roots. Test traversal, symlink escape, boundary
prefixes, listings, reads, downloads, and any other exposed read operation at
the server. Execution, writable sync sessions, terminals, notebook execution,
and other broader services must remain unavailable to read-only keys. Do not
add a second filesystem service or make a CLI check the security boundary.

### Human-confirmed actions

Possessing a key never satisfies a human confirmation or fresh-auth requirement.
Project deletion remains unavailable through the initial delegated scope.
Later, an ordinary API client may request the existing delete-project UI; the
human must inspect the exact target and complete its confirmation, including
typing the project name. Execution and authorization must be bound to that
action. Showing a dialog or publishing a proposed-action card is not approval.

Keep this behavior in the common API/action infrastructure. Do not grant agents
a bypass or expand this PR into implementing all future approval workflows.

## Credential Lifecycle and Security Model

### Manual credentials and turn credentials

Both are account-owned API keys with the same scope and authorization behavior.
A manual key has the user's chosen lifetime. A turn key additionally has managed
expiry, lifecycle metadata, and agent/source/turn attribution. Those fields are
useful for management and audit, not separate permission semantics.

Store the connector's saved configuration per initiating human, agent, and
source project. Store its canonical scope and revision, never a reusable human
key. Another human running the same agent uses their own configuration. Normal
authenticated human APIs control configuration; a runtime key cannot enable or
broaden its own saved scope.

Proposed lifecycle, using existing trusted turn hooks:

1. At turn start, the trusted worker requests a key using authenticated turn
   context and the saved configuration reference. The account-home issuer
   verifies that context and current source/target access, and resolves scope
   itself. Never accept an unrestricted scope requested by agent-controlled
   code. Repeated startup requests are idempotent for that turn.
2. Return one ordinary scoped key covering the selected privileges and projects.
   Supply it with the API URL and CLI instructions. Prefer the existing standard
   CLI credential environment contract. A stable opaque key with a renewable
   server-side expiry permits long turns without replacing an inherited value.
   If process reuse requires a credential provider/file, use the ordinary CLI
   mechanism; the shared-runtime disclosure applies to either transport.
3. The trusted worker renews a short lifetime while that turn remains active.
   Proposed default: five-minute expiry, renewed before expiration. Renewal
   rechecks configuration and membership and cannot revive a revoked key or
   broaden scope. The agent receives no credential-management or renewal right.
4. Success, failure, cancellation, or turn replacement revokes the key through
   the standard key-management service. Stop renewal, discard local copies, and
   revoke derived credentials/sessions. A worker crash leaves at most the
   remaining short lifetime. Concurrent finalization and renewal must be safe.
5. A later turn receives a fresh key. Reusing an ACP process must not reuse the
   previous human's credential. Configuration reductions/disconnection revoke
   affected active keys. Configuration increases apply on a new turn, not by
   silently broadening an existing key.

Scope provisioning errors must be visible. Never fall back to a stored human
login, a broader API profile, another human's key, or another project's bearer.
The agent's existing local-project authority is independent of the connector;
viewer access to B does not reduce its ordinary access inside A.

### Revocation is a shared API guarantee

Audit and, where necessary, implement key revocation for ordinary API clients
before using it for ACP. Removing a local file or ending renewal is insufficient
if a copied key or an exchanged host token remains usable.

The initial implementation should check authoritative key status and current
target membership when admitting a new logical operation. Do not assume that
authenticating a socket once is sufficient. Revoke both the parent key and its
derived access; scope edits invalidate older revisions. Existing subscriptions
and streams need a bounded revalidation/disconnection policy. Proposed bound:
no more than 30 seconds of cached authorization, measured from the start of its
validation, and fail closed when freshness cannot be established. Document and
test the actual bound before release; do not claim instantaneous global teardown.
Ordinary key validation must not depend on agent or chat runtime services.

When the human loses collaborator access to B, new operations against B fail
through B's normal authoritative access check and the affected key grant is
invalidated. Re-adding the human must not resurrect the old grant or key; use a
shared membership/grant revision or generic revocation integration. Phase 1
must choose the existing primitive to extend and document its multibay behavior.
Source access loss stops renewal and revokes turn keys through trusted lifecycle
management. API requests to B still use the same key checks as manual clients.

Already admitted operations may finish. Processes started in B, files changed,
information copied, and external side effects can outlast the key. Stronger
offboarding may require B's existing restart procedure. Full runtime authority
can access other credentials in B; revocation governs this API key and its
derived credentials, not independent authority acquired from B's environment.
This is an accepted consequence of the existing project trust model.

Record key issuance, scope changes, revocation, and denials with human and agent
attribution where applicable. Do not log secrets or promise a complete per-file
activity history. Expired turn-key housekeeping must not fill the user's manual
API-key list with permanent clutter; active automatic keys remain inspectable
and revocable.

## Ownership and Routing

Follow [the scalable architecture](scalable-architecture.md): Launchpad is the
one-bay case of the same system.

- The account's home bay owns key configuration, key lifecycle, and the saved
  connector scope. Reuse the cluster key directory for lookup and routing, with
  explicit scope/revision/expiry semantics; a stale directory entry cannot
  authorize a revoked key indefinitely.
- The target project's owning bay determines project membership and policy.
  The host's bay authorizes host-scoped credential issuance. A source project,
  target project, account home, and target host may all have different owners.
- Hosts enforce the narrowed credential and viewer policy. Files, terminals,
  Jupyter, and other steady-state data flow directly to project hosts. Hubs
  handle authorization and routing, not a new cross-project file proxy.
- Generic key references use stable project IDs. Test host moves and account/
  project rehome with the existing ownership machinery; do not add connector
  records to each project's database that create new rehome dependencies.

## One Shared Privilege Editor

Extract a controlled `ApiKeyScopeEditor` plus a shared scope summary. Both the
API Keys page and connector configuration pass the same canonical scope to it.
Use the same capability catalog, validation, project picker, presets, and
directory controls. Do not maintain two forms that merely look similar.

The common editor should provide:

- Account privileges such as **List my projects**, grouped separately from
  per-project access and clearly stating the metadata exposed.
- Project rows selected with the existing `SelectProject` component, showing
  titles without UUIDs and supporting its existing hidden-project behavior.
- Per-project presets for full runtime access and read-only files, with the
  actual supported API privileges summarized. No wildcard or implicit future
  privileges.
- For read-only access, whole project versus specific directories. Show the
  directory textarea only in the latter mode. Explain shared viewer exclusions
  near the control.
- A compact summary of the resulting scope, clear unavailable-project errors,
  and no silent loss or widening of permissions when editing existing keys.

The API Keys wrapper adds key name, expiry, creation/rotation/revocation, and
one-time secret display. The connector wrapper adds the owning human/agent,
saved enablement, and automatic turn lifetime. Both use the existing human auth
and fresh-auth requirements for credential/permission management.

The composer shows one CoCalc connector. Clicking it opens a small popover with
the selected privileges/projects and an Edit action. Editing opens the shared
scope editor. Put longer trust and lifecycle explanations in an accessible help
popover; keep the essential permission summary visible before saving.

Use existing Ant Design controls and icon conventions, `UI_COLORS`, and the
shared keyboard/overlay helpers. Cover light/dark mode, narrow layouts, 200%
zoom, labels, keyboard editing, Escape dismissal, and focus restoration as
specified in [accessibility guidance](accessibility.md).

## Implementation Sequence

Each phase delivers a reviewable change. The API must be independently usable
before adding the connector. Checked boxes below will mean verified evidence,
not merely code written.

### Phase 1: Audit and finalize the shared contract

- [ ] Trace manual-key issuance, authentication, scope checks, host exchange,
      expiry, deletion, cached sessions, and ownership routing on the chosen
      implementation baseline. Read `SECURITY.md` before investigating findings.
- [ ] Inventory ordinary CLI operations needed by full/viewer/list access and
      the API methods/transports they use; identify unsupported paths explicitly.
- [ ] Finalize canonical scope, legacy interpretation, project-list fields/search,
      membership invalidation, and the revocation/stream freshness contract.
- [ ] Keep any issues affecting released code in the prescribed private workflow.
      Separate reusable security prerequisites from connector feature code.

Exit: reviewed API contract and a small implementation map; no new connector API.

### Phase 2: General API keys and ordinary CLI

- [ ] Implement shared scope schema, normalization, management, capability catalog,
      and migration/adapter; propagate principal data through supported transports.
- [ ] Enable the standard project-list operation for `project:list`, with the
      same DTO and search policy regardless of human/manual-key/agent client.
- [ ] Make scoped keys work through normal project routing and host credential
      exchange. Preserve scope, parent identity, revocation, and current authority.
- [ ] Add generic viewer-directory policy to manual keys using the existing viewer
      service. Verify full runtime parity for the advertised ordinary CLI commands.
- [ ] Implement and verify shared revocation, expiry, scope edits, membership loss,
      derived-token invalidation, established sockets, and multibay behavior.

Exit: using manually issued keys, ordinary CLI/API clients pass the acceptance
matrix below with agent mode disabled. No dependency on named-agent registration,
Agent Networks, or an active ACP run is needed to use a manual key.

### Phase 3: Shared editor in API Keys settings

- [ ] Extract the common editor/summary and mount it in the existing API Keys UI.
- [ ] Implement per-project privilege editing, directory modes, familiar project
      selection, and explicit lifetime management around the shared editor.
- [ ] Verify creation, editing, reload/round-trip, revocation, keyboard/focus flows,
      responsive layout, and themes; run frontend lint and relevant checks.

Exit: humans can configure and use the API feature without an agent connector.

### Phase 4: Thin CoCalc connector and ACP lifecycle

- [ ] Store human/agent/source configuration as a reference to the shared scope.
- [ ] Reuse the same editor and summary in the single CoCalc connector UI.
- [ ] Add trusted turn issuance, renewal, and finalization hooks using the shared
      key service. Exercise failure, cancellation, process reuse, and crash expiry.
- [ ] Supply standard CLI credentials/instructions and prohibit silent credential
      fallback. No agent-only project-list endpoint, filesystem RPC, or B-access
      command tree should be required.
- [ ] Replay the API acceptance matrix with turn-issued keys; only lifecycle and
      attribution should differ from the manually issued keys.

Exit: the connector contributes configuration, instructions, and lifecycle
integration; all resource authorization belongs to ordinary API-key policy.

### Phase 5: Review, rollout, and replacement

- [ ] Obtain independent security review of generic scope/transport/revocation
      changes and the thin trusted issuance integration at a pinned commit.
- [ ] Perform live disposable-project tests across distinct hosts and bays,
      including a long turn spanning multiple renewals and membership removal.
- [ ] Record build/upgrade order for DB schema, hubs, hosts, CLI, and frontend.
      Unsupported older services deny new scope versions; the connector stays
      unavailable until the required services support it.
- [ ] Verify rollback: disable new issuance, revoke active managed keys, preserve
      existing manual-key semantics, and avoid destructive schema rollback.
- [ ] Retire the superseded connector choices in the eventual release. Convert
      isolated-development saved configurations only through an explicit scope
      mapping and human review; do not silently transfer consent to wider scopes.

## Acceptance Matrix

Run capability tests through raw API requests as well as the CLI. CLI output
filtering and UI validation are not enforcement. Repeat relevant cases with
manual and turn-issued keys using the same test helpers.

| Scenario                   | Required evidence                                                                                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List-only key              | Lists only the owner's visible project metadata under the documented contract; cannot read files, execute, mutate, or enumerate collaborators.                        |
| Search/response boundary   | Search does not consult undeclared private fields; response shaping rejects arbitrary extra state; paging cannot cross accounts.                                      |
| B full, C viewer, D absent | Full commands work only in B; C reads obey its directories; C writes/exec and every D operation fail, including direct RPC attempts.                                  |
| Viewer files               | Existing readable content succeeds; path traversal, escaping symlinks, prefix collisions, protected namespaces, and alternate service paths obey shared viewer rules. |
| Token exchange             | No broader child scope or later effective lifetime; wrong project, host, owner, audience, or scope revision fails.                                                    |
| Key end of life            | Revoked/expired/copied keys and exchanged tokens fail; established sockets and subscriptions obey the documented revocation bound.                                    |
| Lost membership            | Removal/downgrade in B denies access; re-addition cannot revive an old grant; retained processes are documented separately from credential access.                    |
| Turn lifecycle             | Success/error/cancel revoke; crashed worker expires; late renewal cannot revive; a new human or turn gets a fresh key and their own configuration.                    |
| Edited consent             | Disconnection/reduction invalidates active authority; expansion requires a later turn; source-access loss stops managed authority.                                    |
| Multiple bays/hosts        | Account home, A, B, and host ownership are correctly routed; stale routes/directory entries and unavailable authorities cannot create extra permission.               |
| Ordinary CLI parity        | Files, exec, terminal, Jupyter, and explicitly advertised APIs work through normal commands with manual keys first; target resolution needs no unrelated broad scope. |
| Human-confirmed operations | A key cannot bypass existing fresh-auth/delete confirmation or self-approve a request.                                                                                |
| Shared editor              | Both entry points round-trip the identical scope; keyboard and theme tests cover both wrappers, with no accidental widening on edit/migration.                        |

Use focused util, server/database integration, Conat, project-host, CLI, and
frontend suites according to the changed modules. Run relevant typechecks and
`pnpm -C src lint:frontend` for interactive changes. Build dependencies before
tests in a fresh worktree. At release, perform the full development build and
live validations; unit tests alone are not a substitute for transport and
credential lifecycle evidence.

## Reuse and Branch Strategy

This documentation PR starts from public main and changes only this plan.
Implement on a fresh branch from the agreed main baseline, incorporating
reviewed, reusable infrastructure as needed. Existing implementation work can
provide reference material without becoming a dependency. Handle any future
security findings according to `SECURITY.md`.

Reuse selectively:

- Project selector improvements, compact connector popover, accessible dialogs,
  directory controls, and useful trust copy, adapted into the shared editor.
- Existing viewer policy/service improvements that help human and API access.
- Existing credential and session-lifecycle infrastructure that is independently
  applicable and reviewed.
- Test scenarios for full/viewer parity, membership loss, copied credentials,
  multi-host/multibay routing, turn completion, and persistent jobs.

Keep key scope, validation, revocation, and resource authorization in the shared
API infrastructure. Connector code should configure scope and manage its turn
lifetime. Existing code qualifies for reuse only when it fits that division of
responsibility and is useful to ordinary API clients.

The implementation PR description should explain the resulting shared API and
UI behavior and attach new validation evidence. Prior review and successful
tests are useful inputs, but do not certify the redesigned implementation.
