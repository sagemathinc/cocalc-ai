# Support Content Consent and Impersonation

Submitting a support request is not blanket permission to inspect project
content. Both support forms offer an optional, unchecked checkbox for human
and AI-assisted inspection of relevant content in the projects involved in
that request. Inspection is explicitly not limited to selected files. The file
picker supplies starting points, not an access boundary; it is hidden until
opt-in and cleared on opt-out. Consent is not restored from a saved draft.

The server records the boolean choice (missing means no permission), wording
version, server timestamp, authenticated account ID when available, and scope
in the original Zendesk comment, with a corresponding consent tag. The same
wording is retained for later review. A public/unsigned submission is not
verified account ownership. Neither the tag nor a pasted ticket link is an
access credential. Check the original record, identity, current scope, and
later replies withdrawing or limiting permission before inspecting content.

## Operator Workflow

1. Read the ticket and establish the customer's explicit consent for the
   relevant project content, including AI-assisted inspection when applicable.
   Record the operator's approval as well. Existing tickets without this
   checkbox can use explicit written consent in a ticket reply.
2. Obtain a fresh admin session with second-factor authentication.
3. Request a link using an exact account ID after verifying the target:

```sh
cocalc admin support impersonate <account-id> \
  --ticket-id 123 \
  --reason "Investigate notebook build in the project identified in the ticket" \
  --consent-reference "Customer comment 456 opted in to human/AI inspection; operator approval recorded in note 789"
```

This command issues a short-lived sign-in link; it does not open a browser,
read project content, or automatically verify the operator's consent
attestation. Treat the link as a credential. Use a separate browser session,
inspect only what is relevant to the approved scope, and end impersonation
afterward. Permission to investigate is not blanket permission to modify
files, spend money, or change account settings.

The general `admin user issue-impersonation-link` command now requires
`--reason`. The admin user-search UI also requires a purpose and authorization
explanation. Non-support operational investigations should document their
actual authorization rather than inventing customer consent.

## Audit and Routing

The public grant API validates nonempty reasons (maximum 512 characters,
without silent truncation). Support ticket IDs and consent references are
validated and retained as structured grant metadata, copied to the subject
session, and included in grant/session creation audit events alongside the
reason and actor/subject identities. These fields enable later automated
review; they are operator assertions, not an automated consent-verification
system.

The subject's home bay remains authoritative for grant/session storage.
Existing cross-bay routing, rehome fences, short-lived grant redemption,
fresh-auth checks, and impersonation restrictions are unchanged. This feature
does not grant new project access or introduce a hub project-data proxy.

Deploy the backend and updated UI/CLI together: older clients omitting a
reason will receive an actionable validation error. Existing issued sessions
are not invalidated by this change.
