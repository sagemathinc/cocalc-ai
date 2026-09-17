# Trusted Financial Approval

Disabled unless `COCALC_FUNDING_APPROVAL_ENABLED=1`. This is a dedicated HTTP
listener, not an Express router installed on the application origin.
`server/conat/index.ts:initConatApi` awaits `initCourseFundingApprovalService`.
With centralized billing enabled, only seed-bay API workers register the
Postgres-backed proposal/status service and its primary worker listens;
attached bays route financial commands to the seed. Without centralized
billing, each payer-home bay registers the service and its primary worker
listens.
`stopCourseFundingApprovalService` closes the listener and unregisters the service;
normal process exit also closes its sockets. Restart the hub after changing config.

## RPC Contract

The account-authenticated course RPCs must derive `payer_account_id` from the
authenticated actor and resolve/forward to that account's home bay first.

```ts
proposeCourseFundingAllocation({ payer_account_id, terms, operation_id });
proposeCourseFundingPoolChange({ payer_account_id, terms, operation_id });
getCourseFundingAllocationStatus({ payer_account_id, intent_id });
// All return CourseFundingAllocationStatus:
// { id, approval_url, status: "pending" | "approved" | "expired",
//   expires_at, pool_id? }
```

Allocation `terms` is `CourseFundingDraft`; change `terms` is
`CourseFundingPoolChangeDraft`. Both use the same isolated listener and store.
Pool changes snapshot the core helper's validated preview, displaying resolved
student identities and resulting limits, dates, and grant states, and recheck
the expected pool version on commit. `operation_id` is a UUID idempotency key. Reuse
with different terms is rejected. UI and CLI open the returned URL and poll the
account-authenticated status RPC. They never receive a redeemable approval token.
Do not expose the factory's server-only `approve` method as a hub/agent RPC.

The generic store factory is `createCourseFundingApprovals({ approval_origin,
validateTerms, resolveReview, apply })`. Its callback receives
`{ db, payer_account_id, terms, review, operation_id, intent_id }` inside
`withFundingAccountTransaction`. The startup adapter calls
`createCourseFundingPoolInTransaction(db, ...)` and returns `{ pool_id }`, or
`changeCourseFundingPoolInTransaction(db, ...)` for a pool change.
All callback mutations must use that client; no independent transactions or
external effects. Allocation also calls `enqueueCourseFundingReceiptInTransaction`
in that transaction; pool changes enqueue through their core helper. Actual
receipt delivery is asynchronous, never a side effect before commit.

## Personal VM Consent Integration

`approval-personal.ts` exports `registerVmPersonalFundingApprovalHandler`.
The VM core service must register its handler once in every API/listener process
at startup. Missing registration fails closed at proposal and approval.

```ts
registerVmPersonalFundingApprovalHandler({
  resolveReview: async ({ payer_account_id, terms }) => review,
  apply: async ({
    db,
    payer_account_id,
    terms,
    review,
    operation_id,
    intent_id,
  }) => ({ consent_id }),
});
// approvals.ts: call only after account authentication and payer-home routing
proposeVmPersonalFundingApproval({ payer_account_id, operation_id, terms });
getVmPersonalFundingApprovalStatus({ payer_account_id, intent_id });
// FundingIntentStatus: intent_id, operation_id, approval_url,
// status: pending | applied | expired, expires_at, terms_hash,
// result?: { consent_id } (narrow the exported FinancialApprovalResult union)
```

Proposal terms are the existing `VmPersonalFundingTerms`. The store adds
`kind: "personalVMfallback"`, hashing terms and server-resolved review together.
`PersonalVmApprovalReview` requires `vm_id`, `vm_name`, `owner_account_id`,
`owning_bay_id`, `resource_generation`, `funding_epoch`, `hourly_usd`,
`protected_storage_usd`, `egress_cap_usd`, `storage_delete_at`, and `home_volumes`
(each `{id, name, storage_delete_at}`). Monetary values are decimal USD strings;
dates are ISO UTC. Resolve these from the authoritative VM/resource service,
not browser-provided labels, quotes, generations, or epochs. Only the VM owner
may be the personal payer. The common review resolves their name/email itself.

`apply` receives the stored snapshot under `withFundingAccountTransaction`.
It must recheck owner, resource generation, funding epoch/version, cap, deadlines,
and policy with the VM core's locking protocol, then create consent and its
transactional receipt/handoff outbox using `db`. No provider/network mutation
inside this callback. A delayed owning-bay handoff must independently fence the
same generation/epoch before activating charges. Approval is not activation.

The actual isolated HTML review displays the personal cap, lane, end time,
immediate versus conditional activation, allowed exhaustion/expiry triggers,
named VM and volumes, generation/epoch, compute price, protected storage/egress,
and exact storage deletion deadlines. Revocation/suspension are not fallback
triggers. No browser/CLI endpoint may call the handler's `apply` directly.

## Paid Credit Transfers

`approval-transfer.ts` wires the supplied transfer core into this same listener
with stored `kind: "creditTransfer"`. `COCALC_ENABLE_CREDIT_TRANSFERS=yes` is a
separate, default-off gate in addition to isolated approval configuration. No
transfer feature flag is enabled by this implementation.

`prepareTransferApproval` refreshes `prepareCreditTransferApproval` evidence
before locks on every attempt. The factory's optional `prepare` returns an
executor whose `withTransaction` uses `withCreditTransferApprovalTransaction`,
replacing the default payer transaction, never nesting it. The common store
rechecks the independent session, expiry, hash and single-use claim under that
transaction, then calls `applyCreditTransferInTransaction` and persists its
receipt atomically. Sender/recipient locks therefore precede approval-row locks.

`registerTransferApprovals` installs the transfer worker's existing
`registerCreditTransferApprovalService` after listener readiness and unregisters
on shutdown. Its operation-based status adapter checks the stored intent kind.
Review resolves both identities and shows amount, verified transferable balance
and remaining balance at proposal; current credit/evidence is rechecked at
approval. The fictitious local instructor credit is not payment provenance and
must not be made transferable by fabricating provider evidence.

## Local Hub

For the isolated course-funding hub on port 19200, export these before starting
the hub-daemon with its separate DATA/state configuration:

```sh
export COCALC_FUNDING_APPROVAL_ENABLED=1
export COCALC_FUNDING_APPROVAL_ORIGIN=http://127.0.0.2:19212
export COCALC_FUNDING_APPROVAL_PORT=19212
export COCALC_FUNDING_APPROVAL_APPLICATION_ORIGINS=http://localhost:19200,http://127.0.0.1:19200
unset COCALC_FUNDING_APPROVAL_PROXY_IP
```

Build `src/packages/server` and restart the hub, not a separate approval process.
The hub DB must have the core funding and account-auth schema; approval startup
creates its intent table. Do not point this development hub at production data.
Use local Chromium on the same machine; a remote browser's `127.0.0.2` is its
own loopback, not this server. No DNS, TLS, or external deployment is needed for
this local test. Port 19212 must be free; 19202 is reserved by the hub's
default `PORT+2` Conat data listener. The listener rejects wrong Host,
forwarded headers, and requests delivered through the normal hub listener.

## Isolated HTTPS

Example configuration, only after deployment/security review:

```sh
export COCALC_FUNDING_APPROVAL_ENABLED=1
export COCALC_FUNDING_APPROVAL_ORIGIN=https://approve-bay0.example.org
export COCALC_FUNDING_APPROVAL_PORT=19202
export COCALC_FUNDING_APPROVAL_PROXY_IP=127.0.0.1
export COCALC_FUNDING_APPROVAL_APPLICATION_ORIGINS=https://app.example.org,https://bay0.example.org
```

Provision DNS and a TLS certificate for that dedicated origin. Route **all** its
traffic to `http://127.0.0.2:19202` using a trusted, same-machine proxy connecting
from the configured loopback IP. Preserve `Host: approve-bay0.example.org`, strip
`Forwarded` and `X-Forwarded-Host`, and replace `X-Forwarded-Proto` with `https`.
Never preserve a client-supplied forwarding header. No user files, notebook
output, general app routes, service workers, or application JS may be served on
this origin. Do not expose the backend listener externally. Application-origin
and approval-origin hostnames must differ, not merely their ports. Each payer
home bay needs its own correctly routed approval origin/listener.

The HTTPS listener uses host-only `__Host-` Secure HttpOnly SameSite=Strict
cookies. HTTP cookies are allowed only on the distinct development loopback IP
and never with NODE_ENV=production. POSTs require exact Origin, same-origin
Fetch Metadata, and session/intent/action-bound CSRF. No CORS approval, reusable
approval tokens, opener messaging, shared remember-me cookies, or normal-app
fresh-auth fallback is supported.

## Current Scope And Release Gates

Independent sign-in reuses `verifyLocalSignInPassword`,
`verifyFreshAuthCredentials`, `recordNewAuthSession`, and
`requireFreshAuthForSessionHash`. Password plus an enabled TOTP/recovery code
works. Passwordless/SSO-only or passkey-only accounts fail closed; adding those
requires trusted-origin passkey RP/OIDC setup and matching auth routes, not a
fallback to the application's fresh session. The approval session is bound to
one intent and origin and has no general remember-me row.

Terms, resolved account names/emails, and retention policy are snapshotted and
hashed. Review includes payer, recipients, individual amounts, total commitment,
funding lane, dates, overcommit, and storage obligations. It is script-free,
escaped HTML with framing/opener/referrer/cache restrictions.

Course allocation and expanded-pool approval repeat recipient sanctions/deletion
checks at the current account homes via the private inter-bay method
`computeFundingCheckApprovalRecipients`. This method is absent from the public
hub API. Directory records route checks; they do not substitute for home-bay
account state. Local account rows are share-locked through commit. Remote checks
are fail-closed, at most 30 seconds old at application, and happen before money
locks; they are not a distributed atomic freeze on sanctions changes. Admission
must still enforce current account state. Receipt targets use freshly resolved
homes, not the stored review homes.

Financial receipt email types alone require an explicitly verified primary
address at projection, with no legacy NULL-verification or alternate-address
fallback. Delivery resolves the current directory home again and checks local
home, deletion/sanctions, and the unchanged verified primary address. A stale or
unverified destination is `skipped_unverified`. Required receipts cannot use digest delivery. Other notices
retain their existing verification/preferences behavior. A skipped receipt is
not automatically redirected to a newly changed address or backfilled when an
address is later verified; its account notification remains the durable record.

Financial delivery failures (including directory, configuration and SMTP errors)
retry the **existing** email outbox row, using its persisted attempt count and
scheduled time. Backoff starts at one minute, doubles to a one-hour cap, and
stops after 12 claims. The worker also recovers already-failed financial rows
and old `skipped_no_backend` rows after the same delay; no allocation replay,
manual SQL status reset, or new receipt event is needed. Every claim repeats
current-home/verified-destination checks. Sent and unverified rows are never
automatically retried; exhausted deliveries retain `failed` and their last error.
Legacy non-financial failure behavior is unchanged. SMTP delivery is at-least-once:
an ambiguous connection loss after server acceptance can duplicate email, but
never the financial operation or its durable account receipt.

External review must validate the deployed DNS/proxy/cookie boundary and the
complete section-9 financial workflow before release. In particular, downstream
receipt delivery, supported passwordless auth methods, account portability,
and policy/retention changes across outstanding intents require coordinated
verification. These are not reasons to permit same-origin approval.

Focused verification:

```sh
pnpm -C src/packages/server test:pglite --runInBand compute/funding/approvals.test.ts compute/funding/approval-auth.test.ts compute/funding/approval-server.test.ts compute/funding/approval-startup.test.ts compute/funding/approval-review.test.ts compute/funding/approval-personal.test.ts compute/funding/approval-transfer.test.ts compute/funding/approval-recipients.test.ts compute/funding/receipts.test.ts notifications/email-outbox-maintenance.test.ts
pnpm -C src/packages/database test:pglite --runInBand postgres/financial-receipt-email.test.ts postgres/account-notification-index-projector.test.ts
pnpm -C src/packages/server tsc --build
pnpm -C src lint:frontend
```

The browser test uses repo `playwright-core`, `axe-core`, and `/usr/bin/chromium`.
It starts isolated fixture listeners and does not connect to a live hub. Real
credentials and the live pool callback must also be checked in the isolated dev
hub; fixtures are not a claim of production deployment validation.
