# Agent Connections: Implementation And Security Plan

Date: 2026-09-19

Status: proposal for discussion, not an implementation or security signoff.

## 1. Product Goal

Make a named CoCalc agent useful across the user's actual working environment:
mail, calendars, documents, repositories, browsers, MCP tools, and other CoCalc
projects. Setup should normally happen in the Agents UI, not by discovering CLI
flags, managing callback servers, or putting credentials in project files.

The product promise is:

> Connect a service once. Choose which agents may use it, for what, and for how
> long. See their activity and stop their access from one place.

Connecting Google for sign-in does not authorize reading Gmail. Connecting Gmail
to an account does not authorize every agent. Mentioning a connection does not
grant access. Membership in an Agent Session does not share credentials or
connection permissions.

All seven requested capabilities are in this roadmap. They do not need to ship
simultaneously. Deliver complete, useful vertical slices on a common foundation
rather than a catalog of partially functioning integrations.

## 2. Recommended Decisions

1. Use two main user-facing concepts: **Connections** on the account and **Access**
   on each agent. OAuth credentials, leases, brokers, and capability tokens are
   implementation details.
2. Authorize the intersection of account, stable agent identity, active execution,
   connection, operation, and resource. Never authorize by display name alone.
3. Keep provider credentials out of ordinary project files, project environment
   variables, chat, TimeTravel, snapshots, and project backups.
4. Prefer typed, mediated operations. A Google API connection, a remote MCP
   server, and a fully controlled browser have different security properties;
   do not advertise identical guarantees.
5. Make private per-agent authority real before advertising it. Shared project
   secrets and a private-looking token file under the same Unix user are not
   sufficient isolation. Explicit shared-project access is an acceptable,
   useful first step; do not require perfect isolation to ship improvements.
6. Use existing account-home-bay and project-owning-bay routing. Keep sustained
   file, process, and browser traffic off the hub.
7. Default to read access where meaningful. Offer useful standing write access
   explicitly; do not interrupt users for every routine read or approved write.
8. Separate approval to acquire authority from confirmation of a particular
   external action. Fresh authentication is not a synonym for either.
9. Implement GitHub with a GitHub App first, Google with separate API consent,
   MCP with a guided compatibility-aware wizard, and browsers with dedicated
   profiles and visible control state.
10. Support self-hosting without requiring a CoCalc-operated credential service.
    Operators supply provider registrations and encryption keys where required.

## 3. Existing Foundation And Its Limits

These are concrete reuse points, not claims that connectors already exist:

| Foundation                                                                                                | Reuse                                                                 | Important limit                                                                           |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| [Named agents and Sessions](../packages/conat/agents/personal.ts)                                         | Stable endpoints, account ownership, proposals, pause patterns        | Messaging membership is not connector authority                                           |
| [Agent RPC](../packages/server/agents/rpc.ts) and [ACP](../packages/lite/hub/acp/agent-rpc-service.ts)    | Source execution identity, routing, asynchronous authorization checks | Do not turn a messaging permit into a general service credential                          |
| [Google OIDC](../packages/server/auth/sso/google-oidc.ts)                                                 | Provider configuration, state-validation experience, account linking  | Login consent is not Gmail/Calendar/Drive consent                                         |
| [Project secrets](../packages/server/projects/project-secrets.ts)                                         | Encryption/key lifecycle patterns, refresh and rotation experience    | These secrets are intentionally readable by project code, not private to an agent         |
| [Host tokens](../packages/conat/auth/project-host-token.ts)                                               | Signed, audience-bound host admission                                 | Existing account/host tokens are not automatically narrow enough for connector operations |
| [Conat files](../packages/conat/files/fs.ts) and [execution jobs](../packages/conat/project/exec-jobs.ts) | Existing data paths and CLI behavior                                  | Audit every operation before exposing it to a narrower principal                          |
| [Blit launcher](../packages/frontend/frame-editors/x11-editor/blit-app.ts)                                | Wayland/Xwayland graphical applications and lifecycle UX              | The existing project desktop is collaborator-shared, not an account-private browser       |
| [Remote Jupyter design](remote-jupyter-kernels-plan-2026-09-09.md)                                        | Reflect forwarding, readiness, reconnection and lifecycle experience  | Kernel forwarding is not browser authorization; desktop attachment reverses the direction |

Follow [scalable architecture](scalable-architecture.md) and
[accessibility requirements](accessibility.md). Reuse implementation where its
trust boundary fits; avoid mechanically reusing broad credentials or proxies.

## 4. User Experience

### Account Connections

The account menu opens **Connections**. Each connection shows provider, a useful
name such as "Work Google", the remote account/tenant, health, connected agents,
last activity, and Disconnect. Multiple accounts from one provider are supported.

The add flow offers Google, GitHub, Browser, CoCalc Project, and MCP Server.
Technical configuration is behind an Advanced section, not required for curated
connectors. Never ask users to paste credentials into chat. API keys, where
unavoidable, use a dedicated secret input and are not shown again after saving.

Disconnect blocks new use immediately, invalidates grants/leases, terminates
controlled sessions, and attempts provider revocation where supported. Distinguish
"access stopped in CoCalc" from "provider revocation still pending". Do not
accidentally disconnect Google sign-in when removing a Google data connection.

### Agent Access

Every agent has an **Access** panel listing its connections and precise limits:

```text
@assistant
  Work Gmail      Read mail; ask before sending
  Work Calendar   Read; create events after confirmation
  Reports Drive   Read selected files
  GitHub          acme/reports: read code, create pull requests
  Analysis data   Project Q /datasets: read
  Browser         Work research profile; full browser control
```

Grant flow: select connection, select resources, select capabilities, select
duration, inspect plain-language summary, confirm. Default duration is persistent
until revoked for ordinary saved connections; offer "This run only" and expiry
without forcing repeated setup. Browser-device attachment has its own shorter
availability lease. Clearly show whether a grant is usable now or requires login,
an online device, runtime isolation, or provider approval.

A grant is owned by the human account, not every collaborator on the agent's
project. Another collaborator running the same thread does not automatically
receive a grant. In shared-project runtime mode, however, code in that project
may exercise an already active capability; the warning below takes precedence
over any impression of per-agent isolation. Agent rename preserves identity;
cloning a thread/project or recreating an agent does not inherit access. Agent
retirement disables its grants.

### The @ Picker

Use searchable groups: **Agents**, **People**, **Connections**, and the existing
file/artifact references where appropriate. Search may span groups, with compact
recent results; users should not have to navigate nested menus for every mention.
Keep "Add connection..." available without filling the picker with unconfigured
tools. Distinguish account-connected from granted-to-this-agent results.

Selecting an unavailable connection opens the grant/setup wizard, then returns
to the draft. A reference chip carries a typed opaque reference, not credentials.
The server resolves it against current access at submission and execution.
Pasting a chip or an `@name` never creates authority.

### Agent-Initiated Requests

An agent may propose "Allow @researcher to read these Drive files". Only a
human-controlled typed approval flow can grant it. Bind approval to the account,
agent identity, connection, exact resources, capabilities, duration and current
policy version. Changes require a new proposal. Apply TTLs and request limits.

Do not treat a tool response, peer message, webpage, generic chat reply, or
agent-controlled browser click as a human authorization event. Human-only
connection settings must reject agent provenance, including browser automation.

## 5. Security Model: What We Can Actually Promise

### Improve The Real Baseline; Do Not Promise Magic

The practical baseline is often two people sharing one account or putting a
long-lived provider token in a project. Separate account connections, bounded
grants, short-lived capabilities, encrypted credential storage, revocation and
clear activity can improve that substantially without solving every isolation
problem first.

Keep the effective execution boundary visible in the grant summary:

| Execution boundary             | Honest guarantee                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Shared project runtime         | Configured for the selected agent, but available authority may be exercised by other code/collaborators in that runtime |
| Protected mediated tools       | Only the protected driver receives the connector channel; ordinary project code has no direct access to it              |
| Isolated connector-enabled CLI | The authorized execution compartment, not the whole project, receives the CLI capability                                |

Shared-project mode is an explicit human choice, not an invisible fallback. Show:

> This connection is configured for @agent, but any code with access to this
> project's runtime may be able to use its active access. Only enable this in a
> project whose collaborators and code you trust.

Allow this mode for an initial useful release. Keep provider refresh tokens in
the broker and expose only short-lived, revocable, narrowly scoped capabilities.
This protects persistent credentials and limits authority even though it does
not isolate agents. Attribute requests to the issued grant/runtime, not as proof
that a particular agent rather than neighboring code made the call.

Recommend a dedicated project for sensitive connections when protected execution
is unavailable. This uses an existing understandable boundary. Do not describe
it as protection from that project's own code, root access, or administrators.

### Protected Authority Versus Shared Project State

A CoCalc project is a collaborative execution environment. Collaborators and
programs with the same runtime privileges are not mutually isolated. Files with
mode `0600`, environment variables, shared sockets, and project secret mounts do
not make authority private between those programs. Container-root privileges
inside a project further rule out placing the protecting boundary there.

Protect the connector broker and provider credentials outside the ordinary
project container in every mode. For protected per-agent mode, also keep the
model driver and its private connector channel inaccessible to project processes.
Treat project files, configuration, tools and scripts as untrusted inputs to that
driver. Do not load a project-editable executable or configuration into a
credential-bearing service.

For stronger per-agent isolation, there are two invocation paths, sharing the
same grant checks:

- **Mediated tools:** the protected agent driver invokes the broker directly.
  Project shell processes receive neither the broker credential nor its socket.
  This is the preferred first implementation for provider APIs.
- **Scoped CLI execution:** when normal `cocalc-cli` calls must work inside an
  agent shell, launch that connector-enabled execution in a host-managed isolated
  compartment with its own process, network, credential and temporary-storage
  boundaries. Ordinary project processes cannot attach, inspect its environment,
  reach its private endpoints, or read its authentication material. Mounted
  project files remain shared and untrusted. A namespace inside a container that
  project root controls is not sufficient.

These are runtime implementation paths, not separate connection catalogs. Do not
silently inject a run token into the existing shared project shell and call it
private. Until isolated CLI execution passes its tests, offer either protected
mediated tools or explicitly approved shared-project CLI access. The functional
CLI milestone may ship with the latter; the stronger isolation milestone cannot
be claimed complete on that basis.

Isolation stops direct impersonation and credential theft by neighboring
processes. It does not make shared code safe to execute or prevent a malicious
document from misleading an authorized agent. Code deliberately executed within
an authorized compartment may exercise that compartment's granted authority.
No claim of protection from a compromised host administrator is made.

### Data And Actions

Provider responses, MCP descriptions, email, documents, webpages, and peer
messages are untrusted content, never instructions granting additional access.
Preserve this distinction in model-facing context and UI.

Once data is returned to an agent, it may enter its model context, chat history,
artifacts, logs or files. Project collaborators may see those outputs. Grant
confirmation must name the destination project and this disclosure consequence.
Model-provider data handling is also part of the user's choice; this plan is not
a data-loss-prevention system. Read-only does not mean unable to disclose data.

Do not promise that revocation retracts previously read data, sent mail, pushed
commits, browser actions, or remote code effects. Pause stops further authorized
use; cancellation of already executing operations is connector-dependent.

The same agent can combine its grants, and can share retrieved information in an
approved Agent Session. Session membership does not convey the grants themselves.
If a customer needs enforced information-flow separation, separate agents and
projects are necessary but not by themselves a complete DLP solution.

### Fresh Auth And Action Confirmation

Use the existing human session/fresh-auth machinery. Recommended step-up events:
first sensitive connection authorization, introducing a new target project trust
boundary, enabling cross-project execution, and enabling full browser control.
Evaluate freshness once for the reviewed operation, not at every API call.

Adding another named agent from an already approved source project to the same
connection still needs explicit human approval, but need not require fresh auth
again merely because its identity is new. Ordinary reads, narrowing, pause,
disconnect, removal, and revocation never require a fresh-auth ceremony.

Default to action confirmation for email send, calendar invitations, repository
merge/destructive changes, and similarly consequential operations. Let humans
enable clearly scoped standing permission where enforcement is meaningful.
Approval must bind canonical arguments, recipients/resources, content version or
digest, attachments, expiry, principal, and a single execution attempt. Never
approve one draft and send a later edited draft.

An unrestricted browser, arbitrary MCP tool, or general shell cannot honestly
promise confirmation before every business side effect. Present those as broad
control modes, not as equivalent to typed send/merge tools.

## 6. Architecture And Ownership

```text
Human UI / desktop CLI
        | setup, approval, revocation
Account home bay: connections + grants + encrypted credentials + control state
        | scoped authorization / lease / routing
Agent invocation (protected driver, isolated CLI, or disclosed shared runtime)
        | authenticated, operation-scoped requests
Connector worker / target project host / private browser gateway
        | provider API / MCP server / project files or exec / CDP
Selected external or CoCalc resource
```

The **account home bay** owns connection records, grants, proposals and account
pause generation. The **target project's owning bay** determines current
collaborator rights, route and host placement. The **target host or connector
worker** validates narrow permits and executes operations. Browser devices have
a separate device identity and attachment incarnation.

Use Conat control-plane APIs. OAuth browser redirects need small HTTPS endpoints;
they terminate the authorization transaction, not a parallel broad API surface.
Provider tokens are exchanged server-side and never returned in callback URLs.

Provider API/MCP traffic flows through a protected connector worker because it
must apply resource policy and hold credentials. That is a dedicated credential
data plane, not an excuse to relay project file streams through a hub. Deploy the
worker alongside a host or in an operator-controlled worker pool. For the first
single-bay deployment it may be colocated, but retain the service boundary.

CoCalc file/exec traffic goes directly to a narrow target-host service after
authorization. Browser streams and desktop tunnels terminate at a private
data-plane gateway, not a public project app port. Large uploads/downloads use
bounded streaming and explicit destinations; don't carry them in hub RPC payloads.

Reuse the site master-key lifecycle with a separate connector purpose/key domain;
store authenticated encrypted credential envelopes bound to owner and connection
IDs. Support key rotation and documented key backup/recovery. An external KMS is
an optional deployment integration, not a mandatory dependency for self-hosting.
Never include plaintext keys alongside encrypted database backups.

The vault never mounts account credentials under `/run/secrets/cocalc` in the
ordinary project. Connector workers receive only the credentials they need.
Private browser profiles, OAuth caches, SSH device keys, and MCP server auth files
need protected encrypted storage too. Exclude them from project export, rootfs
publish, clone, TimeTravel, snapshots, and backups. Disable credential-bearing
core dumps and redact diagnostics; tmpfs alone does not settle swap/host backups.

Provider data intentionally saved as an artifact remains ordinary project data
and follows normal persistence/backup rules. This distinction must be documented.

## 7. Records, Permits And Lifecycle

Proposed records; names are illustrative, not a committed wire API:

| Record                   | Essential fields                                                                                                                               |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection`             | ID, owner account/home bay, discriminated kind, label, remote account/tenant, nonsecret configuration, credential reference, state, generation |
| `connection_credential`  | Connection ID, encrypted envelope/key version, provider scopes, expiry/refresh metadata; no generic read-back API                              |
| `agent_connection_grant` | ID, owner, stable agent endpoint, source project, connection ID, typed operations/resources, confirmation policy, expiry, state, generation    |
| `connection_proposal`    | Exact requested change, requester, expiry, reviewed version, approval/rejection state                                                          |
| `connector_execution`    | Run/turn binding, parent identity, grant/connection/account generations, worker/host fence, lease deadline, active/canceled state              |
| `connector_attempt`      | Attempt ID, operation and request digest, resource summary, admission/result state, timestamps, redacted failure, optional provider request ID |
| `browser_attachment`     | Connection ID, device or hosted runtime identity, profile identity, incarnation, lease, online/control state                                   |

Resource policies are discriminated per kind: Gmail operations, Drive file IDs,
Calendar IDs, GitHub repository IDs, MCP tool identities/schema versions, browser
profile IDs, project file roots, or project execution targets. Avoid a universal
JSON bag that each caller interprets differently.

An admitted operation must satisfy:

```text
site policy AND account enabled AND connection enabled
AND grant active AND exact account/agent/execution match
AND allowed operation/resource AND current external/target access
AND valid audience/route/host fence/deadline
AND action approval when required
```

The trusted runtime supplies principal and source identity. Reject caller attempts
to substitute them. Require explicit connection/grant selection where ambiguous;
no fallback to account credentials, another agent's grant, or a broad host token.

Mint short-lived audience-bound capabilities with operation/resource restrictions.
Recommended starting point: at most five-minute execution leases with renewal
only for a live authorized run. These values are internal defaults, not a reason
to end a multi-day agent turn. Native subagents may use a bounded subset of the
parent's grants under the same human principal; they cannot create grants or
outlive the parent's authority. Record parent/child attribution where available.

Recheck authority at request admission, after asynchronous startup/refresh, and
at actual execution. A queued operation is not grandfathered past revocation.
Refresh-token exchange never bypasses a revoked grant. Serialize refresh rotation
and protect against stale refresh responses overwriting new credentials.

Pause/revoke increments generations. Push invalidation to workers and close
active streams, tunnels and browser access. Target a maximum 30-second stale
authorization window using short authorization-cache validity plus fail-closed
renewal; do not rely solely on a five-minute JWT. Require fresh authoritative
checks at dispatch for confirmed side effects. Define the admission ordering for
a revoke racing an already dispatched provider request, and show that operation
as potentially completed rather than promising rollback.

Use request IDs and canonical payload bindings for setup mutations and tool
attempts. Same ID with different content is rejected. Preserve unknown outcomes
after transport failures. Retry writes only if the provider offers proven
idempotency or the user deliberately retries; a CoCalc ID alone cannot make an
external email send exactly-once. Maintain distinct accepted, running, succeeded,
failed and unknown states rather than treating admission as completion.

Set bounded account-wide counts for connections, grants, proposals, active
executions and browser attachments. Starting proposals: 100 connections, 1,000
grants, 20 pending proposals with a 24-hour TTL, and paginated listings of at most
100 records. Define per-worker concurrency, payload, transfer, output and storage
limits before implementation; allow operator tuning within hard safety limits.
Enforce allocation limits transactionally. Restrictive actions remain available
while over limit or feature-disabled. Bound retained records and indexes too.

Account rehome must either transfer this state with explicit ownership fencing
or remain blocked while connections exist. Start with a clear block, not a new
rehome implementation. Project moves invalidate old host permits. Restoring old
backups must not reactivate revoked leases/devices; rotate the authority epoch
and require reconnection where necessary.

## 8. Google: Gmail, Calendar And Drive

### Setup And Credential Handling

Offer a Google connection with separate Gmail, Calendar and Drive capability
choices. Confirm the selected Google account; it need not be the sign-in account.
Request only the provider scopes required by the selected features, using
incremental consent. Request offline access when persistent background use is
needed. Preserve granted-scope metadata and handle partial consent and expired
or revoked refresh tokens. Google's server-side flow and incremental consent
are documented in [Google OAuth guidance](https://developers.google.com/identity/protocols/oauth2/web-server).

Keep connection consent distinct from login, even if some registered application
configuration is reused. Store single-use OAuth state bound to initiating human,
provider/issuer, intended connection and redirect URI; use PKCE where supported.
Validate exact callbacks and account binding. OAuth completion creates or updates
the connection, not an unreviewed agent grant. Never let an agent-controlled
redirect choose where a refresh token goes.

### Operations And Real Scope Boundaries

| Service  | Initial useful operations                                                | Default restrictions                                                               |
| -------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| Gmail    | Search, read thread/message, fetch attachment, compose draft, send/reply | Read explicitly enabled; sending confirmed; mailbox administration excluded        |
| Calendar | List calendars, read events/free-busy, create/update/delete events       | Selected calendar IDs; invites/changes confirmed until standing permission granted |
| Drive    | Pick files, read/export content, create/update selected files            | Selected file IDs; sharing/permission changes excluded initially                   |

Do not expose arbitrary Google HTTP requests as a shortcut. A broker holding a
broad provider scope still enforces the agent's narrower resource policy.
Distinguish provider-enforced limits from CoCalc-enforced limits in advanced
details. Gmail searches/labels are filters, not a substitute for provider-level
mailbox isolation. A truly label-restricted grant needs enforced result and
object-access checks, not just a prefilled search query.

Prefer Drive's selected-file `drive.file` route with a picker for narrow access;
it does not provide arbitrary full-Drive discovery. Full-Drive search is a
separate, broader opt-in. Folder selection must specify whether descendants and
future files are included and implement that policy explicitly; selecting a
folder is not assumed to grant arbitrary subtree access under `drive.file`.
See [Drive scope guidance](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

Use the narrowest suitable Calendar scopes, then enforce selected calendar IDs
in the broker. Read event details and free/busy are different capabilities. An
event operation may notify attendees, so show recipients and notification
behavior in confirmation. See [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

For Gmail, sending and mailbox reading have different provider scopes. Public
deployment of restricted scopes can require verification and a security
assessment, with exceptions depending on deployment. Start that work early; a
test-account demo is not evidence of public production readiness. See
[Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes) and
[restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
Also review Google's policies for processing this data through model providers
before launch; do not assume OAuth consent alone settles permissible use.

Initial implementation is on-demand, not background inbox indexing or autonomous
email-triggered runs. No domain-wide delegation, global administrator credentials,
or comprehensive sync database is needed to make these connectors useful.

## 9. MCP: Guided Setup Without A Terminal

### Compatibility Promise

Support remote HTTPS Streamable HTTP servers and managed stdio servers, with
explicitly tested authentication modes. Add legacy transports only when a real
integration needs them. "Any MCP server" means an extensible adapter path, not a
promise that every proprietary auth scheme or arbitrary install script works.

The wizard takes a catalog choice or URL, identifies transport/auth requirements,
connects the account, lists tools/resources, lets the human select access for an
agent, and runs a read-only diagnostic. Show actionable failures such as missing
client registration, unsupported transport, scope denied, or unreachable server.
Vanta is an acceptance target: verify its actual supported endpoint, tenant
requirements and auth flow before advertising it as tested.

For HTTP OAuth, implement the pinned MCP authorization version's discovery,
registration, PKCE, resource/audience and scope rules. Support preregistered
clients and advertised registration mechanisms; keep an advanced client-config
form when automatic registration is unavailable. Record the tested protocol
version instead of silently tracking draft changes. Start from the
[2025-11-25 authorization specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

### Solving The Localhost Problem

There are three different cases, not one universal port-forwarding trick:

1. Remote OAuth-capable MCP: CoCalc acts as OAuth client with its registered HTTPS
   callback. There is no project-local callback server to expose.
2. Managed stdio package: run it in a protected connector worker, not the user's
   shared shell. Prefer a supported redirect/device authorization flow. If its
   login helper requires a fixed loopback callback, supply a tested adapter or
   run the consent browser beside that helper in an isolated hosted setup session.
   Remove setup-browser state afterward unless explicitly retained. If neither
   is supported, report the limitation rather than rewriting the provider URI.
3. Desktop-local MCP or native login helper: an optional desktop companion can
   own a real local callback and exchange the result through an authenticated
   setup channel. This uses native-app rules, not a hub pretending to be localhost.
   General desktop-local MCP execution is a later extension, not necessary for
   remote MCP support in this plan.

Native loopback callbacks and PKCE have specific requirements in
[RFC 8252](https://datatracker.ietf.org/doc/html/rfc8252). Never expose an
unauthenticated callback listener as a public CoCalc app merely to finish login.
Do not scrape codes or passwords into chat.

### Managed Servers And Tool Policy

Managed stdio installations use pinned package versions or image digests with
reviewable commands, health checks, bounded resources and update/rollback. No
arbitrary installer runs with host privileges. Each server gets only its own
credential and approved volumes/network access, never the entire account vault.
Server-private auth files use protected encrypted storage, not project `$HOME`.

Agents see only granted tools and resources. Apply the policy at invocation as
well as discovery. Treat descriptions, annotations, prompts and results as
untrusted. A server's "read-only" annotation is not proof of behavior. For custom
servers disclose that CoCalc can enforce tool selection but generally cannot
prove the selected tool's real-world effects.

Pin reviewed tool identities and schemas to a catalog revision. Added tools or
material scope/schema changes require review; do not silently widen old grants.
Disable unsolicited sampling/elicitation in the initial bridge unless explicitly
implemented with the same human/principal boundaries and bounded resource policy.

Harden discovery and requests against SSRF: validate schemes, DNS resolution,
redirects and connected destinations, including OAuth metadata/token endpoints.
Block metadata services, loopback and internal control endpoints by default.
Self-hosted intranet MCP is supported through an explicit operator-approved
network policy and trusted routing, not a global "disable SSRF checks" switch.
Tokens are audience-bound and never forwarded to arbitrary downstream services.
The upstream provider consent must also be bound to the correct human/client.
See [MCP security guidance](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices).

## 10. GitHub And Other Credentialed CLI Tools

### GitHub App First

Use a GitHub App with explicitly selected repositories and fine-grained
permissions. Separate read code/issues, create branches/PRs, comment, merge, and
administration. Repository names are labels; grants bind stable IDs and the
installation/remote identity. Show whether actions appear as the app bot or user.

Installation tokens can be narrowed to selected repositories and permissions and
expire after one hour. Mint them only inside the protected worker; do not copy
them into project config. See [installation-token documentation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

An installation may see more repositories than the connecting person. Verify
that person is entitled to delegate the selected repository operations, or use a
user-scoped GitHub App authorization. Do not let installation authority become an
accidental organization-wide privilege escalation. Track permission removals and
validate current access at use. GitHub documents the distinction between user
and installation identities in [its app comparison](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/differences-between-github-apps-and-oauth-apps).

### CLI Ergonomics Without Plaintext Project Credentials

Provide typed GitHub operations first, plus a managed `gh` invocation path that
runs the real pinned binary in an isolated credential-bearing worker. Its
ephemeral config/home is outside project snapshots. Keep a clear support matrix
for commands; do not claim a string-based shell wrapper can securely constrain
all `gh api`, aliases, extensions and git credential behavior.

If a command cannot be reduced to a reviewed typed operation, the permission is
the actual scoped repository capability of its temporary token, not the label
on the command. Disable extensions and project-controlled configuration in the
managed helper. A broad "run arbitrary gh" mode must say what it grants and
cannot claim per-action confirmation for all writes.

Use a mediated git transport or isolated credential helper for clone/fetch/push.
Do not run credential-bearing git with unreviewed project hooks, helpers or
configuration. Separate read fetch from push authority. Export resulting work
into the project through an explicit file operation. Ordinary break-glass `gh
auth login` remains available, but is not represented as the secure managed
connection and receives a warning about credential persistence.

Other tools use the same adapter shape: connect, describe capabilities, execute
in a protected worker, refresh/revoke, redact, diagnose. Prefer provider apps or
OAuth over long-lived PATs. Where API keys are the only option, encrypt centrally
and show their often-coarse effective authority. Do not build a marketplace or
universal command-policy language to ship the first connectors.

## 11. Hosted Chromium With Blit

Offer **New hosted browser**: CoCalc starts Chromium and the Wayland/blit viewing
stack in a dedicated protected runtime. The user can watch, log in, take control,
and hand control back. Reuse graphical-app packaging and UI, not the shared
project desktop's authorization boundary.

Use a distinct profile for each separately authorized browser connection. Default
to a disposable profile; offer "Keep this browser signed in" with encrypted
profile storage and explicit retention. One profile should not be concurrently
controlled by unrelated agents. If users deliberately share one, serialize
control and display its shared scope.

CDP is broad authority over the browser profile, including sensitive browsing
state. It is not reliably "one tab", "read-only", or "only this website" access.
Dedicated profiles reduce exposure; they do not make websites inside that profile
mutually isolated from the controlling agent. The UI must say:

> This agent can control this browser and use accounts signed in here. Do not
> sign in to accounts you do not want this agent to use.

Never attach to the user's ordinary browsing profile. Chrome's debugging changes
also require a non-default data directory in normal Chrome starting with version
136; see [Chrome's guidance](https://developer.chrome.com/blog/remote-debugging-port).

Keep the debugging pipe/port private. Agent access passes through an authenticated
gateway bound to the exact browser incarnation; do not expose CDP JSON discovery
or WebSocket endpoints through an ordinary project proxy. Human blit viewing and
input need separate authenticated access, not collaborator-wide project access.

Taking human control suspends agent input before enabling human input, fences
stale commands, and visibly updates both sides. Resume is explicit. A CoCalc
approval/login session must not be controllable by the agent during setup; never
leave a human's CoCalc management session in an agent-controlled profile.

Default to no project filesystem mounts. Upload selected files through a scoped
transfer; download to a staging area and explicitly save as an artifact/file.
Block browser access to host control services, metadata endpoints and arbitrary
host files. Keep Chromium's sandbox enabled and patch browser images regularly.

Handle startup/readiness, crash, profile lock, host loss, idle suspension, storage
limits and account deletion. Do not promise uninterrupted browser state after a
runtime crash; distinguish persistent profile state from live tab/process state.

## 12. A Browser On The User's Desktop Or Laptop

The UI offers **Connect a browser on this computer** and a generated CLI command.
The command contains a public rendezvous identifier, not a durable bearer secret.
Exact CLI spelling is to be designed; this is a new command, not existing behavior.

1. The local CLI authenticates the human through the browser and confirms the
   CoCalc account/site, selected agent, connection and expiry.
2. It verifies or provisions the necessary SSH transport, validates the server
   host key, and obtains a narrowly scoped device/tunnel credential. Do not
   silently alter unrelated SSH configuration or reuse an unrestricted key.
3. It launches a dedicated local Chrome profile, with private loopback debugging
   or a pipe bridged by the companion. It never attaches to a default profile or
   silently copies cookies from another browser.
4. It opens an outbound, authenticated reverse tunnel to a private browser
   gateway. No inbound router/firewall setup should be needed on the laptop.
5. The gateway binds that tunnel to the exact browser connection/device/profile
   incarnation and agent grant. Other project processes cannot connect to it.
6. The CLI displays a persistent online/control indicator and Stop. The account
   UI can also revoke the device or disconnect the browser.

SSH authority must be forwarding-only, with no shell, agent forwarding or general
network proxy. Restrict listener/destination capabilities on the server and in
the local companion; pin the local browser endpoint launched by this attachment.
If OpenSSH's controls cannot express part of the needed restriction, enforce it
in the authenticated gateway/companion rather than claiming SSH alone does so.
Do not accept an arbitrary caller-supplied localhost port as a browser endpoint.

Reuse Reflect's forwarding lifecycle patterns where appropriate: readiness
probes, keepalives, exponential backoff, bounded reconnect, graceful shutdown,
sleep/resume and network-change handling. Inspect destination readiness, not just
whether the SSH process stayed alive. Avoid depending on an unversioned sibling
checkout; package any reused Reflect dependency explicitly.

Reconnect requires the same device, profile incarnation and a valid renewable
lease. Revoked or expired attachment authority cannot be resurrected by a daemon.
Never replay browser actions after a disconnect; their result may be unknown.
After long absence or changed identity, require explicit reattachment.

The agent sees "Desktop browser offline" when the computer disconnects. It may
continue other work, but must not silently switch to a hosted browser or another
profile. Downloads stay in the isolated browser's chosen location until explicitly
transferred. No implicit access to the desktop home directory, clipboard or SSH
agent. Warn that compromising the local OS defeats this boundary.

Ship against a declared OS support matrix. Linux is the first engineering target
given existing forwarding experience; validate macOS and Windows before claiming
support rather than assuming Chrome and SSH packaging are identical.

## 13. Files And Execution In Other CoCalc Projects

### File Grants

From agent P's Access panel, choose project Q from projects the granting human
currently has appropriate collaborator access to. Select whole project files or
explicit roots, then read or read/write. No automatic access to all current or
future projects; no discovery of inaccessible project names.

Read includes bounded listing, stat, file reads and explicitly supported search.
Read/write includes create/update, mkdir, rename/move and delete within the roots;
make deletion visible in the summary. It excludes execution, terminals, secrets
APIs, project settings, collaborators, public sharing and lifecycle administration.

The existing `cocalc-cli` filesystem verbs should work with an explicit target
project and the current agent's grant. Internally exchange the scoped execution
identity for a file-service permit, not the human's general project token. CLI
authorization failure never falls back to an account API key. Shared-project CLI
mode is available with the explicit trust warning. The isolated CLI runtime
described above is required to claim these capabilities are inaccessible to
ordinary project processes.

The target project's owning bay checks current collaborator rights and issues a
host-fenced permit. The target host validates operation, path root and access
mode for every request. Recheck after startup and before queued operations. If
the human loses access to Q, grants stop working even while the source run lives.

Path enforcement must cover traversal, encoding, symlinks, rename races, hard
links, mounts, archives, copy endpoints and alternate download routes. Use
descriptor-relative safe resolution rather than a string-prefix check followed
by an unrestricted open. Audit historical/snapshot reads and special filesystem
paths separately; a present-day root grant must not quietly expose every backup.

Collaborators can move or copy content into an allowed root. A path grant limits
where the connector operates, not the historical provenance of bytes in that
directory. Exclude special files and runtime credential mounts. Users who need
strong dataset boundaries should use dedicated projects rather than treat a
directory as a security boundary against project administrators.

Use live text/notebook APIs for collaborative document operations; support
version/hash preconditions rather than overwriting unsaved editor state with a
raw filesystem write. Notebook execution requires exec authority, not write
authority. Enumerate which regular filesystem operations, watchers, archives and
search endpoints are supported; reject unsupported ones explicitly.

Writing code/configuration can cause later execution by Q's services, imports,
hooks or collaborators. Therefore file write is not a guarantee of "no code
execution consequences". Explain this when granting writes to a live project.

### Execution Grants

Execution is a separate high-authority capability, selected per target project.
It effectively grants that project's runtime user access, including files,
mounted project secrets, available network and resources. Do not offer a fake
"run any command but only read /datasets" permission.

Expose the normal CLI execution flow using a distinct narrow exec service and
explicit target Q. Bind attribution to the granting human and source agent, not
whichever collaborator happens to own a busy session. No account-management or
host-admin APIs ride along with execution authority.

Give every job an ID, target, deadline, output cap and cancellation handle. Retain
bounded status after disconnect, so clients can inspect rather than retry an
unknown execution. Startup/resource charges must be visible; ask once when
granting auto-start and enforce existing compute/spend/concurrency limits.

Revocation blocks new jobs and requests process-group/container-job termination
for active jobs. Report failures and detached work honestly; execution can create
irreversible external effects and a shared target project is not a perfect
revocable sandbox. For strong job cleanup, use managed isolated jobs rather than
claiming every arbitrary background process can be recalled.

An agent executing in Q does not acquire another named agent's connections or
ability to delegate further projects. A read-only source grant cannot become exec
through Jupyter, app startup, terminal, file preview or a generic proxy endpoint.

## 14. Observability And Daily Management

Show concise human-readable activity, not UUID dumps:

```text
@researcher read 3 files from Work Drive                 10:32
@assistant wants to send email to Sam                   Awaiting approval
@analyst ran Python in GPU project                      Running, 2m
Desktop browser                                        Offline since 10:35
```

Click to inspect connection, principal/agent, operation, selected resource,
effective policy, confirmation, timing, status and a redacted diagnostic ID.
Show actual admission/result states; do not turn an unknown outcome into success.
Source and target project visibility checks apply to the inspector as well as
the operation. Private connection details do not leak to unrelated collaborators.

Store operational events server-side with bounded retention (proposed 30 days by
default), access-controlled by account. Store metadata rather than message bodies,
tokens, browser cookies, full URLs with secrets, or email attachment contents.
Resource names can themselves be sensitive; allow redaction and restrict viewers.
Do not claim editable chat cards are a pristine audit history. An agent's message
about an action is distinct from the authoritative tool-attempt status.

Provide per-agent pause, per-connection disconnect and account-wide **Pause all
connection access**. Keep these controls usable during outages, quota excess,
expired auth and disabled features. Explain the last confirmed state when the
control plane is unavailable; never pretend a failed revoke has propagated.

Render setup and permission errors as repairable states: Reconnect Google, Select
repositories, Review new MCP tools, Reattach desktop, Restore project access.
Avoid infinite auto-retry loops or sending credentials to a replacement endpoint.

## 15. Implementation Sequence And Acceptance Gates

### Milestone 0: Boundary Prototype And Provider Preparation

Inventory the model driver, agent-run identity issuance and shell execution
paths. Record the real boundary of the current runtime. Build a
two-agent/same-project prototype before committing to stronger per-agent security
claims. For a protected path, demonstrate that ordinary project code cannot
invoke the broker, steal its token, inspect its process or reach its browser.
Specify the extra isolated CLI work explicitly, but do not block a clearly
disclosed shared-project release on it.

In parallel, register test Google/GitHub applications, begin Google production
verification, and test one actual remote MCP endpoint. Record supported versions,
required scopes and self-host configuration. This avoids discovering external
approval delays after the UI is complete.

### Milestone 1: Shared Foundation Plus Cross-Project Read

Implement connection/grant records, vault, runtime binding, proposals, pause,
revocation, activity, narrow host permits and the grouped @ picker. Add project-Q
read through mediated tools where a protected driver exists, and the CLI path
with ordinary filesystem verbs. Shared-project mode may ship first; add isolated
CLI as a separately tested improvement. This exercises real account, project
and bay authorization without OAuth.

Exit: agent A can read explicitly granted Q data; lost collaboration/revocation
stops queued reads; another account using the same thread does not automatically
receive a grant. Protected mode must prove agent B cannot borrow A's authority;
shared mode must show the explicit warning and demonstrate that the residual
shared-runtime risk is understood, not hidden. Verify cross-bay routing and
stale-host rejection, not just same-host success.

### Milestone 2: Google And GitHub Vertical Slices

Ship Drive selected-file reading, Calendar reading and confirmed event creation,
Gmail reading/drafting/confirmed sending, and GitHub selected-repository read and
PR creation. Reuse the same Access and Activity UI. Build managed CLI/git support
after typed operations are stable, with honest command coverage.

Exit: a user connects in the UI, grants one agent, sees an actual useful result,
revokes access, and cannot recover credentials from project export or backup.
Verify account switching, partial consent, token refresh races and provider-side
revocation. Public Gmail availability depends on completing applicable review.

### Milestone 3: Remote And Managed MCP

Implement the transport/auth wizard, protected stdio runner, tool/resource grants,
schema-change review and diagnostics. Validate a normal remote OAuth server, a
configured API-key server, and a managed stdio server requiring interactive setup.
Validate Vanta with an actual authorized test tenant if available; otherwise mark
it unverified rather than blocking the generic connector or claiming support.

Exit: users can complete tested setup flows without a terminal; malicious tool
metadata, callbacks and endpoints cannot widen authority or read other secrets.

### Milestone 4: Hosted Browser

Add isolated Chromium/blit lifecycle, private CDP gateway, human takeover,
disposable/encrypted persistent profiles, file transfer and visible controls.

Exit: agent control works, human takeover fences commands, a second agent/project
cannot reach the browser, and profile secrets stay out of project persistence.
Test browser crashes, host restart, downloads and grant revocation mid-session.

### Milestone 5: Desktop Browser

Add device enrollment, local isolated profile launch, restricted SSH reverse
tunnel, liveness and reconnect UI. Reuse forwarding components where verified.

Exit: test sleep/wake, Wi-Fi changes, SSH loss, CLI restart, browser restart,
revocation while offline, stale daemon reconnect and two simultaneous devices.
No action replay, default-profile attachment, generic port forwarding, or silent
switch to a different browser. Publish the tested OS matrix.

### Milestone 6: Cross-Project Write And Exec; Production Hardening

Complete safe write paths and live-editor integration, then managed execution,
startup/spend policy and cancellation. Exercise long-lived multi-agent workflows
with mixed connections, bounded subagent delegation and Session messages.

Exit: full requested range works with published limits. Complete security review,
backup/restore/key-rotation drills, accessibility checks, self-host setup docs and
operator recovery procedures. Roll out a small connector cohort first; disabling
new use must leave revoke, disconnect and cleanup functional.

Each milestone should land as a reviewable change-set. No time estimate is a
substitute for passing its acceptance gates. Runtime isolation is the
highest-risk dependency for the stronger privacy claim, not a prerequisite for
every useful connector. Google verification is an external dependency.

## 16. Code Organization And Verification

Proposed package-local additions:

- `conat/connectors`: typed policies, permits, protocol schemas and client types.
- `conat/hub/api`: connector setup/approval/control RPC surface.
- `server/connectors`: home-bay records, grants, vault, provider OAuth and policy.
- `project-host` and `lite/hub/acp`: protected invocation, host admission and
  isolated execution integration; share semantics rather than bypassing in Lite.
- A protected connector-worker service: provider adapters, managed MCP and browser
  control, deployed separately from project-user code.
- `frontend/connections` plus `frontend/agents`: setup, Access, @ picker, activity
  and inspectors, reusing existing controls and `UI_COLORS`.
- `cli`: connector discovery/use, normal cross-project file/exec integration, and
  desktop browser attachment. No broad credential-export command.

Testing must include real authorization boundaries, not only mocked happy paths:

| Area         | Required negative/race coverage                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | Different account on same thread, renamed/cloned agents, forged source, completed parent run, subagent scope escalation            |
| Isolation    | Same-UID neighbors, project-root attempts, `/proc`, shared temp/config/socket paths, inherited descriptors, project-edited helpers |
| Revocation   | Pause/remove/expiry versus queued work, refresh, startup, stream and reconnect; partitioned worker fails closed                    |
| OAuth        | State replay, account/issuer mix-up, callback changes, partial scopes, parallel refresh, removed provider permission               |
| MCP          | DNS rebinding/redirects, private endpoints, token audience, schema changes, deceptive annotations, server crash/update             |
| Files        | Symlink/rename races, traversal, mounts, archives, alternative endpoints, read-to-exec escapes, removed collaboration              |
| Browser      | Leaked CDP address, second agent/device, takeover race, offline revoke, stale incarnation, forbidden default profile               |
| Side effects | Edited approval payload, duplicate attempt, provider timeout after success, intentional retry with unknown prior outcome           |
| Persistence  | Grep controlled exports/backups/logs/core-dump policy for seeded test credentials; clone/restore does not restore authority        |
| Limits       | Concurrent grant/connection creation, oversized discovery/output, worker pressure, restrictive actions while disabled/over quota   |

Use PostgreSQL barrier tests for authority mutations versus asynchronous dispatch
and direct-host integration tests for capability enforcement. Test collaborator
removal and host moves across bays even if initial deployment is single-bay.
Use provider test accounts, not production inboxes, for destructive tests.

For UI, require keyboard setup/approval/revocation, screen-reader names/status,
focus restoration after OAuth return, narrow layout, 200% zoom, light/dark themes
and failure recovery. Follow the repository's focused accessibility coverage and
run `pnpm -C src lint:frontend` for implementation changes. Run package-local
typechecks/tests before full release builds.

## 17. Operational And Self-Hosting Requirements

Document required callback origins, TLS, outbound endpoints, provider app
registration, secret key storage, worker isolation, browser images and tunnel
ports. Supply a setup diagnostic that verifies configuration without printing
secrets. Some organizations will require private-network MCP endpoints and their
own Google/GitHub applications; support those as normal operator configuration.

Monitor auth failures, refresh failure rates, worker queue length, unknown
outcomes, lease-invalidation lag and orphan browsers/jobs. Bound labels to avoid
unbounded metric cardinality; don't put resource contents in telemetry.

Have tested procedures for key loss/rotation, provider credential compromise,
mass revoke, failed provider refresh, unreachable laptop, broken MCP update and
browser image rollback. Deleting an account removes connection secrets and
stops device/workers, subject to documented encrypted-backup retention.

Do not require a paid external vault or a centralized CoCalc relay for basic
self-hosting. Small deployments can colocate services while preserving the
project-user/process security boundary. A same-UID development runtime may be
useful for testing but must not be labeled private multi-user connector hosting.

## 18. Decisions To Validate During The First Prototype

- Exactly where can the existing model driver keep an invocation channel that
  project code cannot impersonate? Prefer extending a protected host service;
  measure the isolated CLI cost before choosing its container/process design.
- Which Google scopes and verification obligations apply to the intended hosted
  and self-hosted deployments? Have an operator own this dependency immediately.
- Which GitHub operations need user attribution rather than app-bot attribution?
  Start with repository-scoped app operations, not broad personal OAuth access.
- Does the first real MCP customer need remote OAuth, managed stdio, or a private
  intranet route? Test that exact setup instead of adding speculative transports.
- Should persistent browser profiles remain opt-in? Recommended yes; convenience
  is significant, but cookies carry durable account authority.

These questions should refine implementation, not delay a useful first slice.
The decisions above are defaults, not invitations to silently weaken the stated
security boundary to make a demo work.

## 19. Future Ideas Explicitly Excluded From This Plan

- A public connector marketplace, automatic third-party install/update trust, or
  claiming every MCP server works without an adapter.
- Organization-wide inherited grants, service-account administration, Google
  domain-wide delegation, or automatic connection sharing across Agent Sessions.
- Background email/Drive indexing, event-triggered agents, enterprise search and
  continuous bidirectional synchronization.
- A general DLP/information-flow system or guarantees that authorized agents never
  disclose information through their other tools.
- Read-only arbitrary Chrome automation, guaranteed per-tab credential isolation,
  or attaching to the user's ordinary browser profile.
- Arbitrary desktop filesystem/terminal access through the browser tunnel, or a
  generic remote desktop/MCP device platform beyond the specified browser client.
- Automatic account rehome with live connector state, transparent cross-site
  credential migration, or shared global credential infrastructure.
- Immutable/cryptographically verified chat history. Operational records and
  editable conversational presentation remain distinct.
- Building our own subagent scheduler or making model-provider routing part of
  the connector delivery dependency. Keep the connector protocol model-neutral.

The intended result is not merely convenient OAuth setup. It is a usable agent
workspace whose integrations have understandable, enforceable limits and whose
credentials do not become accidental permanent project files.
