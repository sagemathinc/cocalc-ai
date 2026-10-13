# Sagebrush: sign in with CoCalc, limits and account deletion

[Sagebrush](https://sagebrush.space) runs Python and Sage in the browser and
lets people share collections of notebooks, boards and data. Its accounts are
CoCalc accounts. This document is the contract between CoCalc and the Sagebrush
Cloudflare Worker, and it describes how CoCalc implements its side.

There are three interfaces:

1. **Sign in with CoCalc.** OAuth 2 authorization code with PKCE. CoCalc is the
   authorization server and the Sagebrush Worker is the only registered client.
2. **Limits.** The Worker asks CoCalc for an account's upload limits, which come
   from the account's membership tier.
3. **Deletion.** When a user deletes their CoCalc account, CoCalc can ask the
   Worker to delete all of that user's Sagebrush data.

`COCALC_ORIGIN` below is a Worker setting: `https://cocalc.ai` in production and
the dev server's origin for development.

## Secrets

There are two secrets. William sets them on both sides, and they are never
committed.

| Secret        | CoCalc site setting       | Used for                              |
| ------------- | ------------------------- | ------------------------------------- |
| client secret | `sagebrush_client_secret` | the token exchange and the limits API |
| purge key     | `sagebrush_purge_secret`  | signing the deletion requests         |

A blank client secret turns off sign-in: the authorize page refuses the client
and the token and limits endpoints answer `401 invalid_client`. It does not
turn off purges. Once a bay has seen the client configured (its purge worker
records this every minute in `oauth_client_purge_obligations`, and so does any
approved sign-in), every deleted account on that bay gets a purge request, even
if both secrets are later blanked; requests wait, and admins are alerted, while
the purge URL or key is missing. A site that never configured Sagebrush sends
no purge requests. To decommission the client, delete its row from
`oauth_client_purge_obligations` on every bay, after Sagebrush confirms it holds
no data.

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
200 {"tier": "<tier id>", "storage_bytes": <integer>, "max_file_bytes": <integer>, "private_links": <boolean>}
```

- `tier` is the CoCalc membership tier id, for example `free` or `pro`. It is
  informational: decide on the numbers, never on tier names.
- `404 {"error": "no_account"}`: the account does not exist, was deleted or is
  banned. Treat it as no upload rights.
- `401 {"error": "invalid_client"}` as for the token endpoint.

The Worker caches an answer for at most 10 minutes. On a 5xx or a timeout it
keeps its cached value, or with nothing cached it refuses uploads for now; it
never reads an error as a quota of 0. After a downgrade below current usage,
new uploads are blocked and nothing is deleted.

The numbers are membership tier usage limits, editable in Admin → Membership
tiers:

| Usage limit                | Meaning                                            |
| -------------------------- | -------------------------------------------------- |
| `sagebrush_storage_bytes`  | total bytes of shared Sagebrush data               |
| `sagebrush_max_file_bytes` | largest single uploaded file                       |
| `sagebrush_private_links`  | whether the user may create unlisted/private links |

A tier that leaves a field blank inherits the built-in template value for that
tier.

## 3. Deletion

Every deleted CoCalc account is purged on Sagebrush, whether or not CoCalc knows
it signed in there (an approval recorded before an account moved bays stays on
the old bay), unless the user chose to keep their files. The Worker answers a
normal 202 for an account it has no data for.

The deletion dialog shows **Also delete my Sagebrush shared files**, checked by
default, if the account's home bay has a record of a Sagebrush sign-in.
Unchecking it is the only way to keep the files: CoCalc then sends nothing,
their Sagebrush data belongs to an account id that can never sign in again, and
`limits` answers 404. Accounts deleted by other means (an admin, or an expired
temporary account) are always purged.

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
- The deletion dialog lists the approved clients through
  `/api/v2/accounts/oauth-client-approvals`, and `/api/v2/accounts/delete`
  takes `keep_client_ids`, the clients whose data the user chose to keep.
