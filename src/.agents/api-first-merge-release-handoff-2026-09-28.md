# API-first connector: merge and release handoff

Private maintainer handoff, checked 2026-09-28. Do not copy this document or
the private implementation history into a public PR before coordinated release.

## Status and release decision

The implementation is pushed to
[private PR #2](https://github.com/sagemathinc/cocalc-ai-private/pull/2), branch
`security/api-key-conat-directory`. Runtime/UI candidate:
`6d113a4c86e5d6f0a51d3834baee06404ff5adaa`. Subsequent handoff-only commits do not
change that tested implementation.

**Release hold:** two already-written private advisory fixes are absent from
this candidate. Integrate them privately, resolve conflicts against the current
implementation, and validate/review the combined candidate before production
promotion or public disclosure. This is a concrete prerequisite, not a request
to build a new security subsystem.

At inspection, both `origin/main` and `private/main` were
`fab56c7e204a99f72f73ef64b4c49b509ec60f95`; the implementation contained that base
and was 191 commits ahead, zero behind. Re-fetch and repeat the ancestry check
when preparing the release; do not assume the public base will stay unchanged.

## Branch and advisory map

| Location                                    | Branch / commit                                                                  | Disposition                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `sagemathinc/cocalc-ai-private`, PR #2      | `security/api-key-conat-directory`, `6d113a4c86`                                 | Current implementation; release integration starts here.                           |
| `sagemathinc/cocalc-ai-private`, PR #1      | `followup/distributed-read-admission`, `dd984f6985`                              | Deferred draft, stacked on #2. Do not merge for this release.                      |
| `sagemathinc/cocalc-ai`, PR #696            | `docs/cocalc-api-first-plan`, `506f232b91`                                       | Public design document only. Merging it does not ship implementation.              |
| `sagemathinc/cocalc-ai-ghsa-f85x-95gm-px66` | `security/agent-project-token-scope`, `c2240f74553c095d3329ed5f553af089d24b3488` | Required private prerequisite, not integrated.                                     |
| `sagemathinc/cocalc-ai-ghsa-qphc-qx6c-72r9` | `security/api-key-project-address`, `e6fb6cef335010c0bac89a1580e8a8efd98a47e9`   | Required private prerequisite, not integrated.                                     |
| `sagemathinc/cocalc-ai-ghsa-8xm5-h89c-5m2q` | `security/api-key-conat-directory`, `7921b0f0ec`                                 | Older advisory-fork copy, already an ancestor of #2. Not the current release head. |

All three named advisories are still draft. The first prerequisite supplies the
agent source-project binding; the second removes the secret-bearing project
address RPC from the API-key allowlist. Both fail ancestry and patch-equivalence
checks against the candidate, and inspection confirms their changes are absent.
Do not mark either advisory fixed merely because #2 has passing tests.

Other historical copies (`feature/api-first-cocalc-connector`,
`feature/agent-cross-project-cli`, `feature/agent-account-project-list`, and
`backup/api-first-before-read-split-20260927`) are not additional merge targets.
The backup includes the deferred read work. No branch should be blanket-merged
just because its name starts with `security/` or `feature/`.

## Merge manager steps

1. Fetch public main and private PR #2 into a private integration checkout.
2. Integrate the two prerequisite commits above from their advisory forks.
   Adapt conflicts and tests to the current API, including asynchronous policy
   checks. Keep the fixes private and coordinate with the advisory owners.
3. Integrate any newer public main commits, preserving the scoped credential
   provider/no-broader-fallback behavior. Do not include private PR #1.
4. Pin the combined SHA, rerun the affected auth/host/CLI/frontend checks, and
   obtain final review against that SHA. Earlier pinned review passes are not a
   review of this new combined release.
5. Build and deploy the pinned candidate to the canary, perform the acceptance
   checks below, then make the production/public-disclosure decision. Keep #2
   draft until the actual release candidate satisfies these gates.

The private repository shares Git ancestry with the public repository, so its
approved integration ref can be fetched and merged into public main with normal
Git. It does not need to be a GitHub fork. Do not push that history publicly
until the coordinated security release permits it. Preserve the relationship
between the integrated SHA, private review, and deployed artifact IDs.

## Scope and evidence

This release is ordinary scoped API keys and CLI access, the shared permission
editor, and the managed connector's consent/temporary-credential lifecycle.
The composer has **+ > CoCalc** and **+ > Agent Networks**, compact indicators,
and confirmed CoCalc removal distinct from disabling. Permissions remain
agent-wide. No new account-management families are included.

Distributed read admission, journals, worker recovery, and exact cluster-wide
read concurrency limits remain in private PR #1. Account profile/membership and
project-start commands denied to the agent principal are known unsupported
surfaces, not promises to expand permissions before release. Connector tables
are account-home owned but marked nonportable in the ownership schema; do not
claim account rehome with connector state is supported by this release.

- `6d113a4c86`: 121 focused tests passed (36 frontend, 32 server, 53 Conat),
  affected TypeScript builds, frontend lint, and full `pnpm -C src build:dev`.
- lite2b serves frontend Git revision `6d113a4c86`, built at
  `2026-09-28T05:05:32.636Z`. The three local hub/bay services were restarted
  with that checkout. This last UI/removal rollout did not upgrade project
  hosts, project containers, or installed CLI tools.
- Earlier installed-tools validation at `b814f0f569` passed both 45-second
  blocking and `--async --wait` executions with one execution marker each.
  The installed CLI embeds its build Git SHA in `--version`; verify the actual
  executable inside the agent source project, not just a checkout's CLI.
- The user reported successful native-agent project creation and a Python
  kernel installation/execution on lite2b. That is human dev-site evidence,
  not complete production acceptance.
- Our latest browser probe still stopped at **Loading full conversation** on
  Delta, before the composer. Live removal/confirmation/visual checks are not
  claimed; keyboard, cancellation, deletion, focus restoration, and revocation
  rollback have focused test coverage. Delta's saved settings were not changed.

Historical evidence and its limitations are in
[the validation log](api-first-live-validation-2026-09-26.md). The
[scope document](api-first-current-pr-scope-2026-09-27.md) defines the narrowed
boundary; its older environment status is not the current deployment status.

## Release directions

1. **Build once from the reviewed private integration SHA.** Start with
   `pnpm -C src build:dev` for canary validation. Build the runtime bundles with
   `pnpm -C src/packages/project-host build:bundle`,
   `pnpm -C src/packages/project build:bundle`, and
   `pnpm -C src/packages/project build:tools`. Use the site's normal production
   artifact pipeline for production; pin each artifact ID and source SHA.
2. **Database and account homes first.** Back up and use the normal hub schema
   upgrade path on every bay database. Include connector config/turn tables,
   API-key scope/revision and issuance fields, and account/key
   `api_search_next_ms`. API-key and search helpers also contain idempotent
   ensure-DDL; provision ahead of traffic where practical. Preserve existing
   key revisions and admission debt. The latest removal change needs no new
   schema beyond the existing connector tables.
3. **Control plane before clients.** Roll all account-home receivers and hub/bay
   authorization/HTTP services to the reviewed version before enabling the new
   connector UI. Mixed versions are not qualified: an older account-home reader
   can ignore per-key admission metadata, and older mutation handlers do not
   understand removal/configuration identity checks. Confirm the separate
   advisory changes are included in the rollout, not merely in source control.
4. **Align the host runtime.** Canary project-host plus conat-router,
   conat-persist and acp-worker together. Use the existing software deployment
   system or `host upgrade --artifact project-host --align-runtime-stack` with
   an explicit published artifact/version and approved site profile. Ordinary
   project-host installation alone does not replace all managed components.
   Inspect actual running component versions and LRO completion; a timeout or
   canceled waiter does not prove rollback. Do not submit duplicate upgrades to
   work around an unknown outcome.
5. **Project runtime and tools.** Deploy pinned project and tools artifacts.
   Confirm the mounted tools in already-running source projects: a host tools
   update can leave their old mount in place. Schedule a project restart only
   where needed to adopt runtime/tools, not to apply a secret update. Check
   `"/opt/cocalc/bin/node" "/opt/cocalc/bin2/cocalc-cli.js" --version` inside the
   source project and compare the embedded Git SHA to the intended tools build.
6. **Frontend last and canary acceptance.** Publish the matching static build;
   confirm `/static/frontend-build.json` and reload the browser. Verify + menu,
   logo, disable versus remove/re-add, fresh-auth cancellation, and Agent
   Networks. Use a disposable agent/config for actual removal. Exercise a real
   native agent turn: scoped project list, permitted read, denied viewer write
   and out-of-scope access, unchanged source-project access, and 45-second
   blocking plus async-wait execution with no duplicate submission. Confirm
   revocation stops new authority and bounded sessions. Record results against
   the installed versions before fleet promotion.

The installed CLI exposes `software build/push/deploy/history/rollback`,
canary-first rollout options, `host upgrade --align-runtime-stack`, and host
desired/observed version inspection. Use typed commands and the site's
browser-approved operator session; do not borrow an agent credential or copy
credentials into this handoff. No production deployment is authorized or
performed by this document.

## Rollback and remaining decisions

Pause new connector use, disable/remove affected configurations and revoke
their managed keys while the new backend is still available. Hiding the icon
alone is not revocation. Revocation does not stop already-started programs or
undo copied data. Inspect uncertain operations before retrying.

Rollback only to a security-approved artifact set; do not reintroduce the two
advisory issues to undo a UI/runtime regression. Keep the additive schema and
revocation/revision state. Verify both desired and observed host versions after
rollback, including containers still mounting old tools.

The release manager must resolve the two missing security prerequisites and
sign off the combined canary. Complete or explicitly record the outstanding
live browser check. No distributed scheduler, new permission family, or universal
transport-recovery redesign is required for this handoff.
