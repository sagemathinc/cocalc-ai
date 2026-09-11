# Workbench First Release: Go/No-Go

Updated 2026-09-11. Candidate branch: `feature/chat-workbench-prototype`, draft
PR #509. Validation checkpoint: `8d0f56b8a9` (following thread opt-in change
`b3c41aed5a`). No production deployment or external support/email action was
performed. This is a focused release-readiness pass, not a security certification.

**Status: conditional, not yet signed off for release.** Keep the PR draft until
the remaining gates below have evidence against the frozen release build.

## Scope And Important Limits

- Ship existing Markdown, bounded file/image previews, proposed action lists,
  PRs, and pinned commits. Do not add another artifact type before release.
- Workbench default publication requires both the full chat surface and saved
  per-thread `acp_config.workbench: true`; missing is off. Agents page/flyout
  does not advertise workbench publication.
- This preference is NOT a global kill switch or an authorization boundary.
  Existing cards, tabs, search, and feedback remain available. Explicit
  experimental CLI publication remains possible. Assistant selection replies
  are not switched off by this checkbox. Do not describe this as disabling all
  new frontend code for non-opted-in users.
- Proposed-action decisions are review snapshots, not execution permissions.
  External operations must still use their existing hub authorization,
  temporary fresh-auth, and audit path. No Zendesk/email execution in QA.
- File previews identify current saved contents, not a guaranteed historical
  snapshot. Unsupported active formats must retain the Open file fallback.
- Restrict initial invitations to the maintainer/testers, but understand that
  the checkbox itself is not an account allowlist.

## Evidence From This Pass

| Area                      | Result                            | Evidence / limitations                                                                                                                                                               |
| ------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frontend                  | 190 tests passed across 23 suites | Cards, catalog/search, previews, read-only rendering, workbench, local comments, feedback drafts, frame reuse, thread settings, and sends.                                           |
| Shared artifact model     | 39 tests passed                   | Typed records, bounded payloads, stale update rejection, retry identity, exact proposal snapshots, commit/PR validation.                                                             |
| ACP adapter               | 70 tests passed                   | Includes current-turn runtime guidance and reused-session environment propagation.                                                                                                   |
| Runtime environment       | 5 tests passed                    | Workbench flag derives from request context rather than inherited environment.                                                                                                       |
| CLI publication           | 6 tests passed                    | Publishing shortcut, attribution, reviewed bases, retries, opt-in, and exact message resolution.                                                                                     |
| Build                     | Passed                            | Frontend typecheck, CLI test compilation, frontend lint, static development build. Not a substitute for production packaging.                                                        |
| Installed QA CLI          | Publish help succeeds             | Project `1ce4fe78-19c7-40a8-a598-947975744cd9`; installed command supports file, commit, JSON, update/base shortcuts. Does not qualify every production host.                        |
| Live stored artifacts     | Passed                            | Authenticated project-host SyncDB read validated 10 current artifacts and 16 publications in the existing disposable QA chat. No `.chat` filesystem inspection or mutation.          |
| Persisted generated image | Passed                            | `runtime-image-smoke`: PNG signature, 1,509,823 bytes, below preview limit; renders after fresh browser navigation. This is an existing generated image, not a new model generation. |
| Whole-image feedback      | Passed                            | Local editor opens with snapshot notice and dismisses without a send. Original browser tab/composer was not used for the interaction.                                                |
| Opt-in UI                 | Previous pass passed              | Enable/save/reload and disable/save/reload; keyboard help, narrow and light/dark layouts. QA thread remains off.                                                                     |

### Iteration 1: Selection Regression Coverage

- Area: workbench comments. Result: bug found in tests, not a reproduced
  production regression. Severity: low, but blocks a clean release test run.
- Repro/evidence: two workbench tests failed expecting feedback to be staged in
  the main composer; JSDOM also lacked the selection rectangle API.
- Root cause: assertions still described the superseded feedback UI.
- Fix: exercise the real selection wrapper with a DOM rectangle and observe
  its local-editor boundary. Check exact selected text after an artifact update,
  no main-composer staging, and no frame navigation in either maximized state.
- Validation: workbench's 11 tests and the complete 190-test frontend selection
  above pass. Private draft/send behavior retains its separate real-editor tests.
- Commit: `8d0f56b8a9`.

### Iteration 2: Model And Runtime Contracts

- Result: no new bug reproduced in the tested contracts. Severity: none assigned.
- Evidence: shared model, ACP, runtime environment, and CLI suites above pass.
- Fix: none. These results do not prove live cross-account authorization or
  that a model will choose to publish an artifact.

### Iteration 3: Live Runtime And Persisted Image

- Result: authenticated live read and image/comment smoke passed; one invalid
  harness probe timed out. Severity: no product severity assigned to that probe.
- Repro: running artifact list inside a generic `project exec` shell returned
  `once: timeout of 30000ms waiting for "info"`. That shell had neither
  `COCALC_API_URL` nor `COCALC_PROJECT_ID`; it was not an agent-runtime session.
- Evidence: installed help works; an independently authenticated project-host
  read succeeds, and the existing generated file renders in the browser.
- Fix: no speculative routing patch. Run the final publication smoke from an
  actual agent turn with issued runtime context, not that unconfigured shell.
- Commit: none; operational evidence only.

## Remaining Release Gates

Record operator, exact builds, time, and result for each. Mocked tests do not
close a live permission or model-behavior gate.

1. **Two real accounts and access changes.** In a disposable project, verify
   owner/writer collaboration on a Markdown artifact, including simultaneous
   edits and reconnect. As a viewer, verify readable permitted previews but
   no edit, comment/send, proposal mutation, or execution. Create an unsent
   local comment as account A and verify account B cannot see the draft.
   Revoke access and verify subsequent reads/writes fail appropriately; do not
   expect already-rendered bytes to be erased from a browser's memory.
2. **Frozen runtime, real agent smoke.** Use the actual release CLI/tools,
   project-host/ACP worker, and frontend. In a new opted-in disposable thread,
   request a Markdown plan and a generated image without mentioning artifacts.
   Verify the cards, correct thread, usable file/image, follow-up update, and
   local feedback reaching the originating thread. Run
   `scripts/dev/check-workbench-image-publication.js` in that agent context.
   Repeat an ordinary plan request with opt-in off in the same reused session
   and from Agents: no default publication. Keep these paid tests manual, not CI.
3. **Compatibility and recovery.** On copies, check reload/reconnect, history or
   backup restore with artifact rows, and coexistence with a pre-release browser
   client. A stale client must not discard artifact rows while editing chat.
   Test an ordinary non-opted-in chat and basic notebook/terminal opening with
   the production bundle, since this preference does not remove all new UI.
   Record a known-good frontend/runtime rollback pair and verify compatibility
   with saved artifact rows before relying on it.

If any gate fails, either fix and rerun it or explicitly reduce the exposed
release scope. Do not turn an untested result into a pass because usage is small
or the release window is quiet.

## Deployment Order

1. Freeze a candidate SHA and record frontend, tools, project-host, and ACP
   worker build identities. Run production packaging using the normal release
   process. Preserve a tested rollback pair and QA chat backup/history point.
2. Qualify the matched stack on staging/a disposable project first. Check the
   installed CLI inside a running agent turn; checkout source and `--help` alone
   do not establish publication works. Do not restart unrelated active projects
   just to upgrade the QA runtime.
3. Deploy compatible runtime/tools before advertising the frontend opt-in.
   Existing containers may still have old mounted tools; verify the actual
   installed version and retain the documented ordinary-link fallback.
4. Leave all missing preferences off. Do not bulk-enable threads or migrate
   old artifact-bearing threads to on. Initially invite only the test cohort.
5. Repeat the short smoke on the deployed build. Watch publication failures,
   missing previews, stale-base conflicts, lost drafts, duplicate sends, and
   chat/frontend errors. Inspect existing logs without recording draft bodies,
   support content, or credentials as telemetry.
6. Keep an operator available during the release window. Any draft/data loss,
   wrong-thread submission, or access-control failure is a stop condition.

## Rollback

- For publication-policy problems, disable the opt-in on affected test threads
  and stop new invitations. In-flight turns may already have received their
  guidance; interrupt only the affected turn if necessary and authorized.
- For rendering or access problems, the checkbox is insufficient. Use the
  tested compatible frontend/runtime rollback, following the existing release
  procedure. Preserve stored chat/artifact data for investigation/recovery.
- Never delete artifact rows, rewrite chat files, or restore an entire live
  chat over newer user messages merely to hide a failed rollout.
- Handle suspected vulnerabilities privately under `SECURITY.md`; do not add
  reproduction details to the public PR or this tracked release document.

## Reproducing Deterministic Checks

Use an installed/built workspace. In a fresh worktree follow AGENTS.md first:
install dependencies and build referenced packages before interpreting Jest
module-resolution failures. From `src/packages/frontend`:

```sh
pnpm exec tsc --build
pnpm exec jest --runInBand --silent --testPathPatterns='(chat/__tests__/(artifact|readonly-artifact|contextual-reply|open-artifact|codex-workbench|acp-api|codex-button-sync|send-chat-ids)|frame-editors/chat-editor/.*(artifact|workbench).*test)'
```

From `src/packages/chat`: `pnpm exec jest --runInBand --testPathPatterns=artifact`.
From `src/packages/ai`: `pnpm exec jest --runInBand acp/__tests__/codex-app-server.test.ts`.
From `src/packages/lite`: `pnpm exec jest --runInBand hub/acp/__tests__/runtime-env.test.ts`.
From `src/packages/cli`:

```sh
pnpm exec tsc -p tsconfig.test.json
node --test build/test/cli/src/bin/core/artifact-publication.test.js build/test/cli/src/bin/core/project-chat.test.js build/test/cli/src/bin/commands/project/chat-publish.test.js
```

From the repository root: `pnpm -C src lint:frontend` and
`pnpm -C src/packages/static build:dev`. Do not run multiple heavy builds at once.
Use `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js"` for runtime CLI checks;
refresh the matching hub/Lite environment first and never print auth variables.
