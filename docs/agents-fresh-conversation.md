# Fresh Agent Conversations

An agent retains its identity and one current conversation. **Start fresh
conversation** creates a new thread in the same `.chat` file. It does not fork
the provider session or copy messages. It preserves appearance, model, working
directory, payment preferences, notification preferences, and the stable agent
identity used by names and networks. Files are unchanged, including any memory
stored in files.

Previous thread IDs and transition times are recorded in
`agent_identities.conversation_history`. The existing project chat UI can still
display those conversations. A dedicated History drawer, resuming a historical
conversation, and persistent agent instructions are not part of this change.

## Transition Protocol

1. The authenticated registrant requests a switch with the expected current
   thread. The project-owning bay authorizes the operation.
2. The routed project host checks the live thread configuration and refuses
   enabled scheduled work. In the shared ACP SQLite database, an immediate
   transaction rejects running jobs, queued jobs, running turn leases, and
   pending/processing guidance. It then reserves a successor thread ID.
3. SQLite triggers fence further admission and retries against the old thread
   across ACP workers. A durable single-writer preparation claim prevents
   concurrent retries from overwriting the successor's configuration. The host
   persists both collaborative history and the `.chat` file before marking
   preparation complete and returning. Disk-write failures remain retryable.
4. The project-owning bay rechecks access and locks the identity, records history,
   ends old runtime credentials, and switches the thread pointer. Credential
   issuance takes a matching identity-row lock and checks the current thread.
   No host RPC runs inside the Postgres transaction.
5. Directory hydration reads the current thread from the routed identity rather
   than treating the account's cached naming metadata as authoritative.

The host reservation is durable and idempotent. A failed or timed-out preparation
can leave the old thread fenced before the identity pointer switches. The dialog
allows an explicit retry with the same expected thread; that finishes the same
transition rather than creating another successor. A retry after the pointer
has switched returns the current identity without resetting again. There is no
automatic rollback that could reopen old-thread admission during an uncertain
outcome. History is bounded to 1000 transitions per identity for this first
implementation.

A live preparation writer is never displaced on a timeout alone. Its claim is
released after a known failure; a later request can reclaim a crashed process's
claim. OS PID reuse conservatively leaves the claim blocked rather than risking
a competing writer and can require operator recovery.

## Deployment And Review

Deploy the additive `conversation_history` schema column through normal schema
synchronization, updated hub/bay code, updated project-host ACP services, and
the frontend together. Do not expose the new frontend against an old host.
Stop/drain old ACP worker versions as part of the coordinated upgrade.

Request focused security review of project-owner routing, registrant checks,
credential issuance versus pointer switching, admission fences, replay after
partial failure, and unchanged network authorization. Also smoke-test a running
agent rejection, an idle reset, preserved settings/networks, a fresh first turn,
and incoming agent messaging after reset. Unit and PGlite tests do not replace
that live multi-service smoke test.
