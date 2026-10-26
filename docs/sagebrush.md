# Sagebrush: sign in with CoCalc, limits and account deletion

[Sagebrush](https://sagebrush.space) runs Python and Sage in the browser and
lets people share collections of notebooks, boards and data. Its accounts are
CoCalc accounts. This document is the contract between CoCalc and the Sagebrush
Cloudflare Worker, and it describes how CoCalc implements its side.

There are four interfaces:

1. **Sign in with CoCalc.** OAuth 2 authorization code with PKCE. CoCalc is the
   authorization server and the Sagebrush Worker is the only registered client.
2. **Limits.** The Worker asks CoCalc for an account's upload limits, which come
   from the account's membership tier.
3. **Deletion.** When a user deletes their CoCalc account, CoCalc can ask the
   Worker to delete all of that user's Sagebrush data.
4. **Sync notices and retention emails.** When a membership starts or stops
   including Sagebrush sync, CoCalc tells the Worker, and it emails the user
   when sync ends and again before the synced data is deleted.

`COCALC_ORIGIN` below is a Worker setting: `https://cocalc.ai` in production and
the dev server's origin for development.

## Secrets

There are two secrets, and a third for sync. William sets them on both sides,
and they are never committed.

| Secret        | CoCalc site setting       | Used for                              |
| ------------- | ------------------------- | ------------------------------------- |
| client secret | `sagebrush_client_secret` | the token exchange and the limits API |
| purge key     | `sagebrush_purge_secret`  | signing the deletion requests         |
| limits key    | `sagebrush_limits_secret` | signing the sync notices (section 4)  |

A blank client secret turns off sign-in: the authorize page refuses the client
and the token and limits endpoints answer `401 invalid_client`. It does not
turn off purges. The first time the site has either secret set, the seed records
a purge obligation in the site setting `sagebrush_purge_obligation`, which every
bay receives, including bays added later. Sign-in approvals are refused until the
obligation is recorded, so no account can store data before it exists. Account
deletion reads the obligation from the seed, and fails rather than skip the
purge if the seed cannot answer. While it is set, every deleted account
gets a purge request, even if both secrets are later blanked; requests wait, and
admins are alerted, while the purge URL or key is missing. A site that never
configured Sagebrush sends no purge requests. To decommission Sagebrush, clear
`sagebrush_purge_obligation` (one setting for the whole site), after Sagebrush
confirms it holds no data of this site's accounts.

### Decommissioning Sagebrush

Clearing `sagebrush_purge_obligation` ends CoCalc's purges of Sagebrush data, so
do it last, in this order:

1. Stop Sagebrush from accepting uploads and end its sessions.
2. Blank `sagebrush_client_secret`, so no new sign-ins start.
3. Wait at least 10 minutes, so outstanding approval proofs (5 minutes) and
   codes (60 seconds) expire on every bay.
4. Confirm with Sagebrush that it holds no data of this site's accounts.
5. Clear `sagebrush_purge_obligation`. Removing the Sagebrush entry from the
   client registry in the code is only safe after this.

## 1. Sign in with CoCalc

The client id is `sagebrush`. Its redirect URIs are the site setting
`sagebrush_redirect_uris` (one per line), compared by exact string match. They must be https, except
`http` for a loopback host (`localhost`, `127.0.0.1`, `[::1]`):

- production: `https://sagebrush.space/auth/callback`
- dev server: also `https://dev.sagebrush.space/auth/callback` and
  `http://localhost:8787/auth/callback`

### Authorize

The Worker sends the browser to

```
GET {COCALC_ORIGIN}/auth/oauth/authorize
    ?response_type=code
    &client_id=sagebrush
    &redirect_uri=<a registered redirect URI>
    &state=<opaque, at most 512 characters>
    &code_challenge=<BASE64URL(SHA256(code_verifier)), 43 characters>
    &code_challenge_method=S256
```

- `code_challenge_method` must be `S256`; `plain` is refused.
- An unknown `client_id`, an unregistered `redirect_uri` or a malformed request
  shows an error page on CoCalc and never redirects.
- The page uses CoCalc's normal sign-in (password, passkeys, two-factor, email
  links, single sign-on). It adds no new way to sign in.
- A signed-in user whose email address is not verified is asked to verify it
  first. CoCalc never issues a code for an unverified email address.
- The user sees which account they are signed in as and what is shared: their
  account id, email address and name. They click **Allow** or **Deny**. Version
  1 asks on every sign-in; it does not remember the decision.

On **Allow** the browser goes to

```
<redirect_uri>?code=<one-time code>&state=<state>
```

On **Deny** it goes to

```
<redirect_uri>?error=access_denied&state=<state>
```

The code is valid for 60 seconds and can be redeemed once. It is bound to the
client, the redirect URI and the code challenge.

### Token

The Worker exchanges the code, server to server:

```
POST {COCALC_ORIGIN}/api/v2/auth/oauth/token
Authorization: Basic BASE64("sagebrush:" + client_secret)
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
&code=<code>
&redirect_uri=<the same redirect URI as in the authorize request>
&code_verifier=<the PKCE code verifier>
```

Success:

```
200 {"account_id": "<uuid>", "email": "<address>", "email_verified": true, "name": "<display name>"}
```

`name` can be an empty string. CoCalc returns no access token; Sagebrush keeps
its own session.

Errors, as in RFC 6749:

| Status | Body                                  | When                                                                                                                                               |
| ------ | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `{"error": "invalid_request"}`        | a missing or malformed parameter                                                                                                                   |
| 400    | `{"error": "unsupported_grant_type"}` | `grant_type` is not `authorization_code`                                                                                                           |
| 401    | `{"error": "invalid_client"}`         | a wrong client id or secret, or the client is turned off                                                                                           |
| 400    | `{"error": "invalid_grant"}`          | an unknown, expired or already used code; a verifier or redirect URI mismatch; the account was deleted, banned or its email changed since approval |

A code is used up by its first redemption attempt, even if that attempt fails.

**Key everything on `account_id`, never on email.** Emails change, and CoCalc
frees a deleted account's email address for reuse by a new account.

## 2. Limits

```
GET {COCALC_ORIGIN}/api/v2/sagebrush/limits?account_id=<uuid>
Authorization: Basic BASE64("sagebrush:" + client_secret)
```

Success:

```
200 {"tier": "<tier id>", "storage_bytes": <integer>, "max_file_bytes": <integer>, "private_links": <boolean>,
     "sync": {"enabled": <boolean>, "version_bytes": <integer>, "read_bytes_per_day": <integer>, "retention_days": <integer>}}
```

- `tier` is the CoCalc membership tier id, for example `free` or `pro`. It is
  informational: decide on the numbers, never on tier names.
- `404 {"error": "no_account"}`: the account does not exist, was deleted or is
  banned. Treat it as no upload rights.
- `401 {"error": "invalid_client"}` as for the token endpoint.
- `sync` is always present, for Sagebrush's backup and sync of the workspace. A
  plan without sync says `"enabled": false`; Sagebrush reads a missing or
  malformed `sync` block as CoCalc not answering, never as "sync off".
  - `storage_bytes` is one budget for sharing and sync together.
  - `version_bytes` bounds the old versions kept of one synced document.
  - `read_bytes_per_day` bounds the synced files the account's own devices download in a day.
  - `retention_days` is how long synced data is kept, read-only, after the
    membership stops including sync, before it is deleted.

The Worker caches an answer for at most 10 minutes. On a 5xx or a timeout it
keeps its cached value, or with nothing cached it refuses uploads for now; it
never reads an error as a quota of 0. After a downgrade below current usage,
new uploads are blocked and nothing is deleted.

The numbers are membership tier usage limits, editable in Admin → Membership
tiers:

| Usage limit                         | Meaning                                             |
| ----------------------------------- | --------------------------------------------------- |
| `sagebrush_storage_bytes`           | total bytes of shared Sagebrush data                |
| `sagebrush_max_file_bytes`          | largest single uploaded file                        |
| `sagebrush_private_links`           | whether the user may create unlisted/private links  |
| `sagebrush_sync_enabled`            | whether the plan includes Sagebrush sync (free: no) |
| `sagebrush_sync_version_bytes`      | bytes of old versions kept per synced document      |
| `sagebrush_sync_read_bytes_per_day` | bytes of synced files downloaded per day            |
| `sagebrush_sync_retention_days`     | days synced data is kept read-only after sync ends  |

A tier that leaves a field blank inherits the built-in template value for that
tier. A tier with no template inherits the free tier's, so sync is off for it.

To turn sync on for one account, for example a test account, assign it a tier
that includes sync with an admin-assigned membership (with an expiry and a
note); every other account keeps its own tier.

## 3. Deletion

Every deleted CoCalc account is purged on Sagebrush, however it is deleted (by
the user, an admin, or an expired temporary account), and whether or not CoCalc
knows it signed in there (an approval recorded before an account moved bays
stays on the old bay). Share links belong to the account, so there is no
opt-out. The Worker answers a normal 202 for an account it has no data for.

If the account's home bay has a record of a Sagebrush sign-in, the deletion
dialog says "Your files shared on Sagebrush are deleted too."

Published versions (a planned Sagebrush feature: citable, indexed, under a
license) will be kept when an account is deleted, with their own removal
process. They are not part of this purge.

### The request

```
POST https://sagebrush.space/api/admin/purge      (the site setting sagebrush_purge_url)
Content-Type: application/json
X-Sagebrush-Timestamp: <unix seconds>
X-Sagebrush-Signature: sha256=<hex>

{"account_id": "<uuid>", "request_id": "<uuid>"}
```

The Worker answers `202 {"request_id": "<uuid>", "status": "accepted"}` and
purges asynchronously. CoCalc counts a request as accepted only on a 202 whose
JSON body has that `request_id` and `"status": "accepted"`; any other response
is retried. The purge URL must be https (http only for a loopback host). It is idempotent per `request_id`. An account with no
Sagebrush data gets a normal 202.

### Signing

Every admin call, in both directions, is signed the same way:

```
message   = timestamp + "\n" + METHOD + "\n" + path + "\n" + raw_body
signature = "sha256=" + hex(HMAC-SHA256(purge_key, message))
```

- `timestamp` is the `X-Sagebrush-Timestamp` header, in unix seconds. It is the
  only clock; the body has no timestamp.
- `METHOD` is upper case, `path` is the URL path without the query string, and
  `raw_body` is the exact request body bytes (empty for a GET).
- The receiver rejects a timestamp more than 5 minutes from its own clock and
  compares signatures in constant time.

Test vector: with the key `test-key`, timestamp `1700000000`, method `POST`,
path `/api/admin/purge` and body
`{"account_id":"00000000-0000-4000-8000-000000000001","request_id":"00000000-0000-4000-8000-000000000002"}`,
the signature is
`sha256=04c22a69c8bfd96f1d921273c8346c8f2edbc881244f7b401fe25ca41340d50c`.
A unit test in CoCalc checks this vector.

The Worker also offers `GET /api/admin/purge/<request_id>` (signed the same way,
with an empty body), which returns `{"status": "done", "collections", "bytes"}`
when finished. CoCalc does not poll it; it is for operations and tests.

### Retries

CoCalc account deletion is immediate and final, so the purge request is written
to a durable queue (the `oauth_client_purge_requests` table) in the same
database transaction that marks the account deleted. A background worker on the
account's home bay sends the queued requests:

- It retries anything but that acknowledgment with exponential backoff, from 1 minute
  up to 6 hours between attempts, and never gives up.
- Each retry sends the same `request_id` with a fresh timestamp and signature.
- It alerts the site admins when a request has not been accepted after a day,
  and immediately on a 401, which probably means the purge keys disagree.

## 4. Sync notices and retention emails

When an account's membership stops including sync, Sagebrush keeps its synced
data read-only and deletes it `retention_days` later, and never less than 14 days
after it learns of the change. Sagebrush sends no email. The Terms promise that
CoCalc emails the user when the membership ends and again before deletion; this
section is that promise.

The calls go to the origin of the purge URL (`https://sagebrush.space`) and are
signed like the purge requests, with the limits key, which is the Worker's
`LIMITS_KEY`. A blank limits key turns this whole section off: no checks, no
notices, no emails.

### Noticing a change

There are no membership events to hook: a membership ends when it expires. So the
home bay checks the accounts that approved a Sagebrush sign-in there, each again
every 10 minutes. Each pass (once a minute) works through all the due accounts,
in batches of 50:

- it reads the limits (section 2);
- it records `sync.enabled` in `sagebrush_sync_states`;
- the first check of an account reads Sagebrush's sync retention. It only
  records the state, unless Sagebrush holds synced data in the other state, and
  then it sends the plan notice of the current state:
  - sync enabled while the data is read-only: an account rehomed after its sync
    ended, and renewed before signing in to Sagebrush on the new home bay;
  - sync not enabled while the data is active: an approval from before these
    checks existed, or a lapse no bay saw. The notice ends sync, and the
    retention emails follow;
- an account whose check fails (its state or limits can't be read) waits the same
  10 minutes before it is tried again, so failing accounts can't keep the rest of
  the batch from being checked.

An account whose home bay is elsewhere is skipped, and so is a deleted or banned
one; deleted accounts are purged by section 3. A rehome leaves the rows behind. A cycle already pending there is carried on by that bay, which asks the account's current home bay before each step, through the routed account state; a rehome in progress is retried. Only the current home bay's discovery scan starts new cycles, once the account signs in to Sagebrush there and a change is seen.

### The plan notice

When `sync.enabled` changes, CoCalc sends:

```
POST https://sagebrush.space/api/admin/limits      (signed with the limits key)
Content-Type: application/json

{"request_id": "<uuid>", "account_id": "<uuid>", "issued": <unix ms>, "limits": <the limits API's answer>}
```

- The Worker answers `200 {"applied": <boolean>}`. It applies a notice only if
  `issued` is newer than what it holds, and ignores it for an account that never
  synced. `true` counts as delivered. After `false`, CoCalc reads the sync
  retention (below): the notice counts as delivered if Sagebrush holds no
  synced data or its state is already the notice's (read-only exactly when the
  notice ends sync). Otherwise the notice was outranked by one stamped later,
  which after a rehome can be an earlier change stamped by a bay whose clock
  is ahead. Then it is retried issued at its retry time, so it overtakes that
  stamp once the clocks' difference has passed.
- Anything else is retried, with the same `request_id` and `issued` (except an
  outranked notice, above, whose `issued` moves to its retry time), with
  backoff from 1 minute to 6 hours.
- Admins are alerted immediately on a 401, which probably means the keys
  disagree, and after a day otherwise.
- A newer change replaces a notice that is still pending.
- Before each attempt, the bay holding the notice asks the account's current
  home bay for its membership. A notice that is no longer the account's state
  is dropped unsent: one left on an old home bay by a rehome, after the
  account changed its membership on the new home, or one for an account
  deleted or banned since. The home bay's next check sends the current state.
  If the membership can't be resolved, the attempt fails and is retried.

### The emails

After the notice that ends sync is accepted:

```
GET https://sagebrush.space/api/admin/sync-retention/<account_id>   (signed, empty body)

200 {"account_id": "<uuid>", "state": "readonly", "readonly_since": <unix ms>, "purge_after": <unix ms>, "now": <unix ms>}
404  the account holds no synced data (it never synced, or its data was deleted)
```

1. **The first email**, "Sagebrush sync has ended: your synced data is
   read-only", goes when the answer shows the data read-only with `purge_after`
   ahead. It names the deletion date.
2. **The second email**, "Your Sagebrush synced data will be deleted on
   <date>", goes 14 days before `purge_after`. If that time has already passed, it
   goes at once.
3. **Before each email, CoCalc checks again.** First its own answer: it resolves
   the account's membership on its home bay, and if sync is back (a renewal
   Sagebrush may not have heard of yet), it records the change, which queues
   the notice and ends the emails. If the membership can't be resolved, the step
   is retried later; nothing is sent. Then it reads Sagebrush's answer again,
   and sends nothing if any of these is true:
   - the answer is a 404;
   - the state is no longer `readonly`;
   - `readonly_since` is null (renewed);
   - the date has passed;
   - the account was deleted or banned.

   A renewal that CoCalc sees itself sends a notice and cancels the emails.

Failed reads and sends are retried with the same backoff. Admins are alerted at
once on a 401, and once per notice and per email when it is a day overdue. The
emails go to the account's email address, through the site's transactional
email.

### Cycles, claims and delivery

- The emails after one ending of sync form a **cycle**, named by the request id
  of the notice that ended it. A renewal ends the cycle; a later lapse starts a
  new one.
- A pass **claims** a due step for 5 minutes. Every update of the step names its
  cycle, its stage and the claim, so a pass that was superseded (renewed, a new
  cycle, or reclaimed after its lease) changes nothing. That includes a renewal
  the pass itself saw: it is recorded, with its notice, only in the same
  statement that checks the claim.
- Each email of each cycle has one **delivery record** in
  `sagebrush_sync_emails`, whose id is derived from the cycle and the stage:
  - `pending -> sending`: the attempt is admitted in one statement, with the
    step's row locked and still this cycle, stage and claim. Only then is the
    mail transport called.
  - `sending -> sent`: the transport returned. The step advances in the same
    statement.
  - `sending -> unresolved`: the transport threw, or a later pass finds the
    record still in `sending` (the process died before or after calling the
    transport, or recording the outcome failed).

**An unresolved email.** The mail transport (`sendEmail`: SMTP or SendGrid)
takes no idempotency key, and an exception from it doesn't say whether the
provider accepted the message. So CoCalc treats a throw as "maybe sent":

- The email is neither sent again nor skipped. The step doesn't advance, so the
  second email waits too.
- The admins get an alert for that delivery at once (its id is in the subject,
  so alerts for different accounts are never merged). It names the account, the
  stage, the attempt's time and the deletion date. An alert that can't be
  recorded is retried with backoff, and while the email is unresolved the alert
  repeats every day.
- The admin checks the mail provider for the email (category
  `sagebrush-sync-retention`) and records a decision. The alert gives both
  psql statements, or `resolveRetentionEmail` can be called:
  - "delivered" marks it sent, and the step advances;
  - "resend" sends it again.
    CoCalc acts on the decision within the hour.
- The provider showing nothing isn't enough to resend: the original attempt
  may still complete and be accepted later, on CoCalc's side or the
  provider's. A restart of the bay's server process shows only that CoCalc no
  longer runs it, not that the provider has finished a request it was already
  sent. Without the provider's final answer for that attempt, a resend keeps
  the risk of a second copy, and the admin accepts it knowingly.
- If the pass that admitted the attempt later sees the transport return after
  all, the record becomes `sent`, and no decision is needed.

**The guarantee, in copies accepted by the mail transport.** Everything below
counts copies that the configured mail transport (`sendEmail`: SMTP or
SendGrid) **accepted**. What happens after acceptance is the provider's:
delivery to the inbox can still bounce, be filtered, be lost, or arrive twice
(a provider delivering one accepted copy twice), and isn't promised. For each of the two emails:

| Case                                                                                                                                                                                         | Accepted copies | Why                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal                                                                                                                                                                                       | 1               |                                                                                                                                                                                                                                                                                                                                                                                               |
| Sync renewed, the account deleted or banned, or it never synced                                                                                                                              | 0               | Intended: nothing is promised any more.                                                                                                                                                                                                                                                                                                                                                       |
| A rehome while a cycle is pending                                                                                                                                                            | 1               | The bay holding the cycle carries it on, asking the account's current home bay (routed). A rehome in progress is retried, never a cancellation.                                                                                                                                                                                                                                               |
| An attempt is unresolved, and the admin decides correctly                                                                                                                                    | 1               |                                                                                                                                                                                                                                                                                                                                                                                               |
| An attempt is unresolved, and the admin marks it delivered when it wasn't                                                                                                                    | 0               | An admin error.                                                                                                                                                                                                                                                                                                                                                                               |
| An attempt is unresolved, and the admin resends one that the provider had accepted                                                                                                           | 2               | An admin error.                                                                                                                                                                                                                                                                                                                                                                               |
| An attempt is unresolved, the provider shows nothing, the admin resends, **and the original attempt was still running** and is accepted later                                                | 2               | A provider lookup can't stop an attempt still in flight, on CoCalc's side or the provider's. A restart of the bay's server process shows that CoCalc no longer runs the attempt, not that the provider has finished a request it was already sent. Without the provider's final answer for that attempt, a resend keeps the risk of a second copy, and the alert says to accept it knowingly. |
| An attempt stays unresolved until the deletion date (no decision, or no admin account to alert)                                                                                              | 0               | The cycle ends with the data. The admins were alerted at once and then daily.                                                                                                                                                                                                                                                                                                                 |
| **Before any attempt:** CoCalc can't resolve the membership, Sagebrush's retention read keeps failing, or the maintenance loop doesn't run (database down, backlog), until the deletion date | 0               | No attempt was ever admitted, so nothing is unresolved. When the step runs again, the deletion date has passed, and the cycle ends. The overdue alert (a day after the step became due) tells the admins, but it neither pauses the deletion nor sends the email.                                                                                                                             |
| SMTP accepts, then throws, and `sendEmail` falls back to SendGrid                                                                                                                            | 2               | Inside `sendEmail` (src/packages/server/email/send-email.ts). Only when the transactional lane names SMTP while the default backend is SendGrid. This code can't see it.                                                                                                                                                                                                                      |

**The time origin.** The deletion date (`purge_after`) is Sagebrush's: it is
counted from when Sagebrush **learned** of the change (the notice), at least 14
days later, and CoCalc never extends it. The two emails' schedule follows from
it: the first goes as soon as it can after the notice, and the second 14 days
before the date, or at once if that has passed. So if the first email is
delayed (the outage row above, cut short), the user gets fewer than 14 days'
warning. For example, a first email one day before the date is followed at
once by the second, and both name that date.

**In normal operation: exactly 1 copy accepted by the transport.** The
exceptions are categories, not bounds: each can happen more than once, or
combine with another, for a worse count.

- **Intended suppression, 0 copies:** sync renewed, the account deleted or
  banned, or the account never synced. Nothing is promised any more.
- **Failures, 0 copies:** an outage before any attempt, or an unresolved
  attempt nobody decides, lasting until the deletion date; or an admin
  marking an attempt delivered when it wasn't.
- **Duplicates, 2 or more copies:** the `sendEmail` fallback (a configuration
  choice); a resend while the original attempt may still complete, on
  CoCalc's side or the provider's; or an admin resending one that had been
  accepted. Each further resend can add another.
- **Inbox delivery** is the provider's, outside this count: one accepted copy
  can still bounce, be filtered, be lost or arrive twice.
- A stronger promise, such as no deletion before an email was accepted, would
  be a separate retention policy on Sagebrush's side. It isn't in this PR.

**Device copies.** Only the copy on our servers is deleted: the copies on your own devices (your browser's storage, or an app's) are not deleted; they stay on each device and stop syncing. A device's sync pauses rather than ending for good: if sync is enabled again, its current files become the new synced copy.

Failures are kept as codes and HTTP statuses only, such as `http_error 503`,
`malformed_response 200`, `send_failed` or `entitlement_unknown`. That covers
logs, `last_error` and admin alerts: a response body or an exception's text,
which could hold an address or a credential, is never kept. Logs name a
notice's request id or a step's cycle, not the account; admin alerts name the
account, as the purge alerts do.

## Implementation in CoCalc

- `src/packages/server/auth/oauth/clients.ts`: the client registry. Adding a
  client means adding an entry there and its site settings.
- `src/packages/server/auth/oauth/authorize.ts`: authorize request checks, the
  approval proof, the one-time codes (stored as SHA-256 hashes in
  `oauth_authorization_codes`) and the token exchange.
- The authorize page is a public auth route,
  `src/packages/frontend/public/auth/oauth-authorize-view.tsx`. Its API is
  `/api/v2/auth/oauth/{authorize-info,approval-token,approve}`, used only by
  that page.
- Approval works across bays like CLI login approval: the user's home bay
  checks the session and the verified email, records the approval in
  `oauth_client_approvals` (under the account rehome fence) and issues a
  short-lived signed proof bound to the request; the bay serving the authorize
  page checks the proof and issues the code. The code is stored on that bay,
  which is also the bay the Worker's token request reaches.
- `src/packages/server/auth/oauth/account-state.ts`: token redemption and limits
  ask the account's home bay (an inter-bay call, `get-oauth-account-state`)
  whether the account is live, unbanned and still has the same verified email.
  The cluster directory only says which bay to ask: it can still list an
  account for a while after its home bay deleted it.
- `src/packages/server/sagebrush/limits.ts`: the limits, from the membership
  resolved on the account's home bay in the same call.
- `src/packages/server/auth/oauth/purge.ts`: the purge queue, its signing and
  its worker.
- `src/packages/server/sagebrush/sync-retention.ts`: section 4's checks, notices
  and emails, run on the primary bay worker, and their tables,
  `sagebrush_sync_states` and `sagebrush_sync_emails`.
- The deletion dialog lists the approved clients through
  `/api/v2/accounts/oauth-client-approvals`, to say their shared files are
  deleted too.
