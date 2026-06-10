# CoCalc AI Read-Mostly Maintenance Mode Design

Status: design for the next L1 implementation pass.

## Goal

Provide a single emergency switch that keeps the site useful for reading, exporting, account access, and admin recovery while preventing new user-generated writes or cost-incurring actions.

Proposed setting:

`launch_read_mostly_maintenance_mode=yes`

## Policy Matrix

| Surface                                   | Non-admin behavior in read-mostly mode                             | Admin behavior          | Notes                                                                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Sign in/sign out                          | Allow                                                              | Allow                   | Users need access to view/export data.                                                                                   |
| Account/settings read pages               | Allow                                                              | Allow                   | Avoid making recovery harder.                                                                                            |
| Billing history and invoices              | Allow                                                              | Allow                   | Read-only billing remains useful.                                                                                        |
| New checkout/payment/setup sessions       | Block                                                              | Block by default        | Already covered by `launch_disable_payment_checkout`; read-mostly should imply it.                                       |
| Project list and metadata reads           | Allow                                                              | Allow                   | Required to find data.                                                                                                   |
| Project creation                          | Block                                                              | Allow                   | Existing `launch_disable_project_creation` behavior should be reused.                                                    |
| Project start                             | Block by default                                                   | Allow                   | Starting projects is cost-incurring and can trigger restore/write work. Consider allowing already-running projects only. |
| Project stop                              | Allow                                                              | Allow                   | Needed for cost control and recovery.                                                                                    |
| File reads/download/export                | Allow                                                              | Allow                   | Primary read-mostly value.                                                                                               |
| File writes/saves/uploads/deletes/renames | Block                                                              | Allow                   | Must be enforced at project-host file mutation APIs, not only UI.                                                        |
| Terminals/Jupyter/exec/LaTeX              | Block if project is not already running; likely block all new exec | Allow                   | These are active compute/write surfaces.                                                                                 |
| Codex/AI                                  | Block                                                              | Block by default        | Existing `launch_disable_ai` behavior should be implied.                                                                 |
| Dedicated host creation/purchase          | Block                                                              | Allow for recovery only | Existing host-create kill switch covers non-admin creation.                                                              |
| Existing dedicated host start/stop        | Stop allowed; start blocked for non-admin                          | Allow                   | Cost-control priority.                                                                                                   |
| Admin site settings                       | Block for non-admin by definition                                  | Allow                   | Recovery path.                                                                                                           |
| Public shares                             | Allow existing read-only shares                                    | Allow                   | Do not create/update shares.                                                                                             |

## Implementation Approach

Add a shared helper in `server/launch/kill-switches.ts`:

`assertReadMostlyAllows(action, { account_id?, adminBypass? })`

Start with coarse actions:

- `project-create`
- `project-start`
- `project-write`
- `project-exec`
- `host-create`
- `payment-checkout`
- `ai`

Do not implement this as frontend-only hiding. The switch must be enforced in backend/project-host mutation paths and should return clear disabled-by-admin messages.

## First Implementation Slice

1. Add the site setting and helper.
2. Make read-mostly imply the existing payment checkout, AI, project creation, free-start, and host-create denials.
3. Add backend enforcement for project start and obvious hub-side write APIs.
4. Separately audit project-host file mutation, terminal, Jupyter, exec, and LaTeX APIs before claiming full coverage.

## Smoke Tests

1. Non-admin can sign in, list projects, open account settings, and view billing history.
2. Non-admin cannot create projects, create hosts, start stopped projects, open Stripe checkout, or use Codex.
3. Non-admin can stop a running project.
4. Admin can still perform recovery actions.
5. Existing read-only file download/export path still works.
