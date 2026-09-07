# Dedicated Testing Browser

`browser session spawn --testing-account <account UUID>` is the explicit agent
exception to the ordinary browser-spawn guard. A fresh admin CLI profile can
authorize that designated account without a testing-account login. Project-agent bearer credentials
alone cannot mint browser cookies; the existing hub agent API allowlist is unchanged.

## Setup

1. Create a separate ordinary non-admin account on the target site. Share only
   projects appropriate for automated testing with it. Never promote it to admin.
2. Configure `COCALC_BROWSER_TEST_ACCOUNT_IDS` on the account's home-bay hub with
   its UUID (comma-separated for multiple accounts). The default is no accounts.
3. Use the first-party CLI `auth bootstrap` flow for the operator's admin profile
   with the target site's explicit `--api`. Periodic admin fresh auth is enough;
   the testing account needs no separate human login. Direct fresh login as the
   testing account also remains supported. Do not copy operator cookies into Chromium.
4. With the updated server and CLI, run:

   ```sh
   "/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" \
     --profile staging2 --api https://staging2.cocalc.dev \
     browser session spawn --testing-account <account-UUID> \
     --project-id <shared-testing-project-UUID>
   ```

## Security Model

- This is a normal account-wide browser session for a deliberately limited
  account, NOT a per-project credential or a restriction on browser navigation.
  It can access everything shared with that account and perform ordinary user
  actions, including project actions. Do not give it sensitive projects, billing
  resources or privileged roles. Admin testing stays in a human-controlled browser.
- Server issuance checks administrator authority for delegation, explicit designation,
  account home-bay authority, active account state and absence of admin privilege.
  Direct actor fresh auth is required; actor impersonation cannot satisfy it.
  The issued session records the authorizing actor and belongs only to the testing
  account. Cross-home-bay issuance currently fails closed; it is not silently local.
- The CLI creates a separate `browser-test-<site>-<UUID>` profile containing only
  the short-lived testing cookie and uses it for host tokens and browser discovery.
  The result's `testing_profile` is the profile for subsequent browser commands.
  The operator profile and current default profile are not changed.
- Browser cookies expire after at most one hour and carry no fresh-auth elevation.
  API-key and hub-password environment values are not injected. Browser targets
  must initially match the authenticated site's origin; cross-origin cookies are
  never minted by accepting an arbitrary target URL.
- Removing designation prevents new sessions; it does not revoke existing ones.
  Use account session revocation for immediate credential invalidation. Do not
  promote a testing account while sessions exist. Terminate spawned browsers after
  testing; cookie expiry alone does not terminate Chromium or all open connections.
- An old server without explicit testing-session confirmation fails closed.
  Ordinary agent spawn and account/session discovery restrictions are unchanged.

Implementation is not live qualification. Provisioning, fresh login and actual
Chromium UI verification are still required on the selected deployment.
