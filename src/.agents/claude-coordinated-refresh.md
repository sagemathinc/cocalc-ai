# Coordinated Claude Subscription Refresh

Status: initial serialized implementation. Different accounts and API-key
turns remain independent. Temporarily, the UI allows one Claude subscription
connection per account; existing explicit credential references are preserved.

## Authority And Lifecycle

The account home bay owns both the encrypted subscription bundle and private
`claude_controller_ownership`, keyed by account and the fixed Claude profile.
The record survives credential revocation/replacement and remains occupied until
confirmed release. New credential creation enforces one active subscription on
the backend regardless of caller limits. Existing multiple rows are preserved
and share this fence; explicit bindings never silently select another row.
Legacy row fences (including revoked rows) are honored during upgrade.
Host RPCs reauthorize the host,
project, account, and credential before admission and during ordinary use.
After confirmed native stop, a separate write-only finalization RPC uses the
stored exact holder/host/project/incarnation binding, even if project access or
placement has since changed. It atomically CAS-publishes the final bundle and
retires ownership; it never returns credentials, revives a revoked row, or grants
launch authority. Exact binding and final-digest tombstones make lost-ack retries
safe after a newer owner acquires. Inter-bay forwarding resolves account ownership;
project tools and native Claude traffic retain their isolated/direct paths.

A controller acquires an opaque holder UUID before reading credentials or
starting native Claude. Other work sharing that credential waits before any
model/tool execution. Agent startup supports cancellation and a bounded wait;
usage/discovery have a shorter wait. Polling uses capped jitter/backoff; it is not
a strict FIFO scheduler. First-turn cancellation recognizes the CoCalc chat
thread before a native session exists and aborts the pending admission signal.
Every acquisition poll rechecks project/account access
and credential revocation before native launch.

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

Every sign-in reserves account ownership before opening native authentication,
including the first sign-in before any credential row exists. Reconnect retains
its explicit credential binding. A busy
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
Login and status run in separate named Podman PID namespaces, with only the
native home writable; recovery records remain outside that mount. The private
journal is written before launch. Separate create/start operations prevent a
late create acknowledgement from executing native authentication after worker
death. Removal of both namespaces, followed by a successful host process
inventory, precedes publication or release. Mutable environment markers are not
shutdown proof. Legacy uncontained sign-in homes require operator reconciliation;
they are not automatically released merely because the parent or marker vanished.
An uncertain submitted code exchange is quarantined with its host-private home:
it may have rotated the provider credential without publishing it. Operators
must confirm all relevant native processes are stopped, reconcile the registered
bundle using the same account, and retire the exact holder through the authorized
host API. Do not simply clear ownership or create another subscription. Automated
reconciliation of ambiguous sign-in exchanges and permanently lost host homes
remains follow-up work.

Retired holder UUIDs are retained so a delayed acquisition cannot revive stopped
work. They are currently stored with the account/profile record; there is no time-based
pruning without a bound on delayed admission. At scale, move these tombstones
to a dedicated indexed ownership-attempt table with an explicit retention/fencing
protocol rather than truncating them.

Ownership records include native-holder UUID, host/worker incarnation, purpose,
monotonic generation, active/released state, and transition timestamps. Recovery
publishes/releases using the journal's original incarnation rather than its own
worker identity. No automatic age-based takeover or user quarantine-clear exists.
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

A credential-free staging2 canary test exercised the new argument builder and
shutdown implementation on the actual host runtime: a detached, orphaned
grandchild with a sanitized environment was stopped by namespace removal, and
repeat removal succeeded. This verifies containment, not live provider renewal.
