# Registered Agent Messaging: Experimental V1

## The Abstraction

A registered agent is a durable UUID bound to one project, chat path, and thread.
A human approves a directed, expiring grant from A to B. A runtime credential
proves the source identity; it is not the permission grant itself. Knowing B's
UUID does not authorize sending to B.

This implementation is stacked on the `project chat send` PR. It adds a separate
send-only identity connection, not a replacement for all existing agent tools.
The normal own-project credential remains available for files, notebooks, etc.
The identity messaging path never falls back to that credential or a saved
account profile.

## Scope and Ownership

- Off by default. Set `COCALC_AGENT_MESSAGING_ENABLED=1` on the owning bay's hubs
  and participating project hosts to opt in after deploying matching builds.
- Source and target projects must resolve to the current bay. They may run on
  different project hosts. Cross-bay and cross-site links fail closed in V1.
- Human registration requires current collaborator access and fresh,
  session-bound authentication. No bearer or agent credential can mint grants.
- Link approval requires collaborator access to both projects and must come
  from the target's registrant. The target runs using that registrant's account,
  not the sender's account. Views/read-only membership do not suffice.
- Each grant allows sending to one target identity. Guidance is separately
  authorized. No reverse link, project read access, file transfer, or account
  management is implied.
- A grant lasts 60 seconds to 30 days. Revocation stops new dispatch and is
  checked again before queued work starts. It does not retract already-read
  content or cancel an already-running model turn.
- The DKV presence registry is unchanged. There is no global agent UI,
  automatic identity migration, or link artifact UI in this slice.

## Where Data Lives

The owning bay's PostgreSQL database holds four additive tables:

- `agent_identities`: stable agent UUID, project/path/thread, name, registrant,
  creation and disable metadata. Project/path/thread is unique.
- `agent_identity_runs`: runtime incarnation, execution account, token hash,
  issue/expiry/end times. Plaintext credentials are never stored here.
- `agent_message_grants`: directed permission, guidance flag, approval actor and
  reason, expiry and revocation.
- `agent_message_inbox`: bounded message body, source/run, target, grant,
  idempotency key and delivery state.

Tables are initialized transactionally behind an advisory migration lock only
when the feature is enabled. They are not exposed through SyncDB or changefeeds.
Delivered messages become ordinary records in the target's live chat SyncDB;
the existing project-host agent job queue owns execution after dispatch.
Account references are UUIDs, not foreign keys requiring the account's canonical
record to live in this project's bay; authorization uses the existing account
and project-access mechanisms.

The hub-mediated delivery of a bounded coordination message is an intentional
control-plane exception. It is not a general-purpose project-data proxy. Chat
access uses the existing routed, account-authorized project-host client; file,
terminal, notebook, and other steady-state traffic retain their existing paths.
Federation will need destination-bay authorization and durable forwarding, not
direct queries against another bay's tables.

One temporary cost is explicit: the shared chat submission helper opens the live
chat SyncDB in the hub to find thread configuration and append the message. This
can materialize more than the submitted message. Reusing the validated chat-send
path avoids inventing another writer in this experimental slice, but a narrow
project-host submission endpoint should replace this before scaling it broadly.

## Credentials and Trust Boundary

The trusted project host issues an opaque ten-minute credential for a registered
thread, bound to a runtime incarnation (`run_id`). It writes a separate mode-0600
`identity.json` in the private runtime directory and sets
`COCALC_AGENT_IDENTITY_FILE`. Renewal runs every three minutes; only the hash is
kept in PostgreSQL. Closing the app-server runtime ends the credential and removes
the file; abrupt host loss leaves at most its remaining lifetime. Renewal does
not reset the original issue time or revive an expired/ended run.

In V1 the incarnation is the app-server process, which can span multiple turns,
not a per-turn credential. Register before starting a fresh Codex session to get
the environment injected. Existing already-running app-server processes are not
silently restarted or modified.

The WebSocket derives identity from the token, not caller-supplied IDs. It permits
only the exact source/run messaging subject and an isolated reply inbox. It
checks current credential validity and membership without an allow-cache. The
message service independently checks source identity and grants.

Agents sharing one project/Unix UID are NOT a security boundary: they can often
read each other's files or credentials. Use separate CoCalc sandbox projects for
mutually untrusted agents. Do not place broad human credentials in those
sandboxes. Attribution means a host-issued credential for that identity, not
cryptographic proof that a particular model generated the text. Incoming text
is labeled as agent-provided content, never as new human authorization.

## Delivery Contract

`project chat send --to-agent ID` accepts text, including JSON via `--stdin`.
Bodies are limited to 32 KiB UTF-8. Normal sends start an idle agent or queue
behind active work. `--guidance` uses the existing steer-or-queue path, but only
when the grant explicitly allows guidance.

The returned request ID is an idempotency key per source identity. Retrying the
same request ID/body/target/mode returns the existing receipt. Changing the
payload with that ID fails. Supply `--request-id UUID` in scripts; after a
transport error, do not invent a new ID and blindly resend.

Receipt states are deliberately narrower than execution status:

- `pending`: durably accepted by the hub inbox, not yet sent to the target.
- `dispatching`: a worker owns the attempt.
- `dispatched`: the target backend acknowledged queued/running/steered. It does
  not mean the task has completed or that a queued task passed later checks.
- `rejected`: dispatch could not begin, including revoked/expired authorization.
- `unconfirmed`: submission may have happened, but acknowledgement was lost, or
  the worker died during dispatch. No automatic replay of this ambiguous attempt.

Workers claim rows with `FOR UPDATE SKIP LOCKED`. A stale dispatch attempt becomes
unconfirmed after five minutes. Pending work survives hub restart. Per source,
admission is limited to 60 new messages/minute and 100 pending messages. These
are bounded experimental defaults, not billing limits or a general scheduler.

## CLI Workflow

Use a freshly authenticated human CLI outside the agent sandbox to register both
existing threads and approve the link. The runtime's existing scoped credentials
cannot approve these operations. Replace the placeholders below with real IDs.

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat agent register --project SOURCE_PROJECT --path /home/user/a.chat --thread-id SOURCE_THREAD
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat agent register --project TARGET_PROJECT --path /home/user/b.chat --thread-id TARGET_THREAD
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat agent link SOURCE_AGENT TARGET_AGENT --ttl-seconds 86400 --reason "Review completed changes"
```

Start a fresh source agent session, then the agent can use its injected identity:

```sh
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat send --to-agent TARGET_AGENT --request-id REQUEST_UUID "Please review my change."
"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" project chat agent receipt REQUEST_UUID
```

Human controls: `project chat agent list --project PROJECT`,
`project chat agent revoke GRANT_UUID`, and `project chat agent disable AGENT_UUID`.
There is no disable reversal in V1. Existing ordinary account-authorized
`project chat send --project ... --path ... --thread-id ...` continues to work.
In a registered runtime the same explicit project/path/thread form instead uses
the narrow identity connection and requires project UUIDs, not name discovery.

## Qualification and Remaining Gates

Automated tests cover the protocol, real WebSocket authentication and denial,
PostgreSQL-compatible persistence using PGlite, approval checks, token rotation,
expiry, removed membership, revocation before dispatch, duplicate sends, separate
guidance permission, private runtime files, and ambiguous dispatch receipts.
Model execution is mocked in the integration suite; no paid AI tests run in CI.

Before enabling on a shared deployment, run this opt-in live smoke on a matched
hub/project-host/CLI stack in two disposable projects:

1. Register A and B, approve A-to-B without guidance, and start a fresh A session.
2. Ask A to send B a small request. Verify a single attributed chat message and a
   new B turn with no browser open. Poll the receipt and actual B activity.
3. While B is busy, send two normal messages and verify they queue. Guidance must
   fail until separately approved, then steer without starting duplicate work.
4. Retry a request ID, then change its payload. Verify one delivery and a conflict.
5. Revoke the grant with work queued. Verify later work does not start. Repeat
   after removing a collaborator, disabling an agent, and expiring a grant.
6. Restart a hub with pending work. Inject an acknowledgement loss and confirm
   an honest unconfirmed receipt with no automatic guidance replay.
7. Test backup/restore and rollback with the new tables retained. Restoring an old
   database may resurrect grants; start with the feature disabled, revoke old
   runtime credentials/grants before reenabling. Do not drop the additive tables
   as part of a code rollback.

This work does not deploy or enable the running site. Live paid-model delivery,
cross-host execution, and packaged backup/rollback still require qualification.
The installed CLI must actually contain these commands; documentation alone does
not upgrade an older runtime.
