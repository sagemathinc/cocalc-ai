This directory contains the lite-side implementation of Codex ACP (Agent Control Protocol). It wires the Codex agent to CoCalc’s messaging fabric, persists streamed events, and mirrors them into the chat syncdb so the frontend sees live progress and the final turn result.

Key pieces:

- `index.ts` boots the ACP server for lite mode and streams results into chat via `ChatStreamWriter`.
- `ChatStreamWriter` uses bounded ephemeral AStreams for live log updates and
  project-scoped AKV storage for replay. SQLite records track turns, queues,
  sessions, workers, and interrupts; those are distinct from live event delivery.
- Tests already exist in [**tests**](./__tests__), including chat writers,
  interrupts, and worker recovery. The project-host also reuses this directory;
  the `lite` package location does not mean every caller is single-user.

## Human-Scoped Execution

The authenticated ACP subject fixes the turn's account. Guidance must match
that principal at both durable admission and the live Codex call; a rejection
does not silently create a queued turn. Ordinary queued messages retain their
own submitting account.

Human automation settings saves replace the account and `settings_revision` in
the canonical automation store. Scheduled jobs capture both; stale or unstamped
queued work is canceled, never rebound to a new human. Reads, acknowledgments,
and status writes preserve responsibility. Already-running requests keep their
original account.

Automation mutations use the typed ACP automation subject, bound to the
authenticated account and project. Hub and Lite authorization deny project-agent
credentials on this subject. Project-host authorization requires the signed
`auth_actor: "account"` claim; agent tokens carry `"agent"`, and older unmarked
tokens must be refreshed before changing schedules. Neither payload fields nor
client handshake claims establish human provenance. Normal human CLI scheduling
uses this same path, without falling back to another saved credential.

This is deliberately a whole-subject restriction: transport authorization cannot
inspect the action payload. `acknowledge`, `run_now`, and `delete` therefore also
require human credentials, even when they do not replace the settings writer.
There is no read/status action on this RPC subject. Agent reads of the existing
chat-file automation metadata (including CLI `automation status`) remain allowed
by their normal project-file permissions. No separate read protocol or implicit
human-credential fallback is introduced.

If both the local scheduler row and canonical project index are unavailable,
control recovery may rebuild from the collaborator-editable chat projection.
That exceptional recovery never infers historical authority from the projection:
the authenticated caller explicitly assumes responsibility under a fresh settings
revision. In the normal indexed path, `acknowledge` and `run_now` continue to
preserve the existing settings writer.

Scoped identity leases are process-bound, so a subsequent turn starts a fresh
app-server process while resuming the model session. This costs a process startup,
authentication and session resume per turn. Existing subagents/background commands
are not killed to switch identity: new scoped turns are refused until they finish
or are explicitly stopped. Same-UID filesystem access remains shared, not a sandbox.

`COCALC_AGENT_MENTION_REFERENCES_FILE` points to a mode-0600, per-turn JSON file
beside the freshly installed identity: `{agent_id,run_id,references:[{name,target}]}`.
It contains no token or grant and is removed on turn completion. Only current
human input is bound; automation, incoming agent content, and transcript history
do not populate the map. Copied references retain their original target, with
access checked under the submitting account. Actual sends still require that
account's authorization and retain accepted/rejected/unknown RPC outcomes, with
no automatic replay after approval or an unknown outcome.

## Inspection Rollout

Retained attempt evidence is always keyed by the trusted envelope `account_id`,
including in-flight deduplication. This isolation does not depend on the local
personal-messaging feature flag. Inspection must forward the authenticated
principal to the host; missing or different principals return `unknown`, without
searching legacy unscoped evidence or starting a project. Older callers that omit
the principal therefore lose inspection evidence rather than cross scopes.

Deploy the updated authorization/token issuer and host/ACP workers together;
refresh existing human project-host tokens for schedule mutations. Browser token
caches are in memory: reload the browser after issuer deployment to obtain a new
token. Start a new human CLI invocation to discard its in-memory host-token cache
(restart a long-lived CLI process if applicable). An old unmarked token continues
to allow normal ACP turns but not automation operations; refresh does not replay
a failed mutation. Enable the
personal-messaging flag consistently wherever personal authorization is evaluated,
but mismatched flag configuration cannot expose another principal's retained
host evidence. RPC acceptance guarantees, bounded retention, and no-retry behavior
are unchanged.
