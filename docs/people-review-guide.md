# People replacement review

## Provenance and scope

Base: current main `4931c500e5ed28a600b49d8863d08a3871f36973`, including
TypeScript 7. Published PR #727 head:
`23a6821ff27e9330a370910cb9b634f9ec2a11b8`. Final source snapshot:
`20e28ea5a6b56b4c41af611fc03577d8a1095a6b`, which also includes the locally
completed sidebar, documentation drawer, project selection, host eligibility,
`fd` discovery, and incremental Scan fixes. This PR replaces the implementation
history; it does not change the existing developer checkout or deployment.

Read [the product contract](people-architecture.md) first. The preserved scope is
People discovery, existing human chat rooms, typed resource references, collection
and attention state, invitations, personal URLs, unified navigation, and explicit
manual Scan. Execution, permission and funding rules remain authoritative.

## Audit decisions

- Omit chronological agent plans, validation transcripts, and obsolete scan
  checklists. They remain available in #727 history. Replace package narratives
  that still described automatic/hourly scans with the supported contract.
- Remove the unused directory-stream scanner and sandbox capability, observation
  ledger, generic census checkpoint store, old inventory quarantine, and their
  prototype migration fixtures. Keep one `fd` discovery path.
- Initialize final host journal/census schemas directly. Remove development-only
  ALTER/backfill paths; retain supported restart, cancellation and recovery.
- Replace traversal-specific tests with filename-snapshot atomicity, invalid path,
  capacity, restart, stale completion, cancellation and report-retention tests.
  Retain authorization, notification, rehome, hard-delete, load fixtures and
  independent-process acceptance. Test volume is not removed for appearance.
- Preserve main's new composer sizing, controls, connector gating and collaborator
  search merging. Reapply only People reference insertion and multi-project
  invitation integration. Keep main's existing bundle budgets; measure additions.
- Keep standalone Lite and identity upgrades for existing user-authored `.chat`
  records. Neither is an abandoned prototype.
- Retain default-off gates and ambiguous-execution reservations. Removing these
  would create a smaller diff by weakening the supported contract.

## Review order

| Unit                          | Review focus                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Contracts and schema          | Identity, bounded payloads, shared attention rules, auth-first RPC surface, ownership fields.                           |
| Source extraction and storage | Durable supported writes, archived JSONL, complete relations, move/copy identity, deterministic skips.                  |
| Project-host integration      | Existing volume only, no compute startup, `fd` scope, lifecycle fences, incremental watermarks, exact cancellation.     |
| Owner/home catalog adapters   | Membership leases, projection demand/revisions, transaction boundaries, bounded queries, revocation.                    |
| Notifications and lifecycle   | Durable recipient intent, Follow/mention policy, deduplication, grouping, exact receipt cleanup, rehome and deletion.   |
| Invitations and personal URLs | Intent versus membership/delivery, encrypted private state, idempotency, current authority after link resolution.       |
| People views and shell        | Retained runtime state, route restoration, drawer documentation, virtual selection, honest scan status, keyboard/focus. |
| Lite and CLI                  | Shared domain semantics with local storage; typed human operations and no implicit agent authority.                     |

Each implementation unit includes its focused regressions. These are review
units of one integrated feature, not independently deployable releases. The new
history is assembled from the final source rather than replaying trial fixes.

## Commit review map

Review these in order; tests travel with their implementation. The hashes link to
the complete review unit rather than hundreds of chronological trial changes.

| Commit                                                                                                 | Scope                                                                        | Files | Added lines |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | ----: | ----------: |
| [107bf17684](https://github.com/sagemathinc/cocalc-ai/commit/107bf1768479364a621fc2a06008a602f0b40d7b) | define People identity, ownership and RPC contracts                          |    63 |       9,158 |
| [bace6e5ce8](https://github.com/sagemathinc/cocalc-ai/commit/bace6e5ce8133d02334095532abb654bd15f9d9a) | capture and extract current chat resources                                   |    86 |      14,263 |
| [256b510a62](https://github.com/sagemathinc/cocalc-ai/commit/256b510a625f8a615251a29bb05b2766f8d162df) | add owner and account-home catalog adapters                                  |    59 |      17,413 |
| [cf9fa36242](https://github.com/sagemathinc/cocalc-ai/commit/cf9fa36242a438c6154ea67a46bbb0d19db112ac) | integrate indexed storage without starting compute                           |    22 |       4,624 |
| [37e65ab013](https://github.com/sagemathinc/cocalc-ai/commit/37e65ab013a53cf145f38f8ba33e1cde34d62393) | route catalog demand and revision maintenance                                |    64 |      12,305 |
| [19e828a4f9](https://github.com/sagemathinc/cocalc-ai/commit/19e828a4f925283631154c7abc3a08b7ff941e85) | admit and reconcile explicit manual scans                                    |    20 |       4,394 |
| [53d845b93b](https://github.com/sagemathinc/cocalc-ai/commit/53d845b93b2fb61ebda6ab99a46abd5c27f60540) | deliver durable collaboration obligations                                    |    17 |       4,161 |
| [57cd5b8d2f](https://github.com/sagemathinc/cocalc-ai/commit/57cd5b8d2fdbab622d738f70b2fd0e538f61cfce) | preserve collaboration state through rehome and deletion                     |    28 |       6,174 |
| [906faf198e](https://github.com/sagemathinc/cocalc-ai/commit/906faf198ea7f0fa730d87c8e8d9e62669512d24) | add invitations, contacts and personal addresses                             |    42 |      10,610 |
| [d7ddb7b069](https://github.com/sagemathinc/cocalc-ai/commit/d7ddb7b06966777cda3a4d24c1768a8f73f19a9c) | implement the shared workspace contract locally                              |    45 |      12,480 |
| [cc2f40002b](https://github.com/sagemathinc/cocalc-ai/commit/cc2f40002b4c794aad583850aaadfde4354ab1cb) | share virtual collections and project selection                              |    12 |       1,063 |
| [679f8bb7cb](https://github.com/sagemathinc/cocalc-ai/commit/679f8bb7cb73ff93416b6d6f4b8629edd4e4c977) | add retained conversations and resource discovery                            |    65 |      13,943 |
| [6bc9091c7d](https://github.com/sagemathinc/cocalc-ai/commit/6bc9091c7d33e711be28ba91c604557a3fb66e64) | expose invitations and manual Scan                                           |    32 |       7,353 |
| [c1cf29e4f2](https://github.com/sagemathinc/cocalc-ai/commit/c1cf29e4f254efe487ea3d170a8e5c2ae27008a3) | render and share typed resource references                                   |    78 |       6,487 |
| [e12777bd02](https://github.com/sagemathinc/cocalc-ai/commit/e12777bd0215e94e8ad2301ce138302753ed02ff) | retain Projects, People and Artifacts in one shell                           |   110 |       7,868 |
| [cc2f4bcb96](https://github.com/sagemathinc/cocalc-ai/commit/cc2f4bcb9691b8d5a153d59560edb8491aa34747) | expose typed chat, scan and address operations                               |    22 |       2,658 |
| Final documentation commit                                                                             | Product contract, audit guide, docs drawer content and browser audit helpers |    13 |           — |

## Merge and enablement gates

The feature remains draft and default-off. Existing functional tests do not close:

1. Owner-side project/actor notification admission, weighted fanout before queue
   expansion, tighter `@all` rate limits, and sustained-load fairness. Home grouping
   alone does not bound owner or routed work for many actual followers.
2. Aggregate Scan campaign bounds: reduce routed preflight and batch scope, bound
   account-wide active children and rolling work, and establish bay/host admission.
   Retained unknown executions must continue consuming reservations until recovery.
3. Independent re-review of hard-delete receipt reclamation and competing-worker
   cleanup leases, plus controlled multi-account/multibay release validation.

4. Restore signed-in startup route and ultralite notification size budgets. The
   production build and module import guards pass; measured size budgets do not.
   Keep the current limits instead of silently raising them.

Do not enable for customers or claim these gates passed merely because this PR
builds. Prior development timings are not benchmarks of this replacement.

## Validation approach

Build workspace references in the fresh worktree before testing. Run package
TypeScript builds, frontend lint, shared contract/extraction suites, database
catalog suites, server PGlite/notification/rehome/Scan suites, host discovery and
lifecycle suites, Lite suites, CLI tests, and frontend keyboard/navigation tests.
For PGlite-backed server tests use `COCALC_TEST_USE_PGLITE=1` and
`NODE_OPTIONS=--experimental-vm-modules`; otherwise some suites skip silently.
Run the full development build for release preparation. Record actual new-branch
results and unverified live scenarios in the PR description.

## New-branch validation results

- TypeScript 7 builds for backend, frontend, server, project-host, Lite and CLI
  passed. Static development and measured production builds passed.
- Frontend lint: no errors or warnings. Isolated Scan keyboard/focus/axe audit
  passed in light/dark themes, at 100%/200% zoom and 320 CSS pixels.
- Backend: 256 passed, 3 opt-in skips. Host: 104 passed. Lite: 185 passed.
- Changed frontend suites: 1,379 tests; the stale alias assertion was corrected
  and its focused rerun passed. Route helper regressions also passed.
- Changed server suites: 750 passed after correcting stale demand scheduling
  and account-home receipt fixture assumptions; 62 opt-in tests not run.
- Database catalog: 184 passed. Shared utilities: 2,209 passed after adding the
  missing secondary ownership note. Conat API: 120 passed. CLI: 84 passed.
  Chat extraction: 46 passed; chat-client: 14 passed; archive store: 4 passed.
- Production module guards pass. Signed-in startup size budgets and the ultralite
  notification budget remain failing; see the PR for measured values.
- Independent-process PostgreSQL acceptance, full development build completion,
  deployment/browser validation and sustained-load release approval are not
  claimed. Original development deployment remains untouched.
