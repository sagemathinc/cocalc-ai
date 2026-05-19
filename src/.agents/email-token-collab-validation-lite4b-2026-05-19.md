# Email Token Collaboration Invite Validation - lite4b

Date: 2026-05-19

Target:

- Full hub / Launchpad-style dev cluster, not Lite.
- Public URL from `dev:hub:env`: `https://lite1b.cocalc.ai`
- Source plan: `src/.agents/email-token-collaboration-invite-plan-2026-05-18.md`
- Setup notes: `src/.agents/lite4b-setup-notes-2026-05-05.md`

Scope:

- Validate the non-email matrix. Email backend delivery/content is intentionally
  out of scope until email is configured.
- Use repo-built CLI where needed:
  `node /home/user/cocalc-ai/src/packages/cli/dist/bin/cocalc.js`
- For non-admin identity checks, use the dev hub `--account-id` override from
  `dev:hub:env`. API keys are not sufficient for these RPCs because the
  current API key capability allowlist does not include project invite
  operations.

Matrix:

- [x] Free/manual-link behavior.
- [ ] Collaborator-plus-pending cap behavior.
- [x] Expired token failure behavior.
- [x] Revoked token failure behavior.
- [x] Decline behavior.
- [x] Block behavior.
- [x] CLI create/copy/redeem JSON automation.
- [x] Multibay create-on-home-bay / write-on-project-owning-bay.

Results:

- Created disposable owner/recipient accounts and a project
  `6fe42a74-a2ec-4d51-87b9-143eca0a53d2`.
- `project invite create` for an email target returns `email_sent:false`,
  `manual_delivery_required:true`, `email_blocked_reason:"send_disabled_by_request"`,
  a token, and a manual invite URL when email is not configured/requested.
- `project invite copy-link` returns the active token URL for a pending invite.
- `project invite redeem <inviteId> --token <token>` accepts the invite and adds
  the recipient as a collaborator.
- Fixed CLI token-response ergonomics discovered during validation:
  `accept`, `decline`, and `block` now accept `--token` and `-w/--project`; raw
  UUID project ids are passed through without requiring the recipient to already
  have project access. `revoke` also accepts `-w/--project`.
- Validated token decline with invite
  `561300ca-3ecc-4959-93ee-060804e8c61f`; result status `declined`.
- Validated token accept through the explicit response command with invite
  `4ba6cf8b-1c4e-453e-a3cb-8d33a24d97bb`; result status `accepted`.
- Validated token block with invite `88fce6c4-8407-41fc-a5c1-71efb3a8967b`;
  result status `blocked`.
- Validated revoke with invite `93c8f1b8-fdba-4ae6-9494-656f8f78a981`; result
  status `canceled`. Redeeming the canceled token fails closed with
  `invite is not pending (status=canceled)`.
- Forced invite `a646f930-14aa-447e-b3e7-65dfb8ddf221` past its TTL by setting
  `created = now() - interval '15 days'`. Redeeming the token fails closed with
  `invite is not pending (status=expired)`.
- Created project `87d6d572-a6dc-4ddd-83e1-2742739d231c`, rehomed it to
  `bay-1`, created a token invite from the owner account, and redeemed it from
  the recipient account. The recipient became a collaborator, validating the
  cross-bay invite write path.
- Fixed a multibay URL-generation bug discovered during that test: before the
  fix, invites created on the attached `bay-1` project generated
  `https://localhost/invites/...`; after restarting the hub, the same path now
  generates `https://lite1b.cocalc.ai/invites/...`.

Remaining:

- Collaborator-plus-pending cap behavior still needs a targeted validation
  separate from the hourly invite cap. The live smoke hit the hourly abuse
  limit first: `hourly email invite limit reached (5/5)`.
- Email configured delivery/content still needs manual validation after email
  is enabled.
- Browser UI polish/error text should still be manually rechecked for expired
  and revoked links; the backend/CLI behavior is correct but raw CLI error text
  is intentionally lower level than the browser UX.
