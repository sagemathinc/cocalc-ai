# Named Agents And Approval At The Point Of Use

Date: 2026-09-14.

Status: approved for implementation on 2026-09-14. This is the prototype contract,
not a claim of deployed behavior. Actual evidence and remaining work are recorded
in `agent-mentions-progress.md`.

## 1. Product Contract

CoCalc is agent-collaboration-first. Optimize for one human directing several
agents across projects, while keeping multiple humans' authority separate.

The primary interaction is:

> Finish the PR, then message @reviewer.

The human selects a named agent, sees which agent that means, and approves a
connection there if necessary. No copied URLs, project IDs, thread IDs, or
separate link-setup ceremony. The agent receives a stable reference, not an
invitation to guess from old conversation text.

Acceptance scenario: name three agents `builder`, `reviewer`, and `researcher`
in three projects; direct builder to contact reviewer using the composer; approve
communication in both directions; observe the message and response; pause the
connection from one account-wide view. At least two projects must use different
hosts and bays. Repeat with the receiver stopped and automatic starts allowed.

Keep the RPC foundation's weak delivery contract. This prototype improves
addressing, authorization scope, and interaction; it does not add reliable
delivery, a message bus, an outbox, or an orchestration engine.

## 2. Scope Boundary

Included in the prototype:

- Account-scoped agent names, rename, descriptive context, and a small My Agents
  directory accessible outside any project.
- Named agents prominently selectable in the shared `@` picker, including both
  rich-text and Markdown chat composers.
- Stable typed agent references preserved through composing, storage, rendering,
  and construction of the agent's turn input.
- Human-scoped connections selected from the trusted principal of each turn.
- Inline connection approval when a human selects an agent in a runnable composer.
- A typed agent-requested approval/renewal using the existing attention/approval
  surface, not a generic question that happens to receive a yes.
- Explicit one-way or bidirectional communication, finite expiry or Never expires,
  individual pause/revoke, and account-wide controls over the human's own grants.
- A clear last-human-settings-writer rule for automation execution, and rejection
  of cross-human steering.

Not included:

- A new full-screen multi-agent IDE, simultaneous transcript panes, or a new
  storage format replacing `.chat` files.
- Team-owned/shared permission pools, cross-account invitations, delegation,
  one-use reply capabilities, cross-site federation, public agent search, or
  globally unique names across all CoCalc accounts.
- Arbitrary new `@` integrations, broadcast, task assignment, workflow graphs,
  exactly-once effects, background retries, or automatic reapproval.
- Artifact integration as a prerequisite. The normal UI is the first surface.

The My Agents directory is the navigation foundation for the larger unified
workspace, not a claim that the entire workspace is included in this prototype.

## 3. Existing Foundation And Required Deltas

Base implementation work on PR #558's RPC foundation, not the historical
durable-delivery branch. The inspected baseline is
`4a1c89014ef6ae1f1a464c37ced960214478a330`; recheck the actual base when starting.
Preserve the older design documents as history rather than silently rewriting
their contracts.

Relevant existing code, paths relative to `src/packages`:

| Area                                                                                                  | Reuse / change                                                                                                                               |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/agents/rpc.ts`, `conat/agents/rpc.ts`                                                         | Routed RPC grants, admission, and honest outcomes; discovery/check currently use shared source-agent connections, not the new personal scope |
| `server/agents/store.ts`, `util/db-schema/`                                                           | Existing identities and per-run account identity; all new persistent tables/indexes belong in the schema system                              |
| `frontend/editors/markdown-input/mentionable-users.tsx`, `mentions.ts`, `complete.tsx`                | Existing people completion; extend through a typed provider instead of inventing a separate composer                                         |
| `frontend/editors/slate/slate-mentions/`, `elements/mention/`, `frontend/markdown/mentions-plugin.ts` | Rich-text selection, typed nodes, and Markdown round trips                                                                                   |
| `frontend/chat/composer.tsx`, `actions/ai.ts`, `acp-api.ts`, `chat/send.ts`                           | Mention binding and prompt/admission plumbing; preserve private drafts                                                                       |
| `frontend/chat/agent-communication.tsx`, `codex.tsx`                                                  | Current connection UI and fresh-auth flow; move normal setup to the composer                                                                 |
| `frontend/project/page/flyouts/agents.tsx`                                                            | Existing inline agent chat and project context; reuse later for a unified account workspace                                                  |
| `lite/hub/acp/index.ts`, `lite/hub/sqlite/acp-automations.ts`                                         | Schedule ownership and queue/steering boundaries                                                                                             |
| `ai/acp/codex-attention.ts`, `ai/acp/codex-app-server.ts`, existing first-party approval handlers     | Existing interactive attention plumbing; add a typed messaging approval action, not shell approval or free-form question authority           |

Important observed deltas:

- Current automation upserts retain `existing.account_id ?? request.account_id`.
  Updating the settings does not currently transfer execution responsibility.
- Current RPC grants require the target registrant to approve, and target
  execution uses that registrant. Personal turns require an explicit change:
  registration provenance must not stand in for every future execution principal.
- Current active-link listing omits expired links. The new management UI must
  show expired/paused/revoked connections without treating them as usable.

These are authorization changes, not cosmetic UI patches. Implement and test
them before exposing name-based sending.

## 4. Names And The Account Directory

### Identity and scope

One account has a namespace of names spanning all its projects and bays on this
site. A name resolves to `(project_id, agent_id)`; the immutable agent UUID is the
identity. A shared thread can have different names in different accounts.

Prototype rule: one current name per account per agent. No project-local fallback
and no case-sensitive variants. Proposed syntax: 1-32 ASCII characters, beginning
with a letter, containing lowercase letters, digits, and internal hyphens, and
ending with a letter or digit. Reserve picker commands such as `all`, `everyone`,
`agents`, and `me`. Enforce uniqueness in the database, not only the form.

Names are human-managed. Registration/naming is not a communication grant and
does not start the project or an agent turn. Compose-before-first-turn must work:
prepare the thread/identity as metadata without requiring a prior agent run.

### Naming UI

Expose a visible Name agent / Rename action near the thread title and in My
Agents, rather than requiring the human to discover experimental Codex settings.
Label it "Name in your agents" to make account scope understandable.

Show the short name prominently, followed by thread title, project title, and an
optional short account-authored description. Put IDs and routing in Details.
Do not equate a personal name with private chat history or project ownership.

Renaming is allowed. Existing grants and selected mentions remain bound to the
same UUID. Rename transactionally reserves the old name as retired and creates
the new current name. Do not reuse retired names for different agents in this
prototype. Explicit use of an old textual name returns `name_renamed` plus the
current name; it does not silently redirect a new send. Already bound references
continue to identify the original agent.

Deleted/unavailable targets remain recognizable, with an unavailable state, not
silently reassigned to a new thread at the same file path. Copies/forks receive
new identities; they do not inherit the source's personal names or grants.

### My Agents

Add an account-level entry independent of the selected project. Initially show
a searchable list of all the account's named agents with Name/Rename, Open, and
Connections actions. Search by short name, project title, and thread title;
prefer exact name matches. Opening explicitly navigates to the existing thread
and may invoke its normal startup behavior. Listing/searching never starts work.

Do not open a live chat syncdoc or connect to every project to populate the list.
Use account metadata and safe snapshots. Where activity/status is unavailable,
show Unknown or Last observed rather than claiming an agent is idle or offline.

The next UI increment can put the selected agent's existing chat pane beside this
list on the same account page, preserving its actual project context. Subsequent
increments can add open-agent tabs and activity badges. Keep files as an explicit
Open project escape hatch. No identity, naming, or permission redesign should be
needed to make this a single surface for working with all named agents.

## 5. Human-Scoped Turns And Connections

Every turn has a fixed, trusted `execution_account_id`. The run credential and
server-side run record establish it. Neither model text nor an arbitrary CLI
`--account` option can choose or change it.

Audit reused Codex sessions, app-server processes, and CLI clients for cached
credentials. Starting Q's turn after P's turn must install Q's scoped run identity,
not retain P's environment or pending approval context. A shared model session
does not imply a shared authorization session. Test this using successive real
turns, not only separately constructed run records.

For this prototype, a connection authorized by P permits a specified source
agent running as P to message a specified target agent running as P. P must pass
the existing authorization/execution checks in both projects. Naming another
human's registered agent does not automatically grant P permission to run it.
Different receiving principals and cross-account invitations are deferred.

This changes the current registrant-only rule intentionally: `created_by` remains
registration provenance; approval records P as the execution principal. Do not
weaken project access, runtime sponsor/quota checks, payment gates, or tool
approvals while making this change.

| Turn origin                        | Principal                                                          |
| ---------------------------------- | ------------------------------------------------------------------ |
| Human sends a message              | The authenticated sender of that new turn                          |
| A different human queues a message | That second human when their queued turn starts                    |
| Agent message                      | The target execution principal recorded in the approved connection |
| Scheduled automation               | The last authenticated human to save its automation settings       |
| Continuation of an existing run    | Its original principal; no switch based on the last editor         |

Disallow cross-human steering at the execution service, not just by hiding a UI
button. An explicit steer from Q into P's turn is rejected with an actionable
"Queue a new turn under your account" alternative. Do not silently convert an
explicit steer to a queued message. Incoming agent guidance must satisfy this
same principal check. The initial mention flow requests ordinary queued messages,
not guidance; keep guidance out of the primary approval dialog.

Saving or enabling/resuming automation settings takes responsibility under the
saving human's account and runs admission checks for that account. Pausing is
also an explicit human settings mutation. Merely reading, acknowledging output,
or background updates to last-run/status fields do not transfer responsibility.
An agent-originated settings request cannot claim to be a different human writer;
use an authenticated human action for a responsibility-changing save.
Show "Future scheduled runs execute as you" when saving. Stamp queued automation
jobs with the configuration revision and principal. Obsolete queued jobs must
not acquire the new human's authority; use existing cancellation/admission paths
to prevent stale scheduled work. Already-running turns retain their principal.
Do not guess a different historical owner for existing automation rows: retain
their current account until the next authenticated settings change.

William's and Blaec's `@reviewer` can resolve differently in the same chat. The
selected reference records the naming account and target, never the current
reader's interpretation. A collaborator cannot approve a request for P's turn
as if they were P. They can create a new turn under their own authority.

Shared transcripts/files are still shared, and same-UID process access is not
credential isolation. This is personal API authority, not a new sandbox boundary.

## 6. Agent Mentions And Point-Of-Use Approval

### Picker

Typing `@` in an existing mention-capable editor prominently exposes Agents,
with named agents ranked ahead of people in agent composers. Provide a clearly
labeled Agents group/submenu, keyboard navigation, and direct name search; do
not require navigating a nested menu for every repeated `@reviewer` selection.
Keep People / All collaborators behavior intact.

Use one account-aware agent provider across mention-capable CoCalc editors,
including contexts outside a project. This does not mean hijacking `@` in code
editors, terminals, email addresses, or documents without mention support.

Show short name, thread/project context, and connection state when there is a
source turn context. Include named but not-yet-connected agents so the human can
express intent before permission exists. Selection never auto-creates a grant.

### Stable reference

Introduce a distinct agent mention type, not a person mention with an agent UUID
stored in `account-id`. Carry a version, naming account, exact target endpoint,
and display-name snapshot. The label is descriptive; identity is the endpoint.
Round-trip through rich text, Markdown, chat storage, export/import, and prompt
construction. Preserve original display context after rename and show current
name in details when available.

On a human-created turn, resolve selected references against the authenticated
account and produce a small validated reference map for that turn. Supply it to
the agent with its prompt so it can address a reference such as `@reviewer`
without guessing IDs. Snapshot references do not snapshot send permission;
authorization is checked again at actual send time.

Raw text `@reviewer` is not a capability. Offer resolution in the composer before
submission; do not silently reinterpret ambiguous pasted/historical text under
a different human's namespace. A forged mention, Markdown link, or received agent
message cannot grant permission or trigger an approval popup merely by rendering.
If Q resubmits P's bound mention, retain its target identity but validate Q's own
authority and ask Q explicitly if a new grant is needed.

### Composer flow

1. The human selects reviewer. Insert a reference chip and validate its target.
2. If a sufficient active personal grant exists, show Connected and continue.
3. Otherwise open the typed approval dialog from this explicit selection action.
4. Show source and target short names plus thread/project context. Ask for a
   duration (1 hour, 1 day default, 30 days, Never expires) and an unchecked
   "Allow communication in both directions" option.
5. Use existing fresh-auth where required. Approval creates a grant, not a send.
6. Return focus and preserve the entire draft/caret. On cancellation or failure,
   keep the draft/reference with a Needs approval state; do not submit the turn.
7. At Send, revalidate needed references and offer approval again for unresolved
   agent-composer destinations. The human can cancel or remove a mention; never
   silently remove it and run a different instruction. Once checks pass, submit
   the existing normal turn exactly once.

Outside a runnable agent composer, a mention is a navigable reference only.
It has no source agent from which to create a connection. If that content later
becomes a human-submitted agent prompt, the normal point-of-use checks apply.

Ordinary messages queue behind a busy turn. The phrase "when done, message
@reviewer" controls when the source chooses to send; selecting the mention does
not dispatch the message or promise that the model will follow the instruction.

## 7. Approval During An Agent Turn

Expose a narrow typed request action that the agent can invoke when a resolved
destination needs approval or renewal. Reuse CoCalc's existing attention and
interactive response plumbing, with a messaging-specific request renderer.

The request binds the source run/principal, immutable target, requested direction,
reason, and proposed duration. It contains no reusable credential and confers no
authority. Only the principal's authenticated human session can approve it, with
fresh-auth as required. Requesting, denying, or viewing it never sends a message.
The backend records the grant before reporting approval to the waiting turn.
Preserve private drafts and pending attention across refresh using existing
mechanisms; do not create a second workflow engine or a message outbox.

A generic `request_user_input` answer is not an authorization record. Use a
first-party action even if it is displayed beside ordinary Codex questions.
Conclude requests safely on cancellation, expiry, or invalidated run context;
rate-limit/coalesce repeated identical requests to avoid approval spam.

Return structured reasons such as `approval_required`, `grant_expired`,
`grant_paused`, `grant_revoked`, and `principal_mismatch`, in addition to the
existing accepted/rejected/unknown outcome. Do not encourage renewal prompts
after an intentional pause/revocation; the human must explicitly choose to
re-enable access. An expired authorization can naturally prompt renewal.

After explicit approval, the agent may deliberately make a new send attempt.
The approval handler itself never replays a send. Unknown transport outcomes
remain unknown; they must not be presented as authorization failures or retried
automatically. Inspection remains read-only and never starts the target.

## 8. Storage, Routing, And Account Controls

Recommended placement for this new personal mode:

| Data                                                         | Authority                                       |
| ------------------------------------------------------------ | ----------------------------------------------- |
| Agent/thread identity, placement                             | Existing project owning-bay mechanisms          |
| Personal names and retired names                             | Naming account's home-bay Postgres              |
| Personal connection grants and account pause/revoke controls | Approving account's home-bay Postgres           |
| Run principal and scoped run credential                      | Existing trusted runtime/source-owner records   |
| Chat, ACP work, bounded acceptance evidence                  | Existing project-host/chat execution mechanisms |

Put new schemas/indexes in `util/db-schema/`. Use the existing Conat account-home
and inter-bay routing APIs, not direct SQL against an assumed local account or
project. No new standalone service, global database, credential copying, or
message payload proxy is needed.

Minimal records: names keyed by `(account_id, normalized_name)` with endpoint,
current/retired status, description, and timestamps; grants with immutable ID,
approver/principal, exact endpoints, direction-group ID, approval request ID,
nullable expiry, paused/revoked state, and account generation; account controls
with pause state and minimum accepted grant generation. Enforce one current name
per account/endpoint with a partial unique index. Keep identity references
explicit across bay boundaries rather than inventing cross-database foreign keys.

Keeping this mode's grants at the approving account's home bay makes the global
list and emergency controls authoritative without polling every project. It also
allows both directional grants to be committed in one local transaction after
validating both endpoints. A lost approval acknowledgment can be inspected via
a stable approval request ID; idempotent grant creation is not message replay.
Do not keep two independently authoritative copies of a personal grant.

At send: validate the source run, derive P, route to P's home bay to check the
exact grant/account controls, then reuse target-owner/host admission and normal
project auto-start. Recheck authorization at the final pre-admission boundary,
including after startup waits. Fail closed if required authority is unavailable.
Carry trusted grant/principal attribution; never forward P's reusable token.

Implement a connection list under My Agents for all grants the account authorized,
not just active outgoing links for a currently open thread. Group two-direction
connections into one understandable row. Show endpoints, direction, expiry,
status, last observed attempt, and last observed acceptance. Completion is only
shown when separately known. Expired/revoked connections remain inspectable.

Never expires means a nullable expiry, not a far-future sentinel or immunity to
revocation, access removal, account disablement, or execution gates.

Provide individual Pause/Resume and Revoke; Pause all my connections; and Revoke
all with confirmation. Use an authoritative account pause bit and revocation
generation, not a best-effort loop over remote rows. Resuming does not replay any
work, and new grants do not override an account pause. Fresh approval is required
for new/renewed grants and operations that restore permission; restrictive
controls must remain easy to reach under the existing session policy.

Be precise about the race: pause/revoke blocks subsequent authorization at the
account authority; an already authorized/admitted in-flight call may still finish.
No control retracts received messages or cancels running work. Document any
remaining permit freshness window and test it; do not advertise distributed
instantaneous cancellation. Other humans' independent grants are unaffected.

Activity summaries are best-effort observations with timestamps, not a new
permanent receipt ledger. Missing telemetry does not imply no message was sent.
Failure to update a summary must not change a known accepted result into a
rejection or cause a send retry. Store no message body in the global directory.
Names/descriptions are scoped metadata; expose only what the caller is permitted
to see, and avoid scanning private target transcripts to enrich the picker.

## 9. CLI And Runtime Contract

Proposed interface, not a claim about installed commands:

```text
project chat agent destinations --json
project chat send --to reviewer --stdin --json
project chat agent request-connection --to reviewer
```

Keep an explicit endpoint/reference option for programs and testing. Name lookup
uses the current trusted principal's namespace; a turn-bound selected reference
takes precedence over an unbound textual name. Never select a destination by
fuzzy project title, old prompt constants, or another account's similarly named
agent. Inspect/list operations should explain inactive connections but clearly
separate them from approved destinations usable now.

Discovery returns names and safe context as well as stable references, direction,
expiry, and status. Agents must be able to discover without reading all account
contacts: expose only approved endpoints plus the exact references deliberately
included in their turn for potential approval. The human picker can search their
full personal directory. No account-wide bearer credential is passed to a run.

Keep the existing lower-level RPC command during migration, but enforce the same
principal checks for every path. `--rpc`, explicit IDs, alternate hub calls, or
cached discovery must not bypass personal scope. Send still returns an attempt
ID and accepted/rejected/unknown; acceptance is not completion.

## 10. Implementation Sequence

1. Freeze the principal/grant contract and add deterministic tests first. Introduce
   the opt-in personal-mode schema, authority checks, cross-human steer rejection,
   and automation ownership/revision rules. Preserve RPC execution and startup.
   Gate: two humans sharing one thread cannot use each other's grants by IDs,
   names, discovery, or guidance.
2. Implement names, retired-name handling, metadata-only directory APIs, the visible
   Name agent control, and minimal My Agents page. Gate: names are account-global,
   renames do not retarget anything, and listing stopped projects starts nothing.
3. Extend the shared mention type/provider and serialization. Add composer
   preflight/approval and the scoped CLI/reference map. Gate: a new thread can
   say "tell @reviewer" and set up permission without a prior turn or URL copying.
4. Add in-turn typed renewal, bidirectional/never-expiring controls, and the global
   connection list with pause/revoke and honest activity observations. Gate:
   permission can be understood and withdrawn without opening target projects.
5. Deploy the exact candidate build to the three-bay dev site and both test hosts.
   Run the human-and-real-agent matrix below, fix only issues in this scope, and
   record reproducible evidence before requesting manual testing.

Keep coherent commits by layer and focused tests with each commit. Do not rebuild
the old durable-delivery plan under the guise of approval handling or activity.
If a milestone requires a new queue/reconciler or account-wide live project fanout,
stop and simplify before continuing.

## 11. Validation And Rollout

Deterministic coverage must include:

- Concurrent name creation/rename, retired-name reuse, cross-account same names,
  copied references, unavailable identities, and account-home/project-owner routing.
- Two humans with different reviewers using the same source thread; spoofed
  account/ref fields; explicit-ID bypass attempts; cross-human steering; an
  unrelated collaborator attempting to answer an approval request.
- Automation ownership transfer, unchanged ownership on reads/background status,
  stale queued jobs, and a running turn retaining its original principal.
- Point-of-use grant creation, bidirectional all-or-neither recording, finite and
  null expiry, expired-at-send renewal, lost grant acknowledgment, intentional
  pause/revoke, account pause/revocation generation, and access removal.
- Stopped target/startup deadlines, unavailable host, quota/autostart denial,
  acceptance versus completion, lost send acknowledgment, explicit retries, and
  read-only inspection. Reuse the foundation's deterministic execution adapters.
- Rich-text/Markdown/reference-map round trips; named agents outside a project;
  hyphenated names in mention search; rename after composition; canceled auth;
  multiple mentions; private drafts, focus/caret restoration, and human mentions.
- Global list does not start agents, expose unrelated contacts/message bodies,
  claim unknown activity is zero, or turn telemetry failure into message failure.

Run package-local TypeScript/tests plus frontend lint for changed interactive UI.
Use accessible roles/names in tests. Verify keyboard-only selection/approval,
Escape, focus return, screen-reader labels, 320 CSS pixel width, 200% zoom, and
light/dark mode per `accessibility.md`. Use `UI_COLORS` and existing controls.

Live tests on lite1b, with the human authenticated at their home bay:

1. Name A `builder` and the intended cross-host recv thread `reviewer`. Give B a
   visibly different name. Verify the picker shows project/thread context so the
   old A/B/recv ambiguity cannot recur.
2. Remove any need for preconfigured personal test links. Compose a selected
   `@reviewer`, approve inline with bidirectional communication, and send. Verify
   source discovery, scoped request, target wake/queue, correlated response, and
   no further ping-pong. Capture receipt and execution evidence separately.
3. Stop recv, close UI that could independently wake it, repeat, and verify the
   normal runtime sponsor/autostart policy started it on the other host.
4. Expire a short grant during work, exercise the typed renewal, and explicitly
   resend only after approval. Separately test an unknown transport result with
   no automatic replay or misleading renewal prompt.
5. Pause/revoke from the account page, including while a target is stopped and
   while an owning bay is unavailable. Verify enforcement and honest in-flight
   boundary reporting; resume must not send accumulated messages.
6. Use two genuine human sessions for different reviewers in one shared source
   thread. Do not simulate this by changing a client-provided account ID. Confirm
   principal attribution, disallowed steering, and personal approval ownership.

Before each live operation refresh the matching dev hub environment; invoke the
CLI as `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"`. Use typed
first-party fresh-auth actions, never copied credentials between bays. Inspect
live chat/editor state through supported APIs; browser automation is for UI state.

Ship the prototype behind an explicit personal-messaging flag. Existing shared
RPC grants and old durable pending/uncertain records are not silently converted,
replayed, or erased. For enrolled test agents, reject the old shared-grant fallback
on every send path and restart/expire old run credentials under a controlled
cutover. Historical shared connections may be shown separately as legacy, but
must not appear as newly approved personal links. A failed personal check must
never try legacy authority. Renew/reapprove existing desired connections explicitly.

## 12. Review And Completion

Decisions proposed for review: personal grant authority at account home; same
human principal at both endpoints for this prototype; retired-name reservation;
one-day default with Never expires available; bidirectional unchecked by default;
minimal My Agents directory now, embedded unified workspace next.

The prototype is done when a human can name agents, select `@reviewer`, approve
there, complete a cross-host/cross-bay request and response, renew during a turn,
and inspect/pause/revoke their connections without dealing with IDs or URLs.
The two-human isolation and startup tests must also pass. Document actual build
versions, reproduction commands, outcomes, and limitations. Unit tests alone do
not establish this milestone, and the larger unified workspace is not required
to call this bounded prototype complete.
