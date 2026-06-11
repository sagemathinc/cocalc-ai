# Kill Switch Enforcement Audit, 2026-06-10

Status: first enforcement pass after adding launch emergency controls.

Scope:

- AI/Codex launch switch enforcement.
- Payment checkout switch enforcement.
- Dedicated host creation switch enforcement.
- Project creation/start switch enforcement.
- Signup controls discovery.

## Existing Controls

Admin UI path:

- `/admin/site-settings`
- Filter for `Launch Emergency Controls`.

Settings:

- `launch_read_mostly_maintenance`
- `launch_disable_project_creation`
- `launch_disable_free_project_starts`
- `launch_disable_user_host_create`
- `launch_disable_ai`
- `launch_disable_payment_checkout`

Signup controls are currently separate:

- Registration tokens live in Admin registration-token controls.
- `public_signup_without_registration_token` is edited from the registration-token UI.
- Email signup can be disabled in Site Settings.

## Enforcement Map

Project creation:

- Backend gate: `assertProjectCreationAllowed`.
- Enforced in `src/packages/server/projects/create.ts`.
- Read-mostly maintenance blocks non-admin project creation.

Project starts:

- Backend gate: `assertFreeProjectStartAllowed`.
- Enforced in `src/packages/server/inter-bay/project-control.ts`.
- Read-mostly maintenance blocks non-admin project starts before runtime-slot admission.
- Free-start switch blocks only free-sponsored project starts; paid/admin-sponsored starts still work.

Dedicated host creation:

- Backend gate: `assertUserHostCreateAllowed`.
- Enforced in `src/packages/server/conat/api/hosts.ts`.
- Read-mostly maintenance blocks non-admin host creation.

AI/Codex:

- Backend gates: `isAiLaunchDisabled`, `assertAiLaunchAllowed`.
- Enforced for site OpenAI key exposure in `hosts.getSiteOpenAiApiKey`.
- Enforced for site Codex usage allowance in `hosts.checkCodexSiteUsageAllowance`.
- Enforced for navigator planner Codex work in `agent.plan`.
- `system.getCodexPaymentSource` no longer reports the site API key as available when AI is disabled.

Payment checkout:

- Backend gate: `assertPaymentCheckoutAllowed`.
- Enforced in Stripe checkout/session helpers.
- Enforced directly in `createPaymentIntent`, so direct server callers and background renewal/autopay paths cannot create new charge intents while disabled.

## Changes Made In This Audit

- Added AI kill-switch enforcement to `agent.plan` before the Codex planner is created.
- Added payment checkout enforcement inside `createPaymentIntent`, not only at HTTP API wrappers.
- Updated Codex payment-source reporting so the site API key is hidden when the AI switch is active.
- Added focused regression tests for `agent.plan` and `createPaymentIntent`.

## Remaining Follow-Up

- Add a small admin runbook section to docs or admin UI explaining the signup emergency path:
  - disable public signup without registration token,
  - disable email signup,
  - verify at least one active registration token if token-only signup is intended.
- Audit project-host-side Codex endpoints once all project-host route files are in scope; the hub gates site key and usage allowance, but project-host direct routes should still fail closed if they receive stale credentials.
- Decide whether `launch_disable_payment_checkout` should also block payment-method mutations such as setting default payment method or editing Stripe customer metadata. Current behavior blocks new checkout/session/payment-intent creation, but still allows cleanup and user payment-method management.
- Add a CLI/admin smoke command that toggles each launch switch and exercises one failing path.

