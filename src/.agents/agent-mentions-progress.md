# Named Agent Mentions Implementation Progress

Date: 2026-09-14.

Implementation worktree: `/home/user/scratch/agent-mentions`, branch
`feature/agent-mentions`, based on RPC foundation PR #558 at `4a1c89014e`.
Contract: `agent-mentions-prototype-plan.md`. The older durable delivery plan is
not being resumed. This document records evidence, not a completion claim.

## Architecture

Retain the existing owner-routed single-attempt messaging RPC and project-host
execution adapter. Store personal names, directional permissions, and account
controls at the human's home bay. Project-owner bays retain agent identities and
execution routing. Neither listing nor approval starts work. Addressing metadata
never grants execution authority.

## Implemented

- Account-home directory, retired-name reservations, principal-scoped grants,
  finite/never expiry, paired directional approval, pause/revoke controls, and
  typed connection requests.
- My Agents, naming, typed rich-text/Markdown agent mentions, and point-of-use
  approval with preserved private drafts.
- Immutable human turn authority, cross-human steering rejection, automation
  settings responsibility, and per-turn credential/reference isolation.
- CLI exact named send, destination discovery, and connection request/inspection.
  A selected reference is pinned to an endpoint; no fuzzy destination fallback.
  Typed requests optionally wait using read-only inspection (120 seconds by
  default); waiting never repeats the mutation or sends a message.

## Evidence

- Fresh-worktree dependency installation completed.
- Initial full development build progressed through backend dependencies but
  found nullable expiry integration errors in the existing communication UI.
- CLI build and test compilation passed; 23 focused CLI tests passed, including
  named sends, canonical/coalesced requests, read-only waiting, credential-bound
  references, and lost message acknowledgments.
- 80 server/PGLite tests passed across personal-store, RPC routing, identity
  routing, and retired-delivery suites.
- 63 Conat tests and 45 project-host regression tests passed. These include the
  existing startup/identity paths, not a new live deployment.
- Runtime integration reports 469 focused tests passing across Lite, AI, Conat,
  server, project-host, and CLI (some overlap the suites above).
- Both subsequent full development builds passed after frontend integration
  fixes. Frontend build/typecheck/lint and 106 focused frontend tests passed;
  four shared mention codec tests also passed.
- Project/tools packaging ran successfully during development; rebuild final
  artifacts after the last source change before rollout.
- The opt-in implementation is deployed on the three local bays and both test
  hosts. Live named request/reply evidence is below; earlier foundation tests
  are not counted as verification of personal authority.

## Validation Commands

Run from this worktree:

```sh
pnpm -C src/packages/cli build
pnpm -C src/packages/cli exec tsc -p tsconfig.test.json
pnpm -C src lint:frontend
pnpm -C src build:dev
node --test src/packages/cli/build/test/cli/src/bin/core/agent-destination.test.js src/packages/cli/build/test/cli/src/bin/core/agent-message.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat-agents.test.js src/packages/cli/build/test/cli/src/bin/commands/project/chat.test.js
NODE_OPTIONS=--experimental-vm-modules COCALC_TEST_USE_PGLITE=1 pnpm -C src/packages/server exec jest agents/personal-store.integration.test.ts agents/rpc.integration.test.ts agents/identity-routing.test.ts agents/retired-delivery.test.ts --runInBand
pnpm -C src/packages/conat exec jest agents/personal.test.ts agents/protocol.test.ts agents/rpc-attempts.test.ts inter-bay/agent-rpc.test.ts inter-bay/agent-identities.test.ts hub/api/index.test.ts --runInBand
pnpm -C src/packages/project-host exec jest codex-project.test.ts project-start-admission.test.ts codex/agent-identity-lease.test.ts hub/hosts.test.ts --runInBand
```

Logs: `/tmp/agent-mentions-{cli,server,conat,host}-tests.log` and
`/tmp/agent-mentions-build-final.log`.

## Deployment And First Live Pass

The ignored wrapper `/home/user/cocalc-ai/src/.local/agent-mentions-hub.sh`
selects this worktree and the existing three dev bay databases. It adds
`COCALC_AGENT_PERSONAL_MESSAGING_ENABLED=1` alongside the existing messaging flags.
Host override files in `/tmp/agent-mentions-{source,qa}-host.local.env` have been
installed on both hosts, preserving existing settings. All three hubs now use
this worktree. Both hosts initially installed candidate `26bf9c3202fa`, then
the corrected runtime bundle
`20260914T022146Z-fa7a97079f35-dirty-280f3d36`. The dirty suffix includes pending
documentation/frontend work, not an unrecorded runtime patch. Merely restarting
the host did not update its desired ACP worker runtime pin. Supported
`host rollout HOST --component acp-worker --reason REASON --wait` was required.
Verified actual worker bundle-version/path fields, not just process cwd.
Both test projects restarted successfully and the installed CLI inside A exposes
`project chat send --to`.

The outer development project's CLI remains a read-only September 11 tools
mount. Human setup integration tests use the regular authenticated Conat API
with the existing home-origin CLI cookie, not a different CLI binary or copied
cross-bay credentials. Agent CLI validation runs inside the test projects.

- Named A `builder`, cross-host recv `reviewer`, and B `local-helper` through
  authenticated account-home API calls. No legacy grants were converted.
- Browser keyboard selection in Markdown showed Agents before People and the
  correct recv thread/project context. Selecting reviewer opened inline approval
  and retained the UUID-bound draft. Canceling fresh auth preserved the draft.
- Browser fresh-auth needs the human's actual verification. The separate genuine
  CLI session approved a one-hour bidirectional QA connection via the normal
  typed API; this is not evidence that browser verification completed.
- First selected-mention turn failed before execution with `api.getIdentity is
not a function`. No inter-agent message was sent. Commit `1c7bfb3c87` adds the
  missing source-host-authenticated mention lookup; 34 server, 38 Conat, six host,
  and three runtime tests passed. Commit `fa7a97079f` avoids redundant naming
  registration and moves technical provenance into collapsed details.
- The corrected full build passed and both ACP workers were rolled forward.
  `21ec3abd05` subsequently groups paired permissions into one UI control and
  improves narrow-screen account navigation. Its static build passed; 46 focused
  tests, frontend typecheck and lint passed.

## Live Named Request/Reply

Account: `27b3d681-3468-44cc-b025-305cbdba4453`, home bay 0.

| Name         | Project                                | Chat                   | Host / bay                |
| ------------ | -------------------------------------- | ---------------------- | ------------------------- |
| builder      | `1ce4fe78-19c7-40a8-a598-947975744cd9` | `/home/user/A.chat`    | host-1 / 0                |
| reviewer     | `66db94af-0745-4088-b922-879c58942201` | `/home/user/recv.chat` | agent-rpc-qa-20260912 / 1 |
| local-helper | `250ac07f-6ce8-43f9-b845-0ffb10c4d041` | `/home/user/B.chat`    | host-1 / 0                |

- Warm correlation `mentions-warm-20260914-03`: builder used its scoped identity
  and `project chat send --to reviewer --stdin --json`. Accepted attempt
  `521ddf85-b62e-47b7-b003-4b9c5b0ea519`; correlated reverse PONG attempt
  `3736d74c-75a5-438e-85df-7c87f1b049f9`. Builder acknowledged locally only.
- Cold correlation `mentions-cold-20260914-01`: receiver stopped with normal
  project stop and read-only metadata confirmed `opened` before sending.
  The single named send was accepted in 4081 ms, attempt
  `aa74abd3-39f9-48e4-a3b6-bda1f45e8fff`. Metadata then showed `running` on the
  same QA host. Reverse PONG attempt `6be2037f-49fa-4aae-b0af-a8e7536638d0`.
  Neither source agent nor test harness issued a separate target start command.
  Attempted browser offline isolation timed out on old hung tabs; the observed
  stopped-before/running-after state and source transcript are the evidence,
  not a claim of complete browser-network isolation.
- No message retry, legacy grant fallback, or alternate agent credentials were
  used. Expired QA connections were renewed explicitly through normal human API
  authorization before the next test, not by a delivery worker.

Local reproduction: use the two named threads above, select `@reviewer` in A,
approve communication in both directions, and request a single correlated send
and reply. For cold testing stop the reviewer project first; do not open its
thread or run target commands before sending. Inspecting My Agents must not
start it. Acceptance is not completion; the separate PONG proves the latter.

Evidence: `/tmp/agent-mentions-warm3-ui.json`,
`/tmp/agent-mentions-cold-{stop,after,running,ui-final}.json`,
`/tmp/agent-mentions-{grant,cold-grant}.json`.

## Browser UI Checks

A newly opened My Agents tab verified build `21ec3abd0586`, rather than relying
on an old tab's cached frontend. At 320px, light/dark directory views and grouped
bidirectional controls are readable without My Agents horizontal overflow.
Keyboard account-menu and connection-details checks passed. No grant mutation,
project opening, or private draft change was needed for these checks.
31 additional focused frontend tests passed and lint remained clean.

Screenshots: `/tmp/agent-mentions-21ec-build-proof.png`,
`/tmp/agent-mentions-21ec-320-{initial,directory-dark,original-group-dark,keyboard-dark}.png`.
The existing global Docs toolbar clipping is outside this prototype's UI.

## Renewal Runtime Correction

The first real expiry test (`mentions-renew-20260914-01`) failed safely before
request creation: after a 75-second wait the CLI found neither an approved
destination nor the turn's selected reference. No request or message was sent.
The deployed Codex protocol ignores `turn/start.env`; successful ordinary sends
had used approved discovery and therefore had not proved reference handoff.

`d008eaa275` exports an identity-relative reference sidecar path at process spawn.
ACP populates it before the turn and removes it afterward. Each scoped runtime
has a distinct identity directory; the CLI still checks agent/run binding.
76 AI tests and 30 host tests passed, including a mock that ignores per-turn env
and checks actual spawn arguments. The host bundle build/typecheck passed.
No CLI/tools update is required. Both hosts and their actual ACP worker pins now
use `20260914T032339Z-21ec3abd0586-dirty-a5620e5a`, containing the source committed
as `d008eaa275`. The QA host operation watcher returned `unknown`, so installation
was verified independently using the current symlink and the running worker's
bundle-version field.

The explicit follow-up `mentions-renew-20260914-02` passed live:

- The agent waited 75 seconds, then resolved the selected name despite expiry.
- Request `c2945674-6075-42ab-8a31-193390bb3bac` appeared in the current chat as
  a typed messaging approval with both endpoint names and project context.
- The fresh-authenticated human QA session approved that exact request. Browser
  human verification itself remains a separate manual check.
- The initial read-only CLI wait reached its deadline. The agent inspected the
  same request read-only, saw `approved`, and explicitly sent once.
- Accepted attempt `a74fb38e-1947-4b05-92fb-bc799f33227f`; no repeated approval
  mutation, message retry, or alternative credentials. The receiver completed
  its local acknowledgment without replying.

Evidence: `/tmp/agent-mentions-renew2-{requests,pending-ui,approved,result-ui}.json`.
The QA connection expires at `2026-09-14T04:46:39Z`; it was not made permanent.

The browser's one-click **Pause all communication** updated the account control
to paused and visibly paused the directory. Restored it through the normal
fresh-authenticated resume API and refreshed the UI. Before/after per-link
attempt/acceptance timestamps were identical: resume did not send/replay work.
Evidence: `/tmp/agent-mentions-{paused-api,paused-ui,resumed-api,resumed-directory,resumed-ui}.json`.

## Two-Human Live Checks

- Genuine Q was denied steering P's active turn.
- P then Q automation settings writes transferred responsibility/revision to Q;
  a later P acknowledgment retained Q and its revision.
- An actual scoped agent was denied a human-only automation mutation.
- Q's ordinary execution was rejected by `queued_per_account 0/0`. No funds,
  execution entitlements, or provider credentials were added for this test.
- Adding Q to the cross-bay receiver failed with
  `projects.createCollabInvite: account not found`. No database bypass was used.
- Removed only the Q membership added to A and the disposable QA automation;
  retained QA chats and evidence. No host or provider cleanup was necessary.

Detailed local evidence and exact commands:
`src/.local/human-turn-qa/RESULTS.md` and `CLEANUP.md`.

Live evidence: `/tmp/agent-mentions-{grant,picker-open,inline-approval,warm-running}.json`,
`/tmp/agent-mentions-picker.png`, and host/project upgrade logs with this prefix.

## Deliberate Limitations

- Account rehome fails closed when personal messaging state exists, including
  tombstones and revoked grants. Cross-bay messaging is supported; moving the
  account's home requires a later versioned state migration implementation.
- In-turn approval appears in the current chat through three-second read-only
  polling, not native ACP attention events. Approval never itself sends.
- Per-turn credentials constrain server APIs, not hostile processes sharing the
  same operating-system user. Shared project content can influence model output.

## September 14 Connection Table And Naming Follow-Up

- My Agents now uses a semantic HTML table with one summary row per endpoint
  pair, usable direction indicators, and keyboard-operable Details controls.
  Independent live approvals remain separately controllable inside Details;
  expired/revoked approvals remain in collapsed read-only history. No records
  were deleted or grants changed by this presentation cleanup.
- Composer and typed in-turn approval dialogs require an unnamed source to be
  named before creating a new grant. Existing grants are not retroactively
  altered. Naming and granting are separate operations: if naming succeeds but
  subsequent fresh-auth verification is canceled, the name can remain, without
  a grant or send.
- Both naming dialogs check syntax and conflicts against the loaded personal
  directory as the user types. The server remains authoritative for concurrent
  changes and retired names; a server-side naming conflict prevents approval.
- Validation: 58 focused frontend agent tests, frontend typecheck, frontend lint,
  and the static development build passed. Tests cover source naming in both
  approval paths, cancel/deny, name races, directional summaries, overlapping
  grants, collapsed history, and keyboard expansion/collapse.
- Deployed the frontend to lite1b. In a fresh Chromium tab, verified the actual
  builder/reviewer pair has one row and five historical approvals; checked the
  table at 320 CSS pixels (document width 320, table width 285), keyboard
  expansion/collapse, and actual light/dark appearance controls. Verified live
  duplicate-name feedback and disabled Save, then canceled. Restored the
  original system appearance. No names, permissions, or messages were mutated.
  Source-naming approval itself is covered by component tests, not a new live
  grant in this follow-up.
- Evidence: `/tmp/agent-mentions-ux-all-agents-tests.log`,
  `/tmp/agent-mentions-ux-{tsc,lint,static}.log`, and
  `/tmp/agent-mentions-ux-{table,details}-dark-real.png`.

## Remaining Acceptance Work

Live expiry/renewal and mobile UI checks are complete as described above.
Deterministic tests also cover rename stability, pause/revoke, expiry, credential
isolation and honest unknown outcomes; they are not substituted for unperformed
live checks.

Actual external validation blockers are completing browser human verification
and obtaining a runnable second QA account plus its cross-bay project access.
Positive successive P/Q turns have not been live-proven. The new path stays
opt-in; these gaps prevent a claim that every acceptance test is complete.

Next concrete manual step: open account **My Agents**, open `builder`, type `@`
and select `reviewer` (the recv chat on the QA host, not `local-helper` in B).
After the temporary grant expires, selecting the mention should offer inline
approval. Complete browser fresh auth and choose the intended direction/duration.
Then ask builder for one correlated send/reply. A bare typed name without picker
selection is not the same as a UUID-bound mention.
