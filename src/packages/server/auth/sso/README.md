# Single sign-on implementation

This directory contains the current server-side SSO implementation:

- `passport-login.ts`: account lookup/creation and login policy handling.
- `google-oidc.ts`: Google OIDC token exchange and verification helpers.
- `direct-saml.ts`: direct SAML support.
- `check-required-sso.ts`: required-strategy domain matching.
- `audit.ts`: SSO audit events.

HTTP route and strategy setup lives in `../../hub/auth.ts`. The old
`src/packages/hub/auth.ts` is a re-export, not the implementation.

Read the corresponding `.test.ts` files and the domain-policy implementation
in `src/packages/database/settings/sso-policies.ts` before changing login
behavior. This directory overview is not an identity-provider setup or
production validation procedure.
