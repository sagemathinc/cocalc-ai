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
> permissions. When the turn ends, CoCalc revokes the key: new operations are
> denied, and ongoing credential-backed sessions lose access within the
> documented revocation bound. You can disconnect it or reduce its permissions
> at any time.

For example, one configuration can allow:

- Listing the human's projects, without reading their files.
- Full project runtime access to project B.
- Reading selected directories in project C, without writing or executing there.

The same configuration can be used when creating a manual API key. An agent
does not need a separate project-connection protocol or a special listing API.

Explain the trust boundary where the user enables the connector:

> Anyone who copies the temporary key from the agent's shared project can use
> it from elsewhere while it remains valid, with all the permissions and
> projects you selected. Information the agent reads may be saved in the shared
> project or conversation. Revocation does not undo copied data or changes, stop
> processes already launched, or invalidate independent credentials obtained
> through full project access.

This is a replayable bearer credential, not proof of which process or person
made a request. Agent/source attribution identifies the issuance context.
Environment delivery does not change that trust boundary. The per-resource
scope still applies: copying a key cannot turn read-only access to C into the
full access it has to B.

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

API-key management, collaborator/invite changes, public-share creation,
persistent access credentials, host/VM administration, and operations requiring
fresh auth are supported product directions, not forbidden agent activities.
Give each its own explicit API scope and human-in-the-loop approval contract,
then expose it in the same privilege editor. The initial project-runtime preset
does not implicitly include these management privileges.

Build the common approval contract into the design now; deliver these operation
families incrementally as ordinary API improvements. Existing supported API
capabilities must keep working. Completing every management workflow is not a
prerequisite for the initial list/full/viewer release.

Messaging reliability, Agent Network delivery, cross-human steering policy,
third-party connectors, and an unrelated general workflow engine are out of scope.
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
or mint broader credentials on its own.

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
expands to a documented, reviewed set of explicit capabilities. Define the
full-runtime preset by reviewed project data-plane
operations; management scopes and their human approvals are independent
selections. It is not a wildcard that automatically inherits future API methods.
`project:exec` already
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

### Derived credential confinement

Token exchange is a general API facility. The issuer derives the owner, target,
and effective permissions from the authenticated parent key and authoritative
routing/policy data. Client arguments may request a target or narrower scope;
they are not identity or authority. Each derived project-host credential must
cryptographically bind these values, directly or through an immutable,
server-validated reference:

- Parent key ID and scope/revocation revision.
- Owner account and exact target project.
- Target host identity and current placement/host generation.
- Exact effective capabilities and the hash of the canonical viewer policy,
  with an explicit unrestricted-policy value for a full runtime grant.
- Authorized project-host service subjects and a credential/session-specific
  reply-inbox namespace.
- Expiry no later than the parent's current expiry and any applicable
  authorization lease deadline.

Validators check the binding on requests and retained sessions. A caller cannot
substitute an owner, policy, project, host, service subject, or arbitrary reply
inbox. No fallback to broader filesystem subjects, ambient credentials, or
host-wide permissions is allowed. A derived host credential cannot authenticate
on ordinary Hub/account subjects; account API calls use the parent key and its
own scopes. Host migration invalidates old placement bindings and requires a
new ordinary exchange after current authority is checked.

Reuse the shared credential verifier, routing epochs, subject policy, and
session lifecycle. Extend them where needed for all scoped-key clients; do not
add agent-specific claims or authorization callbacks to this mechanism.

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

Treat every exposed route that can return project bytes as part of this shared
policy contract. Cover ordinary files, downloads/archives, snapshots and
backup/history reads, indexing/search, and previews. An unsupported route stays
unavailable to viewer keys until it enforces the same policy. Reject FIFOs,
sockets, and devices on ordinary file-read routes; prevent blocking special-file
reads. Reuse and test filesystem-boundary handling for overlapping roots,
protected namespaces, renames, and path replacement between checking and
opening a file. Document the shared service's actual concurrent-filesystem
guarantees without inventing an agent-only hostile-filesystem sandbox.

### Separately scoped, human-approved actions

The permission catalog distinguishes direct execution from permission to
request a human-approved action. API-key management, collaborator/invite
changes, public-share creation, persistent credential creation, host/VM
administration, and fresh-auth operations each require their own scope and
human approval. They are available directions for both agents and ordinary API
clients. No group is implicitly granted by **Full project access**.

A request goes through the common API/action and existing human UI:
the authenticated approving human sees the exact operation, target, arguments,
and effects. The server checks their current authority and required fresh auth,
binds approval to that action and requesting key/revision, and consumes it with
replay-safe execution. Changing the target, permissions, or arguments requires
new approval. At execution, recheck the approving human's authority, requesting
key/revision and scope, and required freshness. Expired/revoked requests cannot
execute. Reuse existing action
and fresh-auth infrastructure; showing a dialog or publishing a proposed-action
card alone is not approval. Scope permits requesting the action, not approving
it, automating its confirmation, or minting an unrestricted browser session.

For deletion, reuse the delete-project dialog including typing the project
name. For key creation or scope expansion, show the resulting privileges,
resources, lifetime, and intended credential recipient. A human may explicitly
authorize a new grant under their own authority, but ordinary token exchange
can never broaden its parent. Managed turn keys cannot edit or renew themselves
through a management scope, and approval does not silently enlarge an active
turn's connector configuration.

The API Keys page and connector use the same labels and approval indicators.
Deliver operation families incrementally, enabling a scope only when its
ordinary API and approval path are implemented and tested. This is a shared
authorization contract, not a separate approval system for agents.

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

The automatic issuer uses a trusted lifecycle authorization record bound to:

```text
(human, native agent, source project, run/turn,
 configuration ID + revision, issued key ID)
```

The account-home issuer derives this binding from authoritative configuration
and a server-owned live run record, or a verified attestation from the trusted
runtime controlling that record. It allocates the key ID and persists the
complete binding atomically with issuance. The worker authenticates as that
trusted runtime and supplies only a reference to its authorized turn; raw
IDs and a caller's claim to be a worker are insufficient. The issuer verifies
that runtime's current source assignment and live run authority; a host's general
control credential alone does not establish an authorized human turn. The agent
process never receives the issuer's signing or lifecycle-control credential.

Creation idempotency is scoped to the verified tuple before key allocation;
retries resolve to the one stored key ID and complete binding. Renewal verifies
that binding and the same live run lease. Lifecycle revocation verifies the
issuer's authority and binding but remains available after the run or lease
ends; ordinary human key revocation also remains available. Agent-controlled
code, ordinary API keys, and project data-plane credentials cannot nominate a
different human, agent, source, configuration, turn, or key. External agents
cannot use native ACP automatic issuance; they can still use manually issued
scoped keys through the ordinary API. This binding belongs only to the trusted
issuance adapter: target services validate ordinary keys and never query ACP.

Proposed lifecycle, using existing trusted turn hooks:

1. At turn start, verify the lifecycle binding above, current source/target
   access, and the saved configuration revision. Resolve the effective scope
   server-side and provision the ordinary key idempotently. Never accept an
   unrestricted scope requested by agent-controlled code.
2. Return one ordinary scoped key covering the selected privileges and projects.
   Supply it with the API URL and CLI instructions. Prefer the existing standard
   CLI credential environment contract. A stable opaque key with a renewable
   server-side expiry permits long turns without replacing an inherited value.
   If process reuse requires a credential provider/file, use the ordinary CLI
   mechanism; the shared-runtime disclosure applies to either transport.
3. The trusted worker renews a short lifetime while that turn remains active.
   Proposed default: five-minute expiry, renewed before expiration. Renewal
   rechecks the same live run lease, configuration revision, and membership;
   it cannot revive a revoked key or broaden scope. The managed lifecycle right
   belongs to the trusted runtime, independently of human-approved management
   operations supported by the API.
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

### Credential handling

Use the standard credential provider for manual and managed keys. CoCalc must
keep secrets out of process arguments, logs, telemetry, crash reports, notebook
output, diagnostics, and environment dumps that it generates. Redact known
credential fields at their common logging/diagnostic boundaries. Give the agent
instructions and tests that discourage printing secrets; do not claim that
CoCalc can prevent arbitrary code in a trusted shared project from disclosing a
bearer credential it can read.

If delivery uses a file, create its directory with restrictive permissions
(0700) and file with mode 0600, use atomic replacement and safe cleanup, and
handle process reuse without stale credentials. Remove files and unset local
references at finalization, while server-side revocation invalidates copied
values. Test supported providers and error/reporting paths for accidental
secret disclosure using synthetic credentials.

### Revocation is a shared API guarantee

Audit and, where necessary, implement key revocation for ordinary API clients
before using it for ACP. Removing a local file or ending renewal is insufficient
if a copied key or an exchanged host token remains usable.

Revocation succeeds when the authority durably invalidates the key/revision;
it is not a claim that every transport has already disconnected. Scope changes
and parent invalidation also invalidate derived credentials. Apply the following
contract to all scoped-key clients:

| Boundary                  | Required behavior                                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New operations            | Check authoritative key status and current target membership at admission. Work whose authorization preceded revocation may already be admitted. A socket login is not authorization for all future commands.                                                                                         |
| Cached authorization      | Maximum age 30 seconds from validation start, never extended by traffic, failed refresh, or a stale reply. Clamp freshness to credential expiry and routing/policy generation.                                                                                                                        |
| Retained interests        | On denial, expiry, invalidation, or freshness exhaustion, stop credential-backed input/output and remove subscriptions, pending RPC/reply interests, stream attachments, and registrations. Force detachment within the 30-second bound; check deadlines before forwarding after an event-loop stall. |
| Interactive sessions      | Terminal input/output, Jupyter messages/results, sync reads/writes, preview access, and HTTP/WebSocket proxies must pass the shared session gate. New commands are new admissions; continuous traffic cannot keep stale authorization alive. Reattach only with a currently authorized credential.    |
| Authority or host changes | An unavailable authority denies new admissions; an existing session has at most its remaining freshness interval. Host migration invalidates the old host/placement binding; exchange and reauthenticate against the current owner/host.                                                              |

The 30-second interval is a proposed maximum for retained session access, not
permission to cache arbitrary new command admissions for that duration. If a
transport cannot enforce this contract, do not expose it through a scoped key
until it can. Test invalidation with continuous traffic and unavailable
authorities. Ordinary key validation and session gating must not depend on
agent or chat runtime services.

When the human loses collaborator access to B, new operations against B fail
through B's normal authoritative access check and the affected key grant is
invalidated. Re-adding the human must not resurrect the old grant or key; use a
shared membership/grant revision or generic revocation integration. Phase 1
must choose the existing primitive to extend and document its multibay behavior.
Source access loss stops renewal and revokes turn keys through trusted lifecycle
management. API requests to B still use the same key checks as manual clients.

A bounded operation admitted before revocation may finish, but its response
delivery still obeys the session contract. An open terminal, kernel attachment,
sync session, streaming RPC, preview, or proxy is not one indefinitely admitted
operation. Revocation severs its credential-backed interaction even if the
underlying terminal process, kernel computation, or detached job remains alive.

Processes started in B, files changed, information copied, and external side
effects can outlast the key. Stronger offboarding may require B's existing
restart procedure. Full runtime authority can access other credentials in B;
revocation governs this API key and its derived credentials, not independent
authority acquired from B's environment. This accepted project-runtime risk
must not become a way to retain a revoked API session.

Record key issuance, scope changes, revocation, and denials with human and agent
attribution where applicable. Do not log secrets or promise a complete per-file
activity history. Expired turn-key housekeeping must not fill the user's manual
API-key list with permanent clutter; active automatic keys remain inspectable
and revocable.

## Shared Resource Budgets

Enforce limits in common API parsers, policy validation, admission, and streaming
services, before expensive work or large allocation. Manual and agent clients
share these limits. Automatic-key limits additionally bound trusted lifecycle
issuance. Reuse existing limiters and housekeeping; no separate agent quota
service is needed.

Proposed initial defaults, to validate against ordinary workloads in Phase 1:

| Resource            | Default ceiling                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope               | 100 projects, 32 literal directory roots per project, 64 KiB canonical scope; bounded request envelopes before JSON decoding.                                                                                                               |
| Project listing     | 500 rows and 2 MiB serialized data per page; return a continuation when the byte budget is reached. Never allocate the full result set before paging.                                                                                       |
| Search              | 200 characters, 16 terms, 5-second query deadline; 60 requests/minute per key and 300/minute per account, bursts 10 and 30 respectively. Use indexed/bounded queries.                                                                       |
| Buffered file reads | 8 MiB per response; larger files use authorized bounded streaming with at most 1 MiB application chunks and backpressure.                                                                                                                   |
| Archives/downloads  | Streaming/backpressure plus 256 MiB uncompressed archive budget and 10,000 entries per generated archive. Enforce declared/actual sizes; ordinary large-file streaming need not load the file into memory.                                  |
| Read concurrency    | 4 active read/download operations per key, 32 per account; reject excess admission rather than build unbounded queues.                                                                                                                      |
| Automatic keys      | One active key per verified turn/configuration binding, 64 per account; at most 60 new keys/minute per account with burst 10. Idempotent retries do not allocate new keys.                                                                  |
| Renewal             | Target once per 90 seconds; enforce at most 2 accepted renewals/minute per managed key. Five-minute expiry remains the crash backstop.                                                                                                      |
| Retention           | Purge expired/revoked automatic key verifier rows within 24 hours; retain secret-free lifecycle audit under the common audit policy, proposed 30-day default. Preserve required invalidation evidence until all derived credentials expire. |

Aggregate limits across instances/bays through existing authoritative services;
issuing additional keys must not bypass account budgets. Apply equivalent
budgets to alternate routes such as search, previews, and archives. Return
explicit size/rate/admission errors and retry information; do not silently
truncate scope or widen a policy. A deployment may tune these defaults based on
tests, but must record finite limits and the observable contract before release.
This is bounded API input/work handling, not a project-wide resource-isolation
redesign.

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
- Separately selectable management scopes marked **Requires your approval**,
  using the same common action UI and freshness rules for manual keys and agents.
  Selecting one permits requesting the action; it does not preapprove execution.
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
      exact child-token binding, lifecycle issuer authority, session revocation,
      membership invalidation, and shared resource budgets.
- [ ] Map management operation groups to separate API scopes and the existing
      human action/fresh-auth flow; identify the first shared approval integration.
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
- [ ] Apply the shared resource budgets and credential-redaction/provider rules.
- [ ] Integrate the common human-approval contract for the first separately scoped
      management operation; stage remaining groups as ordinary API additions,
      enabling each only after its approval path is verified.

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
      key service. Verify the full server-owned lifecycle binding, substitution
      rejection, idempotency, live-lease renewal, and external-agent denial.
      Exercise failure, cancellation, process reuse, and crash expiry.
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

| Scenario                   | Required evidence                                                                                                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List-only key              | Only documented owner-visible metadata is returned; files, execution, mutation, and collaborator enumeration require their own scopes.                                                                 |
| Search/response boundary   | Search uses declared fields; arbitrary state is not serialized; paging cannot cross accounts and obeys byte/query budgets.                                                                             |
| B full, C viewer, D absent | Full data-plane commands work in B; C reads obey its directories; C writes/exec and D operations fail through direct API and CLI.                                                                      |
| Delegation ceiling         | Full runtime does not implicitly grant management API scopes. Independently available credentials inside a full-access runtime remain a disclosed risk.                                                |
| Viewer filesystem          | Test traversal, escaping symlinks, prefix collisions, overlapping roots, protected namespaces, rename/path-replacement races, and FIFO/socket/device rejection.                                        |
| Alternate viewer routes    | Archives, downloads, snapshots, backup/history, search/indexing, and preview routes either enforce the same read policy and budgets or reject the key.                                                 |
| Derived token binding      | Parent ID/revision, owner, target project, host/placement generation, capabilities/policy hash, subjects/reply namespace, and expiry are checked; substitution fails.                                  |
| Derived token misuse       | Reject broader filesystem subjects, arbitrary inboxes, ordinary Hub/account subjects, stale host bindings after migration, and client-supplied identity/policy overrides.                              |
| Key end of life            | Revoked/expired/copied parent keys and derived tokens fail; stale replies and renewal races cannot revive them.                                                                                        |
| Long-lived sessions        | Revoke during continuous terminal, Jupyter, sync, preview, proxy, and streaming traffic; no credential-backed I/O or retained RPC interest survives the documented bound, including authority outages. |
| Persistent processes       | A detached process or kernel may remain after revocation, but the old API/session cannot interact with it. A fresh authorized key is required to reattach.                                             |
| Lost membership            | Removal/downgrade denies B access; re-addition cannot revive the old grant; source loss stops managed authority.                                                                                       |
| Automatic issuance         | Reject account/agent/source/configuration/run/key substitutions, stale config revisions, expired run leases, and external-agent use of native issuance. Ordinary manual-key clients still work.        |
| Turn lifecycle             | Completion/error/cancel revoke; crashed worker expires; concurrent issuance is idempotent and renewal cannot revive a finished turn; another human gets their own key/configuration.                   |
| Edited consent             | Reduction/disconnection invalidates active authority; expansion applies on a new turn. Scoped management requests cannot self-approve changes.                                                         |
| Multiple bays/hosts        | Account/project/host ownership routes correctly; stale directories, old placement generations, and unavailable authorities cannot extend authorization freshness.                                      |
| Ordinary CLI parity        | Manual keys pass all advertised project command families before ACP integration; exact-target routing does not require unrelated account-wide scope.                                                   |
| Human-approved management  | For each enabled group, verify separate scope, authoritative human approval, exact arguments/target, required fresh auth, expiry and replay protection. CLI and agents use the same action path.       |
| Resource limits            | Over-limit scopes are rejected unchanged; pagination, streams, query cost, issuance/renewal races, multi-key aggregate load, and expired-key cleanup remain bounded across instances.                  |
| Credential handling        | Synthetic secrets stay out of arguments and CoCalc-generated logs, diagnostics, notebook responses, and crash/telemetry paths; provider permissions, atomic updates, and cleanup are verified.         |
| Shared editor              | Both entry points round-trip identical scope and approval semantics; keyboard/theme tests cover wrappers without widening on edit/migration.                                                           |

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
