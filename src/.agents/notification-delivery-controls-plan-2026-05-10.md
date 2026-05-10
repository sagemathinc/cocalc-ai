# Notification Delivery Controls and Outbound Email Plan

Status: design and implementation plan, written 2026-05-10.

Purpose:

- make notification email behavior precise enough for public SaaS release
- separate user preference from outbound-email abuse control
- fit the current multi-bay notification pipeline
- avoid preserving confusing legacy `cocalc.com` notification settings

Related docs:

- [greenfield-notifications-model.md](/home/user/cocalc-ai/src/.agents/greenfield-notifications-model.md)
- [greenfield-notifications-implementation-plan.md](/home/user/cocalc-ai/src/.agents/greenfield-notifications-implementation-plan.md)
- [first-public-release-scoreboard-2026-05-09.md](/home/user/cocalc-ai/src/.agents/first-public-release-scoreboard-2026-05-09.md)

## Current Code Read

The new notification architecture already has the right shape:

- `notification_events`: authoritative source event
- `notification_targets`: account fanout
- `notification_target_outbox`: source-bay to home-bay transport
- `account_notification_index`: home-bay browser-facing inbox projection

This is the right substrate for user-facing notification preferences and
external delivery.

However, external email is still split across older paths:

- `src/packages/server/mentions/notify.ts` sends mention email directly.
- `src/packages/server/messages/maintenance.ts` sends digest-like unread-message
  email summaries.
- `src/packages/frontend/account/account-preferences-communication.tsx` exposes
  the old negative toggle `no_email_new_messages`.
- `src/packages/server/email/send-email.ts` routes through `email_backend`
  values `none`, `smtp`, and `sendgrid`.

For `cocalc-ai`, this should be treated as greenfield enough to remove the old
user-facing `no_email_new_messages` model rather than preserve overlapping
configuration.

## Product Goals

The first public release should have:

- in-app notifications as the durable product surface
- per-category external notification preferences
- clear immediate-vs-digest semantics
- daily digest behavior that matches user expectations
- non-disableable transactional/security-critical email
- sender-side throttling for user-triggered notification email
- provider-independent email lanes so critical mail can use a more reliable
  provider than routine notification mail

The product should avoid:

- one global "email me about notifications" switch
- negative wording such as "do not email me"
- duplicate old/new settings that conflict
- silent spam vectors where free accounts can cause unbounded email to other
  users

## Notification Categories

Use a small, explicit category taxonomy. Do not expose raw internal
notification `kind` values directly to users.

Recommended first-release categories:

| Category | Examples | User Email Modes | Default |
| --- | --- | --- | --- |
| `billing` | payment failures, spend-limit warnings, host drain/stop/deprovision warnings, receipts that require action | immediate, digest, off only where safe | immediate |
| `security` | password reset, email verification, 2FA changes, suspicious login, account access changes | mandatory immediate | immediate |
| `support` | admin/support account notices, support replies, entitlement override notices if exposed | immediate, digest, off where safe | immediate |
| `collaboration` | mentions, project invites, direct collaboration notifications | immediate, digest, off | immediate |
| `ai` | Codex/LLM turn finished, long-running AI task completed | immediate, digest, off | off |
| `product` | product/news announcements, low-urgency update notices | digest, off, immediate only for rare high-priority notices | digest |
| `maintenance` | downtime notices, migration notices, operational notices | immediate, digest, off only where safe | digest or immediate depending severity |
| `course` | future course/student broadcast notifications | immediate, digest, off, subject to sender-side limits | immediate or digest |

Notes:

- `security` must not be user-disableable.
- Some `billing` notices must not be user-disableable, especially failed
  payment and host enforcement notices.
- `ai` email should default to off. In-app toast/notification is enough for
  most users.
- `course` is included because instructor broadcast is clearly valuable, but it
  does not need to block the first preferences UI.

## Delivery Modes

User-selectable modes:

- `immediate`: send external email soon after notification creation.
- `digest`: include in the next daily digest email.
- `off`: do not send external email for this category.

Modes are only about external delivery. In-app notification creation is a
separate product decision.

Mandatory categories:

- Use `fixed: "immediate"` or equivalent metadata for critical categories.
- Show them in the UI, but mark as required rather than editable.
- Do not let a user disable security-critical or account-risk email.

## Digest Frequency

Use one digest frequency for the first release:

- daily digest
- target send time: approximately 8am local time
- if user timezone is unknown, infer a coarse timezone from stored Cloudflare
  region/colo data
- if neither is available, use the site/default timezone

Do not implement 8-hour digests for `cocalc-ai`.

Rationale:

- Users generally expect "digest" to mean a daily summary.
- An 8-hour cadence can produce multiple emails per day and feels like delayed
  batch email rather than a digest.
- Urgent categories should be immediate, not handled by increasing digest
  frequency.

Future optional enhancements:

- global digest schedule preference: morning/evening
- weekly digest for product/news
- per-category digest schedule

These are not needed for the first public release.

## User Preference Storage

Store user preference under `accounts.other_settings.notification_preferences`.

Suggested shape:

```json
{
  "version": 1,
  "email": {
    "billing": "immediate",
    "support": "immediate",
    "collaboration": "immediate",
    "ai": "off",
    "product": "digest",
    "maintenance": "digest",
    "course": "digest"
  },
  "digest": {
    "time": "08:00",
    "timezone": "auto"
  }
}
```

Implementation details:

- Put category definitions, defaults, labels, descriptions, and allowed modes in
  `src/packages/util`.
- Frontend and backend should import the same definitions.
- The resolver should tolerate missing preferences and return defaults.
- Do not keep or expose `no_email_new_messages` in the new UI.

Migration stance for `cocalc-ai`:

- remove the old Communication UI row for `no_email_new_messages`
- keep backend reads temporarily only if needed to avoid breaking existing test
  data
- do not create a second visible switch with overlapping meaning

## Frontend UI

Replace the current coarse Communication settings with a clear notification
delivery panel.

Recommended layout:

- title: `Notification email`
- one-sentence header:
  - "Choose which notifications are emailed immediately, included in a daily
    digest, or kept in CoCalc only."
- table columns:
  - Category
  - What it includes
  - Email delivery
- radio segmented control for editable rows:
  - Immediate
  - Daily digest
  - Off
- required rows:
  - show a lock or badge: `Required immediate email`
  - include concise explanation

Suggested category copy:

- Billing and spend: "Payments, receipts requiring action, spend limits, and
  dedicated-host enforcement."
- Security and access: "Password resets, email verification, 2FA, and account
  access changes. These emails are required."
- Support and admin: "Support replies and account notices from CoCalc staff."
- Mentions and collaboration: "Mentions, project invitations, and direct
  collaboration notifications."
- AI and Codex: "Long-running AI or Codex work completed."
- Product news: "Product updates and announcements."
- Maintenance: "Operational notices that may affect access or reliability."

UX rules:

- Show a verification warning if email delivery is enabled but the primary
  email address is not verified on sites that require verification.
- Avoid "do not" wording.
- Make "Daily digest" visibly mean once per day.
- Do not expose provider names such as SendGrid, SES, SMTP, or Cloudflare to end
  users.

## Email Lanes

Email backend choice is orthogonal to user preferences.

Define lanes:

| Lane | Purpose | Examples |
| --- | --- | --- |
| `critical` | highest deliverability, not user-disableable | password reset, email verification, security alerts, failed payment, host shutdown/deprovision warning |
| `transactional` | account and billing messages that should arrive promptly | receipts, support messages, admin notices |
| `notification` | user-triggered or lower-urgency notification email | mentions, project invites, AI completion, digests |
| `marketing` | optional product/news email | product announcements |

Site config should be able to route lanes independently.

Example hosted config:

- `critical`: AWS SES or dedicated SMTP
- `transactional`: SendGrid or Cloudflare Email Service
- `notification`: Cloudflare Email Service, SendGrid, or SMTP
- `marketing`: disabled or SendGrid/Cloudflare depending policy

Fallback behavior:

- if a lane-specific backend is unset, fall back to the default email backend
- if no backend is available for a mandatory critical email, log/error loudly
- if no backend is available for optional notification email, record skipped
  delivery and do not block product actions

Cloudflare note:

- Cloudflare Email Routing alone is not enough because it is forwarding/inbound
  oriented and does not provide SMTP.
- Cloudflare Email Service can be evaluated as an outbound backend, but keep it
  behind the same backend adapter interface as SMTP/SendGrid/SES.

## Outbound Delivery Ledger

Add a durable external-delivery table rather than sending email directly from
notification creation paths.

Suggested table: `notification_email_outbox`.

Suggested fields:

- `email_id UUID PRIMARY KEY`
- `notification_id UUID NULL`
- `event_id UUID NULL`
- `target_account_id UUID NOT NULL`
- `actor_account_id UUID NULL`
- `responsible_account_id UUID NULL`
- `category TEXT NOT NULL`
- `lane TEXT NOT NULL`
- `delivery_mode TEXT NOT NULL`
- `recipient_email TEXT NULL`
- `subject TEXT NOT NULL`
- `summary_json JSONB NOT NULL`
- `status TEXT NOT NULL`
  - `queued`
  - `sent`
  - `skipped_preference`
  - `skipped_unverified`
  - `skipped_rate_limited`
  - `skipped_no_backend`
  - `failed`
- `scheduled_at TIMESTAMPTZ NOT NULL`
- `sent_at TIMESTAMPTZ NULL`
- `attempt_count INT NOT NULL DEFAULT 0`
- `last_error TEXT NULL`
- `created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
- `updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`

Important distinction:

- `target_account_id` is who receives the email.
- `actor_account_id` is who performed the action.
- `responsible_account_id` is whose membership limits are charged for causing
  the email.

For system-generated email, `responsible_account_id` may be null or a site
system account, and sender-side user limits do not apply.

## Abuse Control

Outbound notification email is an abuse-sensitive resource.

Add sender-side membership limits:

- `notification_email_send_limit_5h`
- `notification_email_send_limit_7d`

These should be usage-limit entitlement fields, so they are also covered by:

- membership tiers
- admin entitlement overrides
- support recovery workflows

Count user-triggered notification email by `responsible_account_id`, not by
recipient.

Examples:

- Project invite email: charged to inviter.
- Mention email: charged to author.
- Future course broadcast: charged to instructor/course owner.
- Support/admin notice: exempt or charged to system/support lane.
- Billing/security/system notice: exempt from user-triggered notification
  limits.

Why this matters:

- A spammer on a free account cannot cause unlimited email to other users.
- A legitimate high-trust customer can receive higher limits through membership
  or support override.
- Recipient preference remains independent from sender abuse control.

Recipient-side safety should also exist:

- dedupe project-invite reminders by inviter/project/recipient
- collapse repeated mentions from the same actor/source within a short window
- suppress after bounces/complaints
- optionally auto-digest or skip when a recipient is receiving too much
  lower-priority email

## Daily Digest Builder

Digest generation should be based on the same notification/preference model.

First-release behavior:

- run a periodic job that selects accounts whose local digest time has passed
- include notifications since the last digest that are still digest-eligible
- skip archived notifications
- probably include unread notifications only for collaboration/AI/product
  categories
- send one email per account per day
- update `last_digest_sent_at` only after successful send

Suggested storage:

- `accounts.other_settings.notification_preferences.digest.last_sent_at`
  is acceptable for first release, but a table is cleaner for history.
- A `notification_digest_state` table is better long-term:
  - `account_id`
  - `category`
  - `last_sent_at`
  - `updated_at`

Timezone:

- prefer explicit user timezone if we add one
- otherwise infer from stored Cloudflare region/colo data
- otherwise use site/default timezone

## Category Resolution

Do not make email policy depend directly on raw notification kind alone.

Add a resolver:

```ts
resolveNotificationDeliveryPolicy({
  account_id,
  kind,
  summary,
  event_payload,
  actor_account_id,
  target_account_id,
}): {
  category: NotificationCategory;
  lane: EmailLane;
  deliveryMode: "immediate" | "digest" | "off";
  required: boolean;
  responsible_account_id?: string | null;
}
```

Examples:

- `kind=mention` -> category `collaboration`, lane `notification`,
  responsible actor.
- `kind=account_notice` with `notice_type=codex_turn_completion` -> category
  `ai`, lane `notification`, responsible actor/owner.
- `kind=account_notice` with billing enforcement payload -> category `billing`,
  lane `critical`, required immediate, system responsible.
- `kind=account_notice` from support/admin -> category `support`, lane
  `transactional`.

## Implementation Plan

### Phase 1: Preferences UI Only

Goal: have something useful for team UX feedback quickly.

Tasks:

- add shared notification preference definitions in `src/packages/util`
- add `notification_preferences` type/default resolver
- replace the old `no_email_new_messages` Communication UI with the category
  table
- persist settings under `accounts.other_settings.notification_preferences`
- add frontend tests for default rendering and setting changes

No email delivery behavior changes in this phase.

### Phase 2: Email Lanes and Backend Adapter

Goal: make provider routing explicit.

Tasks:

- define `EmailLane`
- extend site settings to configure backend per lane
- keep default backend fallback
- add backend adapter interface
- keep existing SMTP and SendGrid adapters
- add optional Cloudflare Email Service adapter after validating operational
  requirements
- add tests for lane selection/fallback

### Phase 3: Notification Email Outbox

Goal: stop sending notification email directly from event creation paths.

Tasks:

- add `notification_email_outbox` schema
- enqueue delivery rows after notification projection or source event creation
- record skipped rows for preference/rate-limit/no-email/no-backend cases
- add a worker that sends queued immediate email
- expose admin inspection for failed/skipped/sent counts

### Phase 4: Sender-Side Abuse Limits

Goal: prevent notification email spam.

Tasks:

- add membership usage fields:
  - `notification_email_send_limit_5h`
  - `notification_email_send_limit_7d`
- add descriptions for membership/admin override UI
- add usage accounting by `responsible_account_id`
- enforce limits at enqueue time
- default free tier to a low safe value
- default paid tiers to values that support normal collaboration/course use

### Phase 5: Daily Digest

Goal: implement real daily digest semantics.

Tasks:

- implement digest eligibility query
- infer digest timezone from explicit timezone or Cloudflare region fallback
- send daily digest at approximately 8am local time
- update digest state after successful send
- add preview/test command for operators

### Phase 6: Legacy Cleanup

Goal: remove confusing overlapping behavior.

Tasks:

- remove `no_email_new_messages` UI
- route mention email through the new outbox
- route relevant system messages through `account_notice`
- retire `messages/maintenance.ts` summary behavior for `cocalc-ai`
- keep compatibility only where needed for older `cocalc.com` code paths

## Suggested First-Release Defaults

Free:

- lower sender-side notification email limits
- collaboration immediate email enabled
- AI email off
- product digest

Paid:

- higher sender-side notification email limits
- collaboration immediate email enabled
- AI email off
- product digest

Admins/support:

- very high or unlimited sender-side notification limits
- support/admin notices immediate

Security/billing critical:

- always immediate regardless of user preference
- outside user-triggered sender limits

## Open Questions

- Do we want a first-release explicit timezone setting, or only Cloudflare
  region inference?
- What exact free/paid membership values should we assign for
  `notification_email_send_limit_5h` and `notification_email_send_limit_7d`?
- Should recipient-side auto-digest fallback be implemented in the first pass,
  or deferred until we have delivery metrics?
- Should course broadcast be implemented immediately after this workstream, or
  after student pay/site license?

## Recommended Next Step

Implement Phase 1 now.

That gives the team a concrete settings UI to react to tomorrow without coupling
it to email provider work or the durable delivery outbox.
