# Mobile live voice staging deployment

## Target and scope

- Site: https://staging.cocalc.ai
- SSH: `ssh 34.0.158.247` (`wstein@staging-bay-0`, passwordless sudo).
- Four hub workers: `cocalc-bay-hub@1` through `@4`.
- Release symlink: `/opt/cocalc/bay/current`.
- Pre-deployment release: `/opt/cocalc/bay/releases/20260922021112-static`.
- Deployed source baseline: `02f308fcd7720e1d0495a243cc3ede7e09307d9e`.
- Isolated branch: `staging/mobile-live-voice`, commit `5bb0d5a1d4`, the baseline plus the seven-file live-voice backend commit `e5402a5710`.
- Local checkout: `/Users/williamstein/build/cocalc-mobile-staging`.
- Linux build checkout: `/home/wstein/cocalc-live-voice-build` on staging.

This is a hub-only development rollout. Existing web assets and project-host software are retained. The prototype requires an administrator and an account/project OpenAI API key. It does not use site funding. Calls are capped at 120 seconds, with heartbeat leases for cleanup. Provider audio, delegation, and disconnect behavior still need real-device qualification.

## Authentication

Use the repo-built CLI at `/Users/williamstein/build/cocalc-ai/src/packages/cli/dist/bin/cocalc.js` with `--disable-env-auth-defaults --profile staging --api https://staging.cocalc.ai`. Browser-approved staging authentication is stored in the normal local CLI profile. Ambient local development bearer credentials must not override it. Never copy credential values into notes or commands.

## Linux build

The host uses `/opt/cocalc/nvm/versions/node/v26.2.0/bin/node`. A user-local pnpm 11.8.0 is installed under `/home/wstein/build-tools/node_modules/.bin`. Source was transferred using a Git bundle, preserving the exact commit.

Fresh-checkout prerequisites discovered during packaging:

1. `pnpm -C src install`
2. `pnpm -C src/packages install --frozen-lockfile`
3. Build `src/packages/apps/document-build` and `src/packages/chat-client`.
4. Build `src/packages/cdn` and run frontend `i18n:compile`.
5. `pnpm -C src/packages/rocket build:bay-hub-bundle`

Build log: `/home/wstein/live-voice-build.log`. Six focused server live-voice tests passed on this baseline (`pnpm exec jest ai/live-voice.test.ts --runInBand` after building dependencies).

## Rollout status

Deployed successfully at 2026-09-22 06:51 UTC using the typed CLI `rocket deploy --scope hub`, the isolated checkout's `upgrade-bay-release.sh`, and the Linux-built archive. New release: `/opt/cocalc/bay/releases/20260922065129-hub`.

Archive SHA256: `cf6b9cc7c7e43d73039df7e339f6c0f5998769f3655fa1d23b47ab61a6c5c9da`.

Development flag: `/etc/systemd/system/cocalc-bay-hub@.service.d/mobile-live-voice.conf` contains `[Service]` and `Environment=COCALC_LIVE_VOICE_DEV=1`. Applied by daemon-reload and the rolling deployment. No credentials are in this drop-in.

Checks:

- Fresh Linux package typechecks and bundle validation passed; build manifest is clean.
- Six focused live-voice tests passed.
- Deployment and an independent `bay-health` call reported PostgreSQL, persist, router, frontdoor, and all four workers healthy.
- Authenticated `system.liveVoice` changed from `unknown function` to a valid capability response with `max_seconds: 120` and `usd_per_minute: 0.05`.
- The capability check for the staging account and project `ac2c5b77-2d81-4c2f-81df-fd717f44a3a8` returned disabled because an account/project OpenAI key could not be resolved. Add a key using staging's normal credential UI; never paste a key into chat. Site funding is intentionally disabled.
- No paid provider session was started. End-to-end phone audio remains unverified.

Local deployment report: `/tmp/cocalc-staging-live-voice-deploy`, log `/tmp/cocalc-staging-live-voice-deploy.log`. Linux build checkout remains available for incremental builds.

## Rollback

Previous release is `20260922021112-static`. The existing `bay-rollback-workers` helper accepts that release version. Once every development voice session is closed, remove the `mobile-live-voice.conf` drop-in and daemon-reload before rolling workers back. Do not disable the cleanup switch with active development sessions. Do not deploy this older staging-only branch as a general release.

## September 22 phone follow-up

The user's staging thread selected `subscription`, but its ChatGPT credential selection existed only in the web browser's local storage. Staging returned a non-default subscription in `subscriptions` while `hasSubscription` was false. Mobile incorrectly disabled the plan choice and omitted individual credentials.

Mobile now lists individual ChatGPT credentials, passes the selected ID to payment resolution/model discovery, and persists the explicit credential ID in thread configuration. The existing ACP config builder already forwards this ID as `subscription-credential`; the backend validates caller ownership. No secret is stored in thread configuration. Other collaborators still need access to their own appropriate credentials. The always-visible payment row reports the resolved agent funding source and links to settings. Voice admission continues to use its separate OpenAI API key.

Browser sign-in status polling now tolerates transient network failures until the original challenge expires, without creating/redeeming a second challenge. Session confirmation retries one transient failure; hub connection setup allows 30 seconds and one fresh connection retry.

The voice bridge now checks agent payment before delegation, relays submission error details, and reports queued/running/failed task state. It still does not persist the full voice-intermediary transcript. Distinct transcript records/rendering remain planned work; intermediary speech must not masquerade as Codex output or user commands.

Read-only staging checks confirmed the specific named credential resolves as `subscription`. The exact thread config and latest persisted Codex activity were inspected. No test turn or paid voice call was submitted by the agent.

Validation for the follow-up: 45 mobile UI tests, 15 focused auth/voice tests, 56 shared ACP config tests, mobile typecheck, and frontend lint passed. Simulator settings flows passed in light/dark mode. The large-text directory flow missed its chat-navigation tap; a focused direct-chat payment flow passed at accessibility text size and its screenshot was inspected.

### Subscription catalog routing correction

Mobile model discovery was calling the real hub's `projects.getCodexUsageStatus`, which intentionally returns an unavailable placeholder. The browser intercepts this method and sends it to the project host. Mobile now resolves the owning host and uses the same account-authorized method on its direct host connection, including the selected credential ID and a 90-second discovery timeout. A read-only staging check returned `available: true`, subscription funding, and five models, including the thread's `gpt-5.6-sol`.

Named subscriptions now replace the generic ChatGPT plan row, avoiding two selected radio buttons for one choice. Automatic continues to reflect the server's default resolution. Validation: 46 mobile UI tests, mobile typecheck, frontend lint, and the real project-host catalog check passed. The user confirmed the API-key live-voice path works end to end; subscription phone qualification is next.
