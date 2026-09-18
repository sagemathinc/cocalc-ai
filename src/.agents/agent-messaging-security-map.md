# Agent messaging reviewer map

Working inventory, not a security sign-off. Review against the comparison base
in `agent-messaging-release-progress.md`, including shared infrastructure changes.
Suspected findings and exploit details belong in the private SECURITY.md workflow,
not this tracked document.

## Contract and threat model

Human-approved, human-scoped, single-attempt RPC. `accepted` is destination
admission, not execution completion; a lost acknowledgment is `unknown`, not
rejection. Inspection must not start work. Retrying is an explicit new action;
there is no durable delivery promise, outbox or automatic retransmission.

Treat message text, file names, manifests, binary payloads, mentions, target IDs,
external labels and caller-supplied routing/principal fields as untrusted.
Consider malicious authenticated accounts, malicious agents with valid narrow
credentials, revoked clients retaining connections, compromised external
installations, concurrent lifecycle changes and resource exhaustion.

Human-scoped grants are API authorization, not process/file isolation within a
project. Collaborators and agents sharing one project OS user can influence
shared files and may read same-user process credentials. Do not advertise
private capabilities against that OS principal. Received text/files can contain
prompt injection; authenticated attribution is not a claim that content is safe.

## Authority and entry points

| Boundary | Authority and code to examine |
| --- | --- |
| Human API calls | Hub-authenticated account/session; `server/conat/api/agent.ts`, shared hub dispatcher, `server/agents/personal.ts`. Caller payload cannot select a different principal. |
| Human approval | Account-home fresh session, second factor when enabled, no actor impersonation; `server/conat/api/dangerous-session-auth.ts`, `server/agents/external.ts`, frontend approval/account-binding helpers. |
| Names, personal grants, installations | Account `home_bay_id`; `personal-store.ts`, `external-store.ts`, `personal-rehome.ts`, account directory/rehome fences. A receiving/local bay is not automatically authoritative. |
| Native source | Authenticated agent/run identity plus execution account; `server/agents/store.ts`, `messaging.ts`, `rpc.ts`, project ACP runtime. Thread text and mention labels must not grant authority. |
| External sender | Separate stable agent identity plus expiring/revocable installation credential; `server/auth/cli-auth.ts`, HTTP `auth/cli/agent/*`, `server/agents/external*.ts`, CLI external profile/message code. No native identity impersonation or general account/project API access. |
| Cross-bay route | Account home, project `owning_bay_id`, host `bay_id`; `conat/inter-bay/agent-rpc.ts`, `server/agents/rpc.ts`, inter-bay directory/fabric and project-host routing. Public callers cannot manufacture sealed inter-bay attestations. |
| Receiver admission | Destination project owner and host, authenticated target execution principal, current grants, membership, project automatic-start and execution/quota gates; project-host agent RPC and lite/hub ACP service/authorization. |
| Attachments | Source local regular-file read; destination sandbox filesystem staging; `conat/agents/attachments*`, CLI attachment reader, project-host preparation/staging. Same-project references are mutable paths, not snapshots. Cross-project payloads are snapshots. |
| Transport | Shared `conat/core/client.ts`, receive budget/fragment assembly and service queue changes, plus authentication/subject permission changes. These affect callers outside messaging too. |

Paths above are relative to `src/packages` unless abbreviated within the same
directory. Follow imports and the complete diff; this table is not a whitelist.

## Credential and lifecycle invariants to prove

- Human approval binds exact source, destination, human, direction and duration.
  Two directions are two permissions, not an unrestricted reply privilege.
- Renaming resolves to a stable identity; stale names/mentions cannot silently
  redirect authority. A mention alone is not a permission.
- Native credentials are run-scoped; external credentials are installation-scoped,
  hashed at rest and unavailable in public metadata. Revoking one installation
  does not require deleting its identity or history.
- External login cannot mint a human session, browse arbitrary projects, grant
  itself destinations or receive messages as a native thread.
- Fresh approval, account changes, suspension, membership changes, revocation
  and expiry remain effective across asynchronous startup/staging/admission.
- Cross-human steering is denied; target work uses the authorized execution
  account. Scheduled work retains its recorded responsible account.
- Management survives site-off: inspect and reduce authority, never resume or
  create it through a management exception. All owner/auth checks remain.

## Resource and filesystem boundaries to measure

Current intended attachment bound: 32 MiB total / 16 files, binary MsgPack,
bounded metadata. Host admission: four concurrent operations globally / two per
project. Preparations expire after 30 seconds. Verify actual values and every
allocation path, including negative cases and timeout cleanup.

RPC subscription budgets (33 MiB message / 132 MiB incomplete bytes in some
paths) are NOT a process-wide RSS bound. Include simultaneous subscriptions,
encoded/decoded copies, outbound buffers, queued complete messages, transient
filesystem buffers and repeated installations in measurements. Existing 64 MiB
project-copy traffic must retain its documented behavior.

Verify rejected startup/quota checks do not stage attachments or append a
text-only message. Attachment failures must not silently downgrade a send.
Test symlinks, file mutation, traversal, special files, destination races,
permissions, partial writes, disk exhaustion and cleanup confinement. Random
destination `/tmp` directories are ephemeral and not backup/durability promises.

## Release gate

Independent review is still required. Record exact clean SHA, build versions,
mock-versus-real test provenance, RSS measurements, dev deployment outcomes,
known limitations and rollback procedure before presenting a candidate.
Do not describe the current inventory or passing unit tests as proof of security.
