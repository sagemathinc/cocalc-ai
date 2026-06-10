# CoCalc AI L1 Kill-Switch Inventory

Status: first-pass minimum emergency controls for public launch.

## Operator Path

Admins can configure the new emergency controls in:

`Admin -> Site Settings -> System / Advanced -> Launch Emergency Controls`

These settings are dynamic server settings, not environment variables, so they can be flipped without rebuilding or redeploying.

## Implemented Minimum Controls

| Incident control                         | Setting                                                                       | Enforcement point                                       | Admin bypass | User-facing behavior                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | ------------ | ----------------------------------------------------------------------------- |
| Disable new account signup               | `public_signup_without_registration_token=no`                                 | Existing signup flow                                    | N/A          | Signup requires registration token.                                           |
| Re-enable registration-token-only signup | `public_signup_without_registration_token=no`, registration tokens configured | Existing signup token flow                              | N/A          | Users without a token cannot create an account.                               |
| Disable new project creation             | `launch_disable_project_creation=yes`                                         | `server/projects/create.ts`                             | Yes          | Non-admin project creation fails with a clear disabled-by-admin message.      |
| Disable new free project starts          | `launch_disable_free_project_starts=yes`                                      | Inter-bay project start admission and start execution   | Yes          | Free-sponsored starts fail; paid and admin-sponsored starts continue.         |
| Disable user dedicated-host creation     | `launch_disable_user_host_create=yes`                                         | Host create API                                         | Yes          | Non-admin host creation fails with a clear disabled-by-admin message.         |
| Disable or restrict Codex/AI usage       | `launch_disable_ai=yes`                                                       | Site OpenAI key exposure and Codex site-usage allowance | No           | Site-managed AI/Codex usage is denied with a clear disabled-by-admin message. |

## Existing Related Controls

| Control                                      | Settings                                                                                                                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hide/disable Codex UI                        | `agent_openai_codex_enabled=no`                                                                                                                                                                                  |
| Disable OpenAI-backed integrations generally | `openai_enabled=no`                                                                                                                                                                                              |
| Disable specific host providers              | `project_hosts_nebius_enabled`, `project_hosts_google-cloud_enabled`, `project_hosts_hyperstack_enabled`, `project_hosts_lambda_enabled`, `project_hosts_local_enabled`, `project_hosts_self_host_alpha_enabled` |
| Limit new signups by domain/Google SSO       | Google SSO signup mode and allowed-domain settings                                                                                                                                                               |
| Egress/usage pressure controls               | Existing admin limits and monitoring settings                                                                                                                                                                    |

## Still Gaps After First Pass

| Gap                                   | Why it is not covered yet                                                                                                                                                                     | Proposed next step                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Disable payment checkout globally     | Stripe keys can be removed, but that is not a clean operational switch and may produce poor UX.                                                                                               | Add `launch_disable_payment_checkout` and enforce it at checkout/session creation with a non-500 message. |
| Read-mostly maintenance mode          | This spans project mutation, file writes, starts, purchases, host actions, and possibly public API calls. A naive single flag risks blocking admin recovery paths or corrupting in-flight UX. | Define an explicit maintenance policy matrix, then enforce through shared write/admission helpers.        |
| Dedicated-host purchases vs. creation | The new host-create switch blocks new hosts, but purchase-session creation may still exist in billing-specific paths.                                                                         | Add a checkout kill switch and audit all purchase/session creation APIs.                                  |
| Abuse-specific kill switches          | Current controls are global, not per account/domain/IP/project.                                                                                                                               | Add scoped bans/holds only after monitoring identifies the highest-risk abuse vectors.                    |

## Smoke Test Checklist

1. Set `launch_disable_project_creation=yes`; verify a non-admin cannot create a project and an admin can.
2. Set `launch_disable_free_project_starts=yes`; verify a free-sponsored project cannot start, while a paid/admin-sponsored project can.
3. Set `launch_disable_user_host_create=yes`; verify a non-admin cannot create a host and an admin can.
4. Set `launch_disable_ai=yes`; verify Codex/site-key usage is denied and normal project file/terminal flows still work.
5. Set `public_signup_without_registration_token=no`; verify signup without a registration token is blocked.

## Release Readiness Notes

These switches should be treated as coarse emergency brakes. They are intentionally simple and globally visible to admins. More nuanced throttles should be built from monitoring data instead of added speculatively before launch.
