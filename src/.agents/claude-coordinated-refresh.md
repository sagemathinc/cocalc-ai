# Coordinated Claude Subscription Refresh

Status: initial serialized implementation. Different subscriptions and API-key
turns remain independent. Temporarily, the UI allows one Claude subscription
connection per account; existing explicit credential references are preserved.

## Authority And Lifecycle

The account home bay owns both the encrypted subscription bundle and private
`external_credentials.controller_ownership`. Host RPCs reauthorize the host,
project, account, and credential. Inter-bay forwarding resolves account ownership;
project tools and native Claude traffic retain their isolated/direct paths.

A controller acquires an opaque holder UUID before reading credentials or
starting native Claude. Other work sharing that credential waits before any
model/tool execution. Agent startup supports cancellation and a bounded wait;
usage/discovery have a shorter wait. Polling is not a strict FIFO scheduler.

Ownership does not expire. A TTL cannot stop an isolated native process from
refreshing at the provider. Publication requires the current holder, host, and
project in the same transaction as payload CAS. Legacy writers are rejected for
managed credentials. Opaque file conflicts are unresolved, not proof that one
token is newer. No automatic paid-turn replay or payment fallback is added.

After each subscription turn, the native controller is stopped, its final
credential files are published, and ownership is released. The next controller
rehydrates the latest bundle and resumes the same native conversation. This also
discards the SDK's in-memory credential cache. API-key controllers retain their
existing lifecycle.

Reconnect reserves the same credential before opening native sign-in. A busy
credential asks the user to finish the active turn. Publication must retain the
same provider account and explicit credential ID. Adding a second subscription
is hidden in the UI, not a destructive migration of existing credentials.

## Recovery And Diagnostics

Private host journals persist ownership references, worker fingerprints, and
the opaque baseline outside all project/controller mounts. The reaper confirms
native controller removal, publishes its final files, and then releases. A dead
worker alone is not sufficient proof of stopped provider activity. Missing homes,
unconfirmed shutdown, and conflicting revisions retain ownership for operator
reconciliation. Recovery does not execute the user's turn again.

Sign-in recovery records similarly retire reservations after a confirmed stop.
An uncertain submitted code exchange is quarantined with its host-private home:
it may have rotated the provider credential without publishing it. Operators
must confirm all relevant native processes are stopped, reconcile the registered
bundle using the same account, and retire the exact holder through the authorized
host API. Do not simply clear ownership or create another subscription. Automated
reconciliation of ambiguous sign-in exchanges and permanently lost host homes
remains follow-up work.

Retired holder UUIDs are retained so a delayed acquisition cannot revive stopped
work. They are currently stored with the credential row; there is no time-based
pruning without a bound on delayed admission. At scale, move these tombstones
to a dedicated indexed ownership-attempt table with an explicit retention/fencing
protocol rather than truncating them.

Controller logs contain opaque holder/revision identifiers, turn references,
and fixed failure categories, not provider output or token bytes. Host-private
SQLite `acp_job_attempt_history` preserves worker/version, timestamps, state,
and fixed failure category when retry replaces the current job state. No public
credential or attention serializer includes ownership or recovery metadata.

## Rollout And Validation

1. Add the account-home schema and deploy the matching hub/inter-bay methods.
2. Drain legacy subscription controllers on every affected host before enabling
   coordinated workers. A legacy controller can still refresh at the provider
   even when its database publication is fenced. Do not mix native refreshers.
3. Upgrade ACP workers and sign-in services, then the UI. Preserve unrelated
   staging changes in the integration build. No production rollout is implied.
4. Exercise two agents sharing a credential, cross-host admission, queued cancel,
   usage/discovery contention, native-session resume, reconnect, revocation,
   final rotation during tool execution, and worker-crash/lost-ack recovery.

Deterministic tests use synthetic bundles and native harness fixtures. They
retain the existing anti-clobber coverage and do not refresh real credentials.
Live provider validation requires a separately authorized connected staging
subscription; synthetic tests alone do not establish real provider behavior.
