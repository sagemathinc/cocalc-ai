# Signup Email Domain Policy Plan

Status: design plan.

Date: 2026-05-25.

## Goal

Add an admin-configured account-creation policy that can allow or deny new
signups based on email domain.

This is an abuse-control and deployment-control tool, separate from account
ban equivalence:

- ban equivalence handles aliases for accounts that are already abusive
- domain policy controls which email domains may create or adopt accounts
- both should be enforced at the seed/global account namespace

## Example Use Cases

### Small School Launchpad

A school wants public signup without registration tokens or SSO, but only for
verified institutional accounts.

Policy:

- mode: `allow_only`
- allow domains: `my-school.edu`
- public message: `Use your @my-school.edu email address to create an account.`

UX:

- show the requirement before submit
- validate the email domain as soon as a syntactically valid email is entered
- still require email verification before product access

### Abuse Domain Block

Admins see repeated spam, card testing, or attack traffic from one domain.

Policy:

- mode: `deny_list`
- deny domains: `darkweb.ru`
- public message: optional, usually omitted

UX:

- do not publish the deny list
- show a generic submit-time error:
  `Account creation is not available for this email address. Use a different email address or contact support.`

### Gmail-Only Public Rocket

A public deployment wants a low-friction signup path, but only for a large email
provider with strong anti-abuse signals.

Policy:

- mode: `allow_only`
- allow domains: `gmail.com`, `googlemail.com`
- public message: `For public signup, use a Gmail address.`

UX:

- show the Gmail requirement from the start of the signup form
- still enforce provider-specific equivalent-email bans for Gmail aliases

## Policy Model

Store the policy in global/site settings, not bay-local state.

Suggested shape:

```ts
type SignupEmailDomainPolicy = {
  mode: "allow_all" | "allow_only" | "deny_list";
  allow_domains?: SignupDomainRule[];
  deny_domains?: SignupDomainRule[];
  public_message?: string;
  hide_deny_list_details?: boolean;
};

type SignupDomainRule = {
  domain: string;
  include_subdomains?: boolean;
};
```

Initial implementation can use two normalized string arrays and add structured
subdomain flags later if the existing settings system makes arrays easier:

```ts
signup_email_domain_policy_mode: "allow_all" | "allow_only" | "deny_list";
signup_email_domain_allow_list: string[];
signup_email_domain_deny_list: string[];
signup_email_domain_public_message?: string;
```

The exact schema should be chosen to fit the current site-settings machinery.

## Matching Rules

Normalization:

- lowercase domains
- trim leading/trailing whitespace
- reject empty entries
- reject entries containing `@`
- reject invalid domain syntax
- convert internationalized domains to ASCII/punycode if existing utilities
  already support that; otherwise document ASCII-only for v1

Matching:

- exact domain match is the default
- subdomain matching must be explicit
- `school.edu` must not silently match `foo.school.edu`
- wildcard display can be supported in the UI, e.g. `*.school.edu`, but should
  store as `{ domain: "school.edu", include_subdomains: true }`

Precedence:

- `allow_only` means deny everything not explicitly allowed
- `deny_list` means allow everything not explicitly denied
- if both allow and deny are later supported together, deny should win, but v1
  should avoid the ambiguity by using one mode at a time

## Enforcement Points

Enforcement belongs at the seed/global account namespace, before any account
reservation or local-bay creation.

Required enforcement:

- public email/password signup
- admin-created accounts
- organization-created accounts
- SSO-created accounts
- account email-address changes

Relevant current paths to audit when implementing:

- `src/packages/http-api/pages/api/v2/auth/sign-up.ts`
- `src/packages/server/inter-bay/accounts.ts`
- `src/packages/server/auth/sso/passport-login.ts`
- `src/packages/server/conat/api/system.ts`
- `src/packages/server/conat/api/org.ts`
- `src/packages/server/accounts/set-email-address.ts`

The implementation should provide a single helper, for example:

```ts
await assertSignupEmailDomainAllowed({
  email_address,
  context: "public_signup" | "admin_create" | "sso_create" | "email_change",
});
```

That helper should:

- read the global/site policy
- normalize the email domain
- return normally when allowed
- throw a typed/domain-policy error when blocked
- expose whether the block is public/explainable or should use generic copy

## Multibay Behavior

The policy is global account-namespace state.

Rules:

- attached bays must not make independent allow/deny decisions from stale local
  settings
- seed/global account-directory creation must enforce before reservation
- attached bays should route account creation to the seed as they do today
- direct local account creation paths should either be test-only/bootstrap-only
  or call the same helper explicitly

This prevents bay enumeration or per-bay policy drift.

## UI Behavior

There are two UX modes: transparent allow-list and quiet deny-list.

### Allow-List UX

When mode is `allow_only`, the signup page should show requirements before the
user submits:

- short notice near the email field
- optional expandable list if there are many domains
- immediate client-side validation once the email is syntactically valid

Examples:

- one domain:
  `Use your @my-school.edu email address to create an account.`
- a few domains:
  `Use an approved email address: @school.edu, @alumni.school.edu.`
- many domains:
  `Use an approved organization email address.`

For many domains, show an expandable domain list only if admins choose to make
it public. Some deployments may want the requirement visible but not the full
domain set.

### Deny-List UX

When mode is `deny_list`, do not advertise blocked domains by default.

Behavior:

- no pre-submit list
- no client-side domain deny validation unless the admin chooses a public
  message
- generic submit-time error for blocked domains

Suggested generic copy:

`Account creation is not available for this email address. Use a different email address or contact support.`

This avoids giving attackers a domain block oracle beyond the fact that their
attempt did not work.

### Mixed Admin Intent

Some deployments may want a deny-list with a public message, e.g. a company
that intentionally blocks disposable email domains. Support this explicitly via
`public_message`, but default to generic errors for deny-list blocks.

## Admin UI

Recommended location:

- Admin settings
- Security / Signup controls

Controls:

- mode selector:
  - allow all domains
  - only allow listed domains
  - deny listed domains
- domain list editor
- per-rule `include subdomains` checkbox if structured rules are used
- public message field
- preview panel showing what a user sees for an allowed address and a blocked
  address

Validation:

- reject invalid domains
- show normalized domains
- warn if `allow_only` has an empty allow list because it disables public signup
- warn if deny-list public message reveals sensitive anti-abuse strategy

Audit:

- changing policy should require fresh admin auth
- changes should be logged with actor, old policy, new policy, and reason if
  the admin UI has a reason field

## Error Surface

Backend should distinguish:

- policy block that is safe to explain publicly
- policy block that should use generic copy
- internal policy configuration error

Suggested error object:

```ts
class SignupEmailDomainPolicyError extends Error {
  code = "signup_email_domain_policy";
  public_message?: string;
  public_details_allowed: boolean;
}
```

Public signup route should map this into field-level email errors.

Admin-created account routes can show more specific errors because admins are
authorized to know the policy.

## Relationship To Other Controls

This does not replace:

- registration tokens
- SSO domain requirements
- verified-email requirement
- account bans
- equivalent-email ban expansion
- rate limits

It complements them.

Important examples:

- school deployment can use allow-list plus email verification without SSO
- public deployment can use Gmail-only plus rate limits
- production can deny known abuse domains without changing public signup copy

## Tests

Server tests:

- allow-all permits normal signup
- allow-only permits listed exact domain
- allow-only rejects unlisted domain before account reservation
- deny-list rejects listed exact domain before account reservation
- subdomain behavior is exact by default
- explicit subdomain rule matches child domains
- public signup maps allow-list block to helpful email-field error
- public signup maps hidden deny-list block to generic email-field error
- SSO account creation is blocked by policy
- admin-created account is blocked by policy unless a deliberate override is
  added
- organization-created account is blocked by policy
- email-address changes are blocked by policy
- attached-bay account creation routes through seed enforcement

Frontend tests:

- allow-list notice appears before submit
- client-side email validation shows helpful message for allow-only mode
- deny-list mode does not reveal blocked domains before submit
- submit-time generic error is rendered for hidden deny-list block
- admin settings validates domain entries
- admin settings warns for empty allow-only list

Manual smoke:

- configure `allow_only: my-school.edu`
- verify signup UI copy before submit
- attempt `user@gmail.com`, confirm blocked before account creation
- attempt `user@my-school.edu`, confirm account creation then email
  verification flow
- configure `deny_list: darkweb.ru`
- verify no public deny-list copy appears
- attempt `user@darkweb.ru`, confirm generic error

## Implementation Phases

### Phase 1: Backend Enforcement

- add policy settings
- add normalization/matching helper
- enforce in seed account creation before reservation
- enforce in SSO, org/admin create, and email-change paths
- add server tests

### Phase 2: Signup UX

- expose safe policy summary to frontend customize/bootstrap data
- show allow-list requirements near signup email input
- add client-side validation for transparent allow-list mode
- preserve generic submit-time errors for hidden deny-list mode
- add frontend tests

### Phase 3: Admin UI

- add admin security/settings editor
- add preview
- require fresh auth for policy changes
- record audit events

### Phase 4: Operational Polish

- add metrics:
  - signup_domain_policy_allowed_total
  - signup_domain_policy_blocked_total by mode and hashed/low-cardinality
    domain category
- add rate-limit friendly logging
- document recommended policies for Launchpad, public Rocket, and private orgs

## Open Questions

- Should admins have a deliberate override when creating an account manually?
  If yes, it should require fresh auth and an audit reason.
- Should allow-list policy apply to existing users changing email addresses?
  Default recommendation: yes, unless admins add an explicit override.
- Should SSO-created accounts be exempt if the SSO provider is already
  configured for a domain?
  Default recommendation: no hidden exemption; domain policy should be explicit.
- Should public allow-list display all allowed domains when the list is large?
  Default recommendation: only if the admin explicitly makes the list public.
