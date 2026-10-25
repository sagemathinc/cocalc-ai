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
home bay checks the accounts that approved a Sagebrush sign-in there, a batch at a
time, each again every 10 minutes:

- it reads the limits (section 2);
- it records `sync.enabled` in `sagebrush_sync_states`;
- the first check of an account only records the state.

An account whose home bay is elsewhere is skipped, and so is a deleted or banned
one; deleted accounts are purged by section 3. A rehome leaves the row behind.
The new home bay tracks the account once it signs in to Sagebrush again, and every
sign-in asks for approval.

### The plan notice

When `sync.enabled` changes, CoCalc sends:

```
POST https://sagebrush.space/api/admin/limits      (signed with the limits key)
Content-Type: application/json

{"request_id": "<uuid>", "account_id": "<uuid>", "issued": <unix ms>, "limits": <the limits API's answer>}
```

- The Worker answers `200 {"applied": <boolean>}`. It applies a notice only if
  `issued` is newer than what it holds, and ignores it for an account that never
  synced. Either answer counts as delivered.
- Anything else is retried, with the same `request_id` and `issued`, with backoff
  from 1 minute to 6 hours.
- Admins are alerted immediately on a 401, which probably means the keys
  disagree, and after a day otherwise.
- A newer change replaces a notice that is still pending.

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
  cycle, or reclaimed after its lease) changes nothing.
- Each email of each cycle has one **delivery record** in
  `sagebrush_sync_emails`, whose id is derived from the cycle and the stage.
  - Before the email is handed to the mail transport, the attempt is admitted.
    In one statement, with the step's row locked and still this cycle, stage and
    claim, the record goes to `sending`.
  - When the transport returns, the record becomes `sent` and the step
    advances, in one statement. When it throws, the record becomes `failed`
    and the step is retried.
- The mail transport (SMTP or SendGrid) takes no idempotency key and confirms
  nothing later, so exactly-once delivery isn't possible. Each email is sent
  **at most once** instead. A record left in `sending` (the process died, or
  recording the outcome failed) becomes `unknown` at the next claim. The email
  may have been delivered, so it isn't sent again: the step advances, and the
  admins are told.

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
