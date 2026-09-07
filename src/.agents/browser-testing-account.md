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

## Staging2 Qualification (2026-09-07 UTC)

Deployed hub artifact
`20260907T005912Z-3baa8537-20260907-testing-browser-3baa8537-dirty`
(implementation commit `3baa8537fa`). Hub smoke checks and host routing passed.
The testing designation is installed in the systemd hub drop-in
`/etc/systemd/system/cocalc-bay-hub@.service.d/browser-testing.conf`.

- Designated account: `298d8ab1-b132-4f64-8edf-b1edd6a47e1c`
  (`testing@example.com`), non-admin despite its Admin membership tier.
- Shared canary: `1793a413-42c9-49cf-8a2e-0abd641e8b28`.
- Fresh operator authorization successfully spawned Chromium twice without any
  manual testing-account login. Returned testing profile:
  `browser-test-staging2.cocalc.dev-298d8ab1-b132-4f64-8edf-b1edd6a47e1c`.
- Typed browser files and sandboxed UI actions authenticated as the testing
  account. Opened the canary file listing, clicked Recovery, then Open Backups;
  verified the Backups view and captured native full-page screenshots.
- `admin health` with that testing profile failed with `must be an admin`.
  Browser exec policy also reported `raw_exec_admin=false`.

The installed `/opt/cocalc/bin2/cocalc-cli.js` is read-only and predates the spawn
flag. This qualification used the built
`src/packages/cli/dist/bin/cocalc.js` for spawning and native screenshots;
ordinary typed commands worked with the installed CLI. Runtime CLI publication
is separate from the hub deployment; until upgraded, use the built CLI for the
new spawn command rather than trying to overwrite the installed binary.

For UI assertions, target `#cocalc-webapp-container` or a visible descendant,
not `body`: the app uses positioned children and `body` has zero height on this
page. Native screenshots should use `--fullpage --timeout 10s`. The default
body-element screenshot waits for a visible box and times out. The installed
CLI's DOM screenshot fallback also failed under QuickJS; native full-page
capture is the verified path. These are not reasons to grant admin to the test
account or enable raw exec.

This qualifies the autonomous browser setup, not the full sparse-backup plan.
