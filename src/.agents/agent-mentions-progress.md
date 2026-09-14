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
- Adding Q to the cross-bay receiver initially failed with
  `projects.createCollabInvite: account not found`. Fixed in `856255a520`:
  the inviter's account-home handler verifies product access before routing;
  the internal project-owner handler does not require a second local account
  row. Public input cannot supply that internal verification.
  After restarting all three hubs, P added genuine Q to recv, Q read the
  collaborator list through its own session, and P removed Q. The final list
  contains only P. No database bypass, credential copying, or quota changes.
  Evidence: `src/.local/human-turn-qa/logs/collab-fix-*.json`.
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
- In-turn requests are projected read-only into the existing frontend Codex
  attention cards, thread badges, and local notification handling. The
  account-home request remains authoritative; this is not a new persisted ACP
  event stream or a second approval store. The normal attention refresh polls
  every five seconds and the typed request renderer refreshes every three
  seconds. Approval never itself sends. Live display, refresh, expiry, denial,
  keyboard, narrow-width, and actual 200% zoom checks passed below.
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

The specific live expiry/renewal and mobile UI checks above passed.
Deterministic tests also cover rename stability, pause/revoke, expiry, credential
isolation and honest unknown outcomes; they are not substituted for unperformed
live checks.

Still unverified against the full plan:

- Successive P/Q/P turns now demonstrate different personal reviewers and actual
  reused-session credential rotation (see the final section). Q's simultaneous
  site-funded sender/receiver execution is still denied by the one-turn policy;
  it is not an end-to-end receiver-completion pass.
- Positive approval/renewal through the native attention card. Live display,
  pending-state restoration across refresh, expiry, and denial now pass below.
- A forced stale-session browser challenge on the exact current candidate has
  not been repeated. The human reports successful fresh-auth approval earlier
  and successful approval with new threads now; the shared fresh-auth component
  is unchanged from the RPC foundation. This is not a blocker to further
  messaging tests. Composer selection/review/cancel, the pending attention card,
  and My Agents naming/table also pass at actual 200% browser zoom below.

The second account's email-verification prerequisite is resolved and real turns
now execute under Q. The subsequent cross-bay account lookup bug was fixed and
deployed; the site-funded concurrency limit is separate. Do not bypass email
verification or change membership, billing, or provider credentials to make QA
pass. The dev CLI has working fresh auth, but it is not the browser's
session. Completing the browser's passkey confirmation requires the human;
canceling it and approving through the typed CLI is not a browser approval pass.
Cross-bay collaborator setup has now been fixed and live-verified; temporary
access was removed after the test.
Live stopped-target revocation, account controls during an owning-bay outage,
and the accepted-to-unknown response-loss test now pass; see the final sections.
The new path stays opt-in; these gaps prevent a claim that every acceptance test
is complete.

Next concrete manual step: open account **My Agents**, open `builder`, type `@`
and select `reviewer` (the recv chat on the QA host, not `local-helper` in B).
After the temporary grant expires, selecting the mention should offer inline
approval. Complete browser fresh auth and choose the intended direction/duration.
Then ask builder for one correlated send/reply. A bare typed name without picker
selection is not the same as a UUID-bound mention.

## September 14 Attention Integration

- The existing chat attention summary merges pending personal requests for the
  authenticated account and exact source thread. It loads only identity metadata
  for the open project, not live chat documents for all named agents.
- The messaging-specific card invokes only the existing typed approval renderer;
  generic Codex question responses cannot grant a connection. My Agents retains
  its account-wide recovery inbox; the separate composer inbox was removed.
- Account/context switches discard old records. Temporary messaging API failures
  do not hide ordinary Codex attention. Naming/approval errors remain visible
  inside the open dialog, rather than behind it.
- 82 focused tests passed before the navigation follow-up, with conat and
  frontend typechecks, frontend lint, and the development static build.
- Live denial test submitted once in builder: request ID
  `d1f52c12-22d5-42b4-b807-a6fb768b305e`. At 04:53 UTC the agent was still running
  without a recorded tool call; no request had reached the account store.
  This is not evidence of a successful approval test and was not retried.
  Persisted activity: `src/.local/human-turn-qa/logs/attention-native-activity.json`.
- At 04:59 UTC explicitly interrupted only that bounded QA turn through the
  authenticated execution API after ten minutes without a recorded tool call.
  The API initially returned `queued`; subsequent supported live chat inspection
  at 05:00 confirmed `generating=false`, `acp_interrupted=true`, manager finished,
  and no background terminals. The request ID never entered the personal request
  list. No request, grant, or send was replayed. Evidence:
  `src/.local/human-turn-qa/logs/live-attention-{interrupt,status}-*.jsonl`.

## September 14 Approval Error Persistence

- Reproduced a failed naming/approval error disappearing on the next successful
  background refresh. Separated read errors from action errors; refresh now
  preserves the failure and source-name draft. Explicitly reopening the request
  clears the old action error, and attempting approval again remains deliberate.
- The regression test failed before the fix and passed after it. 77 focused
  agent/attention tests, frontend typecheck, and frontend lint passed; the final
  focused naming suite also checks dismiss/reopen behavior (9 tests).
- Logs: `/tmp/agent-mentions-poll-error-{before,tests,final-tests,tsc,lint}.log`.
- Deployed frontend commit `b75decce59`; the static build completed successfully.
  Runtime/hub code and project permissions were unchanged by this fix.

## September 14 Actual Browser Zoom Check

- Used Chromium's visible Appearance / Page zoom setting, not CSS zoom or a
  viewport emulation. At 200%, `outerWidth` remained 1920 while `innerWidth`
  changed from 1920 to 960 and `devicePixelRatio` from 1 to 2.
- My Agents had no horizontal document overflow; its connection table fit the
  content area. Enter opened the naming dialog, duplicate-name feedback disabled
  Save immediately, Tab reached the footer and scrolled it into view, and Escape
  restored focus to Rename @builder. Enter also expanded connection Details.
  No name, grant, or message was saved by these checks.
- Restored the original 100% setting through the same browser UI and verified
  width 1920 / DPR 1 again. All temporary browser zoom changes are cleaned up.
- Evidence: `/tmp/agent-mentions-zoom-{before,after,dialog,dialog-footer,focus-return,table,restored}.json`
  and `/tmp/agent-mentions-zoom-{dialog,dialog-footer,table}.png`.

## September 14 In-App Agent Navigation

- Replaced My Agents' full-page Open link and rich-text agent mention navigation
  with a shared `openAgentThread` helper. It loads the project Redux runtime on
  demand, then uses `open_file` with foreground project/file and an exact thread
  fragment. Opening retains the normal project access/start behavior; listing
  does not invoke it. Failures remain visible instead of falling back to reload.
- 86 focused tests, frontend typecheck, frontend lint, and static build passed.
  Keyboard activation calls navigation once; tests cover the endpoint/fragment
  and visible errors without automatic retry.
- Live at 04:55 UTC: pressed Enter on Open @builder from My Agents. Arrived at
  A.chat with `#thread=5637b4f8-063d-4ed9-9637-e24d208c20f7` and the builder
  control visible. The window sentinel and `performance.timeOrigin` were
  unchanged, proving same-document navigation rather than a reload.
  Reproduction helpers: `/tmp/agent-mentions-navigation-{before,after}.js`;
  check logs: `/tmp/agent-mentions-navigation-{tests,tsc,lint,static}.log`.

## September 14 Native Request And Responsive Review

- Real agent request `83a363ea-6d87-4655-a8f7-13a3ca462e9c` was denied in the
  My Agents recovery inbox. The waiting CLI returned `denied`, and the agent
  ended without sending. Exact assistant activity is in
  `src/.local/human-turn-qa/logs/native2-final.json`.
- An initial suspicion that the native card was missing came from truncated
  whole-page text. Targeted DOM/component inspection disproved that diagnosis;
  no speculative attention polling/routing change was made.
- Diagnostic request `404be82f-0099-4de8-ba33-134cdb47f94b` appeared in the exact
  source chat and survived a page reload. At 320 CSS pixels, its review button
  was 1305px wide, clipping the destination. Commit `e38fd723a1` separates
  wrapping endpoint context from a compact 204px review button, retaining the
  complete accessible name. Dialog identifiers wrap as well.
- At 320px after deployment: Enter opened Review; duplicate `reviewer` feedback
  immediately disabled approval; Tab reached the footer and scrolled it into
  view; Escape returned focus to Review. No horizontal document/dialog overflow.
  This diagnostic expired before the first zoom check finished; authoritative
  state became `expired` and the card/dialog disappeared. It was not renewed,
  approved, or replayed.
- Fresh bounded request `17b95918-482b-471b-8740-7873a56a961b` tested actual
  Chromium 200% zoom: outer width 1920, content width 960, DPR 2. Enter opened
  the native card, Tab reached Deny, and Enter submitted the exact typed denial.
  The account-home API confirmed `denied`; the dialog/card cleared. Restored
  100% zoom (width 1920, DPR 1) and closed the temporary browser settings tab.
  All three requests were approval-only tests with no message dispatch or grant.
- Validation: 45 focused tests across source naming, mentions, attention hook,
  and attention cards; frontend typecheck, frontend lint, static build all pass.
  Static build log: `/tmp/agent-mentions-attention-narrow-static.log`.
- Reproduction: create a fresh scoped `request-connection` with `--wait-seconds 0`
  in the disposable `human-turn-qa-1789350561320.chat` thread, open that same
  thread, reload, focus Review and press Enter. Check at 320px and Chromium's
  Appearance / Page zoom 200%, then explicitly deny. Do not resubmit the guarded
  completed integration cases. Browser helpers and JSON/screenshots are under
  `/tmp/agent-mentions-attention-{narrow,zoom2}-*`; authoritative outcomes are
  `/tmp/agent-mentions-native3-current.json` and
  `/tmp/agent-mentions-attention-zoom2-denied.json`. CLI terminal summaries are
  `/tmp/agent-mentions-native{3,4}-final.json`.
- Next concrete step: exercise positive naming/approval and composer preflight
  at 200%, then the stopped-receiver test with all receiver UIs closed. The
  positive two-human test and live fault-injection cases above remain open.

## September 14 Isolated Cold Start And Pause

- At actual Chromium 200% zoom, the native request
  `63286da3-ed34-4bf4-9e13-c7db0c17a72c` accepted source name `messaging-qa`.
  Browser fresh auth then requested a passkey. Canceled that dialog and verified
  the request remained pending with no grant. The saved name remained. Restored
  100% zoom. The separately authenticated, fresh human CLI deliberately approved
  that exact pending request at the account home; both directional grants expire
  at 06:53:39 UTC. This is not evidence of completing browser passkey auth.
- Closed the receiver file in both active browser sessions and closed all three
  receiver-page CDP targets. Stopped project
  `66db94af-0745-4088-b922-879c58942201`; two metadata-only checks separated by
  ten seconds confirmed `opened` (stopped), including after directory inspection.
- The real source agent in `human-turn-qa-1789350561320.chat` used its own CLI
  identity, discovered `reviewer`, and sent once with attempt
  `a5ad4f39-6fa7-4348-970e-f18f00e39149`. Source is on host-1 / bay-0; receiver
  is on the QA host / bay-1. At 05:57:52.053 the receiver host's existing Codex
  runtime logged starting the stopped container. The CLI observed acceptance at
  05:57:54.307, about 3.9 seconds after its command began. No independent browser
  or harness start occurred.
- Receiver used the explicit reverse grant for one reply, attempt
  `1b4af483-c558-41be-8f76-173c0bf63435`, accepted at 05:58:16.378. Correlation:
  `mentions-isolated-cold-1789365452866`. Source acknowledged locally without
  replying again. Both real execution logs are terminal; acceptance and model
  completion were inspected separately. No send was retried.
- Then paused all personal communication through My Agents and stopped the
  receiver again. A single real named-CLI send with attempt
  `c1728ae3-cbce-4898-a98f-04aa310e6a1d` failed before dispatch: no approved
  destination or selected current-turn reference. Its source run completed at
  06:04:09.417. Receiver remained stopped; both grants' attempt/acceptance
  timestamps remained those of the preceding successful exchange. This proves
  the named CLI path, not a live low-level explicit-ID bypass test.
- At 06:09:17 restored the prior unpaused account state through the typed fresh
  human CLI. Receiver still stopped with unchanged last activity. Resume did not
  start it or replay the blocked message. No memberships or provider settings
  changed. The finite QA grants and named disposable chat remain for inspection.
- Reproduction: `.local/human-turn-qa/live.sh` modes `cold-isolated-send` and
  `paused-cold-send` are guarded one-shot cases; inspect their saved IDs rather
  than rerunning them. Read completion with `project chat activity` and stopped
  state with `project get --project <id>`. Evidence is under
  `/tmp/agent-mentions-isolated-cold-*`, `/tmp/agent-mentions-paused-cold-*`,
  `/tmp/agent-mentions-positive-cli-*`, and `.local/human-turn-qa/logs/`.
- Next: finish remaining browser approval/200% composer and live fault cases.
  Positive two-human credential rotation still needs a runnable second account.

## September 14 Naming Context And Composer Zoom

- Live source naming during native approval saved only a short name, leaving
  `messaging-qa` with generic thread/project labels. Commit `e57d1b09af` snapshots
  cached account project titles and already-open thread metadata for explicit
  naming and source naming during approval. Composer approval carries its exact
  thread context; an out-of-composer save resolves identity metadata only. No
  project or chat is opened to enrich a name, and missing titles stay unknown.
- Validation: 39 focused naming/mention tests, frontend typecheck, frontend lint,
  and the static development build passed. Deployment log:
  `/tmp/agent-mentions-name-context-static.log`.
- At 06:17 UTC, reloaded the actual disposable chat, opened Rename
  `@messaging-qa`, and pressed Enter on Save with its name unchanged. The
  authoritative directory now contains thread title
  `human-turn-qa-1789350561320` and project title `fresh-project`; My Agents
  rendered both after reload. Receiver remained stopped. Evidence:
  `/tmp/agent-mentions-name-context-{dialog,saved,directory,receiver}.json`.
- At real Chromium 200% zoom (1920 outer pixels, 960 CSS pixels, DPR 2), typed
  `@` in the empty disposable Markdown composer, filtered `local`, and used Enter
  on the exact `local-helper` option. The unconnected destination triggered
  inline approval. Source and destination context were visible, with no
  horizontal page/dialog overflow. Tab reached duration, direction, details,
  Cancel, and Approve; the footer scrolled into view. Escape closed the dialog,
  returned focus to the editor, and preserved the complete typed reference.
- Account-home inspection confirmed no grant for that source/target pair. No
  approval or send was submitted. Restored only the exact QA reference draft to
  its original empty value, restored 100% zoom, and closed the temporary Chrome
  settings tab. Evidence: `/tmp/agent-mentions-composer-zoom-*`, including the
  picker/footer screenshots and cancel/restoration JSON.
- Remaining: genuine positive browser passkey approval, positive successive
  two-human execution, live revoke/owning-bay outage, and lost-acknowledgment
  behavior. The implementation goal remains open; the second runnable account
  and human browser verification are prerequisites, not reasons to skip the
  independent fault tests.

## September 14 Owning-Bay Outage And Revocation

- Suspended only the receiver bay-1 hub PID 682339 at 06:32:27 UTC, with a
  240-second automatic SIGCONT watchdog and explicit cleanup. Loopback health
  timed out while the process was stopped. The receiver project was stopped.
- At 06:32:44, account-home listing and revocation succeeded without bay-1.
  Both directions in disposable QA group
  `c569c657-7e96-4ed5-8030-fdb959d47ffd` became revoked. History was retained.
- The source submission during this outage failed before model execution:
  resolving its selected mention timed out in `agent.getMentionIdentity`.
  Attempt `570a7700-3cf6-453b-8b7b-43fa6e4acbf3` therefore proves fail-closed
  turn admission, not a send-time rejection. It was not retried or replayed.
- After the watchdog restored bay-1 at 06:36:27, a separate deliberate negative
  test used the real scoped CLI and selected reference. Attempt
  `0f8824f9-2cba-4e7f-975c-969bde19fe0c` returned `rejected`, `grant_revoked`.
  Receiver stayed stopped with unchanged last activity; no renewal was requested.
- A second, tightly bounded outage verified the actual My Agents pause button:
  bay-1 suspended at 06:45:46.500; account-home controls confirmed paused at
  06:45:49.192 while `ps` still showed the hub stopped; explicit SIGCONT restored
  it at 06:45:49.251. Account pause was then restored to false. An earlier UI
  click occurred after watchdog recovery and is not counted as outage evidence.
- Artifacts: `/tmp/agent-mentions-outage-{revoked,after-revoke}.json`,
  `/tmp/agent-mentions-revoked-recovered-activity.json`,
  `/tmp/agent-mentions-outage-ui-{paused-verified,restored}.json`, and
  `/tmp/agent-mentions-outage-final-receiver.json`. The ignored guarded harness
  has separate `revoked-outage-send` and `revoked-recovered-send` cases; inspect
  their existing IDs rather than resubmit. No target membership or quota changed.

## September 14 Live Lost Acknowledgment

- Added the opt-in test adapter and reproduction notes under
  `packages/cli/sea/agent-messaging-lost-ack.*`. It wraps the built production
  `sendIdentityMessage` helper, preserving its actual runtime credential lookup,
  Conat transport, validation, unknown handling, and close behavior. A matching
  accepted acknowledgment is deliberately discarded at the CLI transport
  boundary. This is response-loss injection, not a claim of a physical outage.
- A new explicit ten-minute one-way QA permission was created through the fresh
  human's account-home API. Previous revoked grants remained revoked. Uploaded
  fixture SHA-256:
  `69e41a1f6b1acd57f7de020330aebf294ddbec778b0f2fe65333f0edfe008f21`.
- Real `@messaging-qa` executed the fixture once with its own scoped environment.
  Attempt `8897d818-6ff2-4449-ad7c-5fc093c48595` was accepted across hosts/bays
  at 07:07:51.970. The fixture discarded that exact acknowledgment and the real
  CLI helper returned `unknown` at 07:07:52.018. The source's terminal activity
  contains one command, exit 0, and an honest unknown summary. No permission
  renewal request was created.
- Independently observed one receiver input
  `fbba7ca2-16f3-4538-be36-4658d85dabf4` with authenticated attribution and the
  matching attempt. Its assistant `04cc9979-1399-41a8-bae5-f556eaa41298` completed
  at 07:09:53.328, acknowledging locally with no tools or outgoing message.
  Early activity inspection showed only queued state; it was not treated as
  failure and no restart/replay was attempted. Final live chat has exactly this
  input/response pair after the test's submission, both not generating.
- Revoked only the new QA group `cd692d1d-3d52-40d1-8094-d7b379fe7a5e` at
  07:11:03.316 after completion. Account-wide pause remains off and bay-1 is
  running. Receiver is left running after its admitted test; histories and
  diagnostic evidence are retained, not erased.
- Evidence: `.local/human-turn-qa/logs/lost-ack-source-activity.json`,
  `live-lost-ack-{install,grant,send,evidence}-*.jsonl`,
  `/tmp/agent-mentions-lost-ack-receiver-activity-2.json`,
  `/tmp/agent-mentions-lost-ack-receiver-final.jsonl`, and
  `/tmp/agent-mentions-lost-ack-{requests,cleanup}.json`. Harness send is guarded
  against resubmission, and the fixture independently reserves its evidence path
  before any network request.
- Validation: CLI build passed; 11 focused helper/destination/fault-adapter tests
  passed. No production source changed in this fault-test increment. Positive
  successive two-human execution and actual browser passkey approval remain
  unverified; they are not replaced by this successful fault test.

## September 14 Second-Human Prerequisite Recheck

- At 07:14 UTC, Q's own authenticated account-home `purchases.getMembership`
  returned a queue allowance of 20 and running allowance of 3. The earlier
  `queued_per_account 0/0` failure is not evidence that free membership forbids
  agents. No membership or funding change was made.
- Q's own account read reported its current email unverified. A scoped,
  read-only admin query at its known home bay confirmed no registration trust
  marker. The seed-authoritative settings API confirmed email verification and
  email sending enabled with a configured backend.
- The relevant path is `project-host/acp-worker.ts` ->
  `server/conat/api/hosts.ts:getAccountEffectiveLimitsLocal` ->
  `server/accounts/trusted-product-access.ts`. Before applying membership limits,
  this path returns zero ACP limits when product-access trust fails. Complete
  the normal email-verification flow or use an already verified QA account;
  do not edit trust flags, disable verification, or pay for an upgrade to work
  around this prerequisite. Agent/provider readiness still needs verification
  after the account passes that gate.
- No new turn, grant, collaborator change, or authentication mutation was made
  during this read-only recheck. Evidence:
  `.local/human-turn-qa/logs/live-Q-prerequisites-*.jsonl`,
  `/tmp/agent-mentions-Q-trust-current.json`, and
  `/tmp/agent-mentions-trust-settings.json`. Browser passkey completion remains
  a separate human action; the positive two-human execution gate is still open.

## Human Follow-Up

- The human verified Q's email. A read through Q's own authenticated session at
  07:33:43 UTC confirmed `email_verified: true`, queue allowance 20, and running
  allowance 3. Evidence: `/tmp/agent-mentions-Q-user-verified.jsonl`. The known
  email-verification prerequisite is resolved; normal runtime and provider
  admission still need to be exercised, not bypassed.
- The human reports that fresh-auth approval worked earlier, and that a new
  test using new threads worked well. Signing in again left their session fresh,
  so this latest report does not independently demonstrate an expired-session
  challenge. `frontend/auth/fresh-auth.tsx` has no diff from foundation commit
  `4a1c89014e`. Record the successful current new-thread workflow without claiming
  a fresh challenge was observed or requiring repeated sign-ins.
- Next concrete step: resume genuine successive P/Q turns in the shared QA
  thread with distinct personal reviewers, current per-turn credentials, and
  normal project/provider gates. Do not hold that test for another auth prompt.

## September 14 Successive Humans And Remote Execution

- Restored only Q's temporary collaborator access to the two QA projects, after
  recording existing members. P and Q each approved a separate 30-minute,
  one-way connection from the same disposable source agent. Both personally
  named their different destinations `reviewer`; Q's destination is a distinct
  disposable thread in the receiver project, not P's `/home/user/recv.chat`.
- Actual source turns P1, Q1, P2 reused Codex conversation
  `01a09d9b-1c00-7df1-add3-cb9e77eef6a2`. Each ran the installed CLI's `whoami`,
  `destinations`, and one `send --to reviewer`. Destination discovery exposed
  only that turn's human's grant and endpoint. Source-owner run records confirm
  principals P, Q, P for run IDs `d492bb97-5af0-49ed-a72e-e12b5dc92551`,
  `a9f0ddb6-9041-4364-bd25-a9afe951a808`, and
  `64900360-7bf3-432b-b443-a75fe1d3b4ca`, respectively. All three sends were
  accepted. P's two receiver turns completed local acknowledgments.
- Q1 attempt `923a9513-b7a0-411b-86fe-0aa688de5dff` was accepted, but its
  receiver failed the included-Codex verification gate. Read-only inspection
  established Q is verified in the seed directory and has no account/directory
  row on receiver bay-1. `reserveSiteFundedCodexTurn` incorrectly used a local
  directory lookup. It now uses the existing routed `getClusterAccountById`;
  no account rows, credentials, trust flags, or permissions were copied or
  changed to resolve this. The regression reproduced the exact denial before
  the fix. Server build passed and all three dev hubs were restarted with it.
- A new explicit Q2 attempt `8b316f92-8bd5-4fa2-a00d-b923f43a4f34` selected Q's
  destination and was accepted. Verification now passed, but receiver execution
  correctly failed with `Another site-funded Codex turn is already active for
this account.` The included-Codex policy permits one simultaneous turn per
  account, and the sender was still active. Neither accepted attempt was
  automatically retried or reinterpreted as rejection. Their saved failure
  histories remain intact. This policy currently prevents overlapping
  site-funded agents from completing this workflow; transport acceptance does
  not promise eventual execution.
- After Q2 completed, a separate, explicit human-Q turn in that same receiver
  completed with `Q receiver execution confirmed` at 08:12:08 UTC. Receiver
  assistant `5ad96a70-e3da-4ab7-acab-7eafd93218cc`, run
  `edbc8a84-cd84-45fe-9dfd-f7798a9f6ee5`, has Q's account in bay-1's run registry,
  despite P being the original thread registrant. This proves routed admission
  and execution as Q, not completion or replay of either prior agent message.
- Validation: server build passed; 126 host API tests passed, including seven
  new routed-admission cases covering remote eligibility, home-bay entitlement,
  principal attribution, denied accounts, directory outage, and host access.
  Broad `tsc -p tsconfig.test.json --noEmit` still fails on existing unrelated
  test errors (including unused params, unique-symbol typing, and obsolete Host
  fields); no new test block errors were reported. No frontend code changed.
- Revoked both temporary QA connection groups after completion. Removed only
  the temporary Q collaborator memberships, preserving P/Blaec and chat history.
  Existing QA names remain; the disposable Q receiver model was set to the
  supported `gpt-5.6-sol`, with normal site-funded selection left in force.
- Evidence: `/tmp/agent-mentions-PQ-{P1,Q1,P2}-final.json`,
  `PQ-source-runs-final.json`, `PQ-Q2-final.json`, `PQ-Q-isolated-activity.json`,
  `PQ-Q-receiver-runs.txt`, and `PQ-cleanup-grants.jsonl`, all under the same
  `/tmp/agent-mentions-` prefix. One-shot integration scripts/state and typed
  CLI evidence are in `.local/human-turn-qa/`; completed cases reject replay.
- Reproduce: approve fresh bounded personal grants for two authenticated humans
  to distinct named reviewers, then submit P/Q/P sequentially in one shared
  source thread. Read activity and source/receiver run-account IDs without
  credential fields. For included-Codex accounts, explicitly distinguish the
  concurrent receiver denial from a subsequent isolated human receiver turn.
  Focused checks: `pnpm -C src/packages/server build` and
  `pnpm -C src/packages/server exec jest conat/api/hosts.test.ts --runInBand`.
- Next: positive native attention approval/renewal with the current browser
  session. Separately decide the desired scheduling/product behavior when the
  included-Codex concurrency allowance is one; do not add message retries or
  relax funding limits implicitly. No new human authentication action is needed
  to explain or fix the cross-bay lookup issue resolved here.
