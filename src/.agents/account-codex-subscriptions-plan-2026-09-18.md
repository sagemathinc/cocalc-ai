# Multiple ChatGPT subscriptions per CoCalc account

Status: proposed implementation plan; no implementation or security sign-off yet.
Related: [#633](https://github.com/sagemathinc/cocalc-ai/issues/633).
Code baseline: `origin/main` at `9398d39131` (2026-09-18).

## Goal and scope

A CoCalc account can connect more than one ChatGPT subscription, select one for
its next Codex turn, and see the selected identity in the existing Codex bar.
Subscriptions remain account-owned and usable across that account's projects.
An account with one subscription keeps working without reconnecting.

Deliver this in **three focused implementation PRs**, using the existing encrypted
credential registry, device login, account settings, payment-source menu, and
Codex runtime. Independent security/abuse review must pass before release.

In scope:

- Add, list, reconnect, and remove account-owned ChatGPT subscriptions.
- Show email, plan when available, and an optional short user label.
- Select a particular subscription for the next manually submitted chat turn,
  including continuing an existing thread with its context intact.
- Resolve the choice at execution admission and preserve it through that
  admitted execution's internal retries, token refresh, and runtime lifecycle.
  Recovery of an unsent browser-outbox message is a new admission and uses the
  thread's current next-turn choice.
- Preserve existing implicit/default subscription behavior for older callers.

Deferred: multiple API keys, new project/organization/shared credentials, credential
delegation, automation configuration, new CLI management commands, quota-based
rotation, automatic failover, aggregate usage dashboards, new billing policy,
Lite/shared-home multi-login, and codex-router integration. Existing single API
keys and Membership/Luna choices keep their current behavior and restrictions.
Ordinary shared-project use still needs correct account isolation; that is a
required boundary test, not a new sharing feature.

## What already exists

Paths below are relative to `src/packages`.

| Existing piece                                                                                           | Minimal change needed                                                                                                                                                                                             |
| -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `util/db-schema/external-credentials.ts`, `server/external-credentials/store.ts`                         | Rows already have UUIDs, provider/kind/scope, encrypted payloads, and metadata. Add explicit create and owner-checked operations by ID for subscriptions; avoid the current category-wide upsert for new entries. |
| `server/external-credentials/routing.ts`, `codex-subscription-refresh.ts`                                | Keep account-home routing and row-locked refresh; make the target credential explicit.                                                                                                                            |
| `project-host/codex/codex-device-auth.ts`, `codex-auth-registry.ts`, `codex-auth.ts`                     | Extend login and registry calls with an exact credential identity; isolate the currently account-wide auth home and caches.                                                                                       |
| `util/ai/codex.ts`, `conat/ai/acp/types.ts`, `ai/acp/codex-app-server.ts`                                | Add an optional credential reference to turn configuration and runtime identity. Preserve existing session resume and outstanding-work checks.                                                                    |
| `frontend/account/codex-credentials-panel.tsx`, `frontend/chat/codex.tsx`, `use-codex-payment-source.ts` | Expand the current subscription panel and payment menu; do not introduce another settings page or composer.                                                                                                       |

Today subscription upsert and lookup select by account/category, and payment
discovery picks the first subscription row. Merely inserting more rows would make
selection depend on update order. All subscription consumers need a deliberate
ID/default rule before a second entry can be created.

## User-visible behavior

Account settings shows a compact subscription list: email, plan if known, optional
label, connection status, and Reconnect/Remove actions. **Add ChatGPT subscription**
uses the existing device-login flow and its existing project requirement. Display
the connected identity before making the entry selectable. A failed or canceled
login leaves existing entries untouched. Reconnect targets one row and must not
replace it with a different ChatGPT identity; use Add for a different identity.
Recognize duplicate provider account/workspace identities so signing into the same
subscription does not create competing copies of its refresh state. Email alone
is not a unique identity or an authorization check.

The Codex bar shows, for example, **ChatGPT: alice@example.com** with a visible
dropdown arrow. Its menu lists the account's connected subscriptions, a checkmark
on the selected entry, and a Manage subscriptions link. Keep the existing other
payment choices. Long identities truncate with the full identity available on
focus/hover; labels and plan information disambiguate entries where needed.

The choice means **next turn**. Remember it using account/project/thread-scoped
private browser state, not shared thread `acp_config`; cross-device preference
sync is deferred. Another collaborator sees their own choices. Changing the choice
while a turn runs must distinguish the running turn's source from the next-turn
choice. An unavailable saved selection stays visibly unavailable until the user
reconnects or chooses another source; do not silently reset it.

Switch between subscriptions using the existing session resume path. If a runtime
still owns active subagents or background commands, retain the existing refusal
to replace it and explain how to proceed. A "Send Immediately"/steering request
cannot change the active turn's credential: reject a conflicting selection with
a clear instruction to queue a new turn or wait. Normal queued turns capture their
own selection at submission.

## Smallest backend contract

Keep the existing `paymentSource` enum. Add an optional, opaque `credentialId` to
the per-turn request configuration. For this release it is accepted only with
`paymentSource: "subscription"` and resolves only to an active, account-scoped
OpenAI ChatGPT subscription owned by the authenticated submitting account.
Reject unsupported combinations. Do not add it to the shared thread settings.

The credential UUID is a selector, never a bearer capability. Client-supplied
account IDs, chat authors, thread settings, labels, and credential metadata do not
establish ownership. Reuse the authenticated request principal and existing host
authorization path; check both credential ownership and access to the target
project. Account home bay remains authoritative for personal credentials; project
owning bay and host routing remain unchanged. Keep turns on the current direct
project-host data path.

At admission, resolve and record the exact credential ID with the authenticated
principal in the existing trusted job/request record. Validate again before queued
execution and before fetching/refreshing credential material. A queued
turn must not reread the composer's current selection. Allow token rotation for
the same saved identity; do not pin an old access token. Reconnecting must preserve
that logical identity or require a new entry. Subagents retain their parent
runtime's credential. Browser-outbox recovery of a message that was never
admitted intentionally reads the current thread selection; it does not alter an
already-admitted execution or its internal retries. Agent messages and automations gain no new ability to select
or inherit somebody else's personal credential.

Return only a bounded, allowlisted descriptor to the owner's UI: ID, label,
email/plan when available from the authenticated login result, connection status,
and an opaque revision for cache invalidation. Treat display metadata as untrusted
text. Tokens and `auth.json` stay on the existing secret-handling path; do not put
them in browser storage, chat data, URLs, or logs. Keep email/labels out of shared
thread metadata. Any persisted request reference exposed by existing job APIs is
non-secret, does not grant access, and must not expose the credential descriptor.

## Default compatibility and runtime isolation

Use the existing subscription row as the stable **legacy default**, retaining its
UUID and encrypted payload. Record that designation in existing credential
metadata, serialized per account at its home bay. Backfill lazily and atomically
before permitting an additional entry: choose the record that the old resolver
would have used once, then retain that choice. With no prior subscription, the
first successful login establishes the default. No new default-selection UI is
needed in this release. The designation is server-owned, not client-writable
metadata. Legacy no-ID login targets this default slot; after its removal, an
explicit new legacy login can establish a replacement without reviving the old
credential UUID. Adding an additional subscription does not change the default.

Omitting `credentialId` continues to use that designated default for subscription
resolution. Add/reconnect/refresh must not choose a default by `updated` order or
overwrite another entry. Preserve the designation during metadata updates and
revocation; removing the default must not promote another saved subscription.
The existing Auto source precedence still applies when its default subscription
is unavailable. An explicitly selected subscription never falls back to another
subscription, API key, or Membership funding on auth, quota, or network failure.

Extend all subscription read/write/touch/revoke/refresh paths consistently,
including legacy no-ID calls. Preserve existing API-key upsert semantics. Prefer
small helpers and existing row locks to a generic credential framework or new
tables. Creation and default assignment must be safe against concurrent logins;
refresh/reconnect updates must target the same non-revoked row and must not
resurrect a removed credential.

Host auth directories, login sessions, runtime/context identity, cache keys,
refresh callbacks, and cleanup must distinguish `(account_id, credential_id)`
(and project/runtime dimensions already present). Runtime matching must use the
resolved ID, even for a no-ID/default request. Usage/model discovery must query
the selected subscription and include its ID/revision in existing caches. Do not
start a process or poll usage for every saved subscription on page load.

Use temporary isolated auth storage during Add/Reconnect, then publish the result
to its intended row after verification. Hydrate new host caches from the registry;
never guess which new entry owns an old account-wide cache. Keep existing
project-local conversation/session storage so credential changes do not clone or
reset chats. Extend existing cleanup to bound abandoned logins and cached copies.
Revocation blocks subsequent admission and refresh even with a warm cache; document
that a token already issued to a running process is not retroactively invalidated
at the provider. Reuse existing teardown behavior instead of adding a new global
process-killing service.

## Implementation PRs

### 1. Account subscription records and login lifecycle

Add narrowly scoped create/update/get-by-ID helpers, stable default resolution,
owner-only summary DTOs, and corresponding routed Conat operations. Extend the
device login/reconnect/upload entry points to target isolated pending storage and
one exact record; preserve existing fresh-auth requirements. Carry the ID through
registry synchronization and locked token refresh. Keep creation of additional
entries disabled until the runtime work and release review are complete.

Verification: existing one-subscription callers, concurrent Add, duplicate login,
canceled/failed reconnect, wrong-owner/wrong-kind IDs, default stability after
refresh, and revoke-versus-refresh races. Test routed account-home ownership as
well as the one-bay case. Inventory all category-based subscription callers so an
unconverted writer cannot update whichever row was most recently refreshed.

### 2. Exact subscription selection throughout a turn

Add the optional turn field, authoritative resolution and immutable request
snapshot, host/runtime isolation, selected-subscription usage/model discovery,
and retry/recovery propagation. Extend existing runtime replacement checks and
cache cleanup. Older no-ID callers use the stable default; automation settings
and CLI syntax do not gain new options in this PR.

Verification: two subscriptions for one account running in separate threads,
two collaborators submitting to the same project, A-to-B continuation preserving
context, queued/recovered A remaining A after the UI selects B, steering conflicts,
active subagent/background-work restrictions, selected-credential refresh failure,
and revoked/stale references. Assert that no fallback bills another source and
that model/usage results do not leak across selections.

### 3. Account settings, Codex bar, and release verification

Expose Add/label/Reconnect/Remove in the existing account panel and subscription
selection in the existing bar. Wire private selection into manual send and queue
paths, clear account-scoped UI caches on account changes, and show the actual
resolved identity and actionable connection errors. Apply existing accessibility
and theme guidance; keep layout changes local.

Verification: browser walkthrough with one then two real test subscriptions,
single-account multi-project use, switching threads, existing-session continuation,
and failed/revoked selection. Cover keyboard operation, screen-reader labels,
light/dark themes, and a narrow viewport. Run focused backend/runtime/UI tests,
affected package typechecks, formatting, and `pnpm -C src lint:frontend`.
Independent review and staged enablement below are part of this PR's release
criteria, not a later hardening project.

Only split a PR further if review size requires it; that is not permission to add
API-key multiplicity, new providers, or a new routing/authentication architecture.

## Independent security/abuse review and rollout

Reviewers must receive the final diff, request/credential flow, relevant tests,
and rollout behavior. Review the boundary-changing PRs and the assembled feature;
record independent sign-off and close all blocking findings before enabling it.
This plan does not claim that review has happened. If implementation discovers
an existing suspected vulnerability, follow [SECURITY.md](../../SECURITY.md) and
handle it privately before disclosing details in a public PR.

Required review evidence:

- A different account or collaborator cannot list, select, reconnect, refresh, or
  revoke an owner's entries by supplying a UUID or forged account/chat fields.
  Scope lookup to the owner and use non-revealing unavailable errors for other
  accounts' IDs. Test direct RPCs, not only menu filtering, including the
  cross-bay path.
- Admitted execution retries and host refresh preserve the admitted principal
  and credential; unadmitted browser-outbox recovery performs a new admission
  using the current thread selection;
  an ID is not a new delegation mechanism. Revocation and login cancellation
  cannot be undone by delayed writes or stale cached auth.
- Concurrent logins/turns/refreshes do not overwrite another subscription, mutate
  the stable default, or cross-contaminate runtime and discovery caches.
- Existing fresh-auth, provider verification, token redaction, secret-file access,
  and runtime isolation requirements still hold. Provider identity, not a typed
  email or unverified decoded claim, binds reconnect and duplicate handling.
- Bound saved credentials and pending login work per account, in addition to
  existing host limits: propose 10 active subscriptions and one pending login
  per account, enforced atomically at the home bay with expiry/cleanup. Reuse
  existing request/payload/rate limits; do not multiply usage polling or runtime
  admission by the number of saved entries. No automatic quota rotation.

Deploy backend default resolution and host/runtime support before exposing Add
or explicit selection. Gate both APIs and UI until the whole path supports exact
IDs; a UI-only gate is insufficient. Use existing version/capability reporting
to reject unsupported hosts rather than allowing an old host to ignore the ID.
If it cannot express this, add one small capability indicator. Validate old
clients against upgraded services using the default record.

Start with a test account, then enable generally after review and the walkthrough.
Rollback disables new Add and explicit selection, retains all encrypted entries,
and keeps ID-aware backend/default resolution in place. Do not roll back to
category-only readers/writers with multiple entries present. Already queued
explicit requests must either retain their selected identity or fail clearly.
Use existing logs with non-secret IDs/error classes for verification; no new
telemetry system or credentials in diagnostic output.

## Room for future API keys and codex-router

The only extension point needed now is an opaque credential ID backed by the
existing provider/kind/scope registry. Avoid subscription-specific IDs, new tables
named after ChatGPT, or a request field named after email. The current resolver
still accepts only the implemented subscription kind. Multiple account API keys
can later reuse the same ownership and selection contract in a separate change.

[codex-router](https://github.com/duolahypercho/codex-router) describes a local router
with provider credentials and model/provider configuration. That suggests future
integration will need both credential selection and runtime/provider configuration;
adding a generic credential field alone does not supply router support. Leave its
installation, provider adapters, endpoints, model discovery, and credentials to a
separate plan. In particular, do not add arbitrary endpoint URLs, headers, secret
exports, or executable configuration to this feature's public request or metadata
contract. The later integration will need its own destination/secret-use and abuse
review. No router dependency is needed to ship multiple ChatGPT subscriptions.
