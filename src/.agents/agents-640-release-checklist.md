# Agents workspace #640 release checklist

Updated: 2026-09-21. Status: release preparation; not merged or deployed to production.

## Scope and source

- [x] Freeze feature scope: existing Agents workspace, messaging, artifacts,
      search, and conversation lifecycle. Only release fixes from here.
- [x] Create separate planning PR #668 for Jupyter artifact integration, stacked
      on #640 with a documentation-only diff.
- [x] Push locally validated workspace/search commits through `6ec2eff3e5`.
- [x] Merge current main (`46f0483a30`) without conflicts: `98fd3dae09`.
      Full development build and static/typecheck pass on the merged tree;
      remaining release checks below still apply.
- [ ] Pin the final candidate commit and obtain passing CI on that exact head.

## Release checks

- [x] Resolve or explicitly disposition previous CI failures; do not dismiss
      repeated failures as flakes without evidence.
- [x] Full development build, typecheck, frontend lint, dependency consistency,
      and dependency declarations pass on the reconciled tree.
- [ ] Focused messaging/authorization, identity lifecycle, schema ownership,
      search, navigation, notification, and artifact regression suites pass.
- [ ] Confirm prior independent security approval still covers authority paths;
      route any new findings through SECURITY.md, not public release notes.
- [ ] Exercise schema upgrade from the previous deployed version on an isolated
      database; verify supported rollback and mixed-version behavior.
- [ ] Run Lite and hub-backed acceptance: create/name/copy/remove/re-register,
      quota recovery, send/queue/interrupt, fresh conversation/history, message
      links, search, notifications, files/artifacts, and project/account drawers.
- [ ] Verify reconnect/reload, unavailable hosts, cross-project messaging,
      denied/revoked authority, and evidence of actual saved delivery.
- [ ] Check keyboard/focus, narrow viewport, 200% zoom, light/dark, and reduced
      motion on changed application-shell and drawer flows.
- [ ] Record final build/runtime versions and acceptance evidence, not just
      successful unit tests or agent summaries.

## Merge and rollout

- [ ] Update #640 description and release notes to current terminology and scope.
- [ ] Review the final diff, resolve required checks/reviews, and mark ready.
- [ ] Merge #640 only after release gates pass; do not bypass failed checks.
- [ ] Retarget #668 and coordinate the connector/harness stacked PRs after merge.
- [ ] Identify the actual previous production build and preserve rollback artifacts.
- [ ] Confirm operator authentication and stage the deployment using existing
      production tooling; do not infer production health from local dev hosts.
- [ ] Deploy a limited first cohort; verify frontend, hub, project-host and tools
      compatibility before expanding availability.
- [ ] Monitor routing/auth failures, RPC latency/outcomes, search coverage,
      artifact failures, and unexpected resource usage. Document rollback triggers.
- [ ] Verify production smoke tests and record the deployed version.

## Current evidence

- Historical CI run `35562316016` failed checks and several test shards.
  Repaired stale navigation/notification expectations and test mocks, removed an
  undeclared test-only import, and added the fresh-conversation RPC decision and
  account-home network member reference declaration. No authorization behavior
  was relaxed.
- Six previously failing frontend suites: 197 tests passed. Full frontend agents
  directory: 36 suites, 138 tests passed. Server agent suites: 14 passed, 105 tests
  passed, one suite/two tests skipped. Conat agent suites: 10 suites, 99 tests
  passed; API-transform/runtime-event suites also passed (42 tests).
- Speech and dangerous-RPC suites: 19 tests passed using the merged package's
  PGlite script. Main already supplies the required ESM test flag.
- Three agent schema suites: five tests passed. Fresh/repeated schema sync is
  not a substitute for the deployed-version migration/rollback gate above.
- Full `build:dev`, `static` (including workspace typecheck), frontend lint,
  dependency version checks, depcheck, and accessibility tooling tests passed.
  Static emitted two bundle-size warnings, not build failures.
- Main CI run `35624839847` independently reproduced the funding
  schema-ownership failure: `financial_approval_identities` and
  `financial_approval_sessions` have both canonical schema declarations and
  runtime CREATE TABLE bootstraps in `server/compute/funding/approvals.ts`.
  Follow-up removes duplicate initialization from both the approval service and
  account directory, relying on canonical schema sync. The unchanged ownership
  audit passes; new fresh/legacy schema migration tests preserve session rows,
  revocation, and null identity-verification fields. The legacy exception list
  was not expanded.
- That main CI run also failed two VM documentation anchors after power controls
  were extracted. The anchors now point at `compute-vm-power-controls.tsx`;
  documentation verification passes without changing the visible labels.
- Local logs for this preparation are `/tmp/agents-release-*.log`; CI on the
  pushed candidate remains authoritative for the full test matrix.
- Candidate CI run `35631647914` passed build, checks, both server shards and
  backend/database. Frontend failed on a mock of the removed messaging preference;
  the VM form integration test also exceeded five seconds but passed on retry.
  Removed the stale mock, gave the real two-form test an explicit 15-second bound,
  and moved mock cleanup to `afterEach`. Both focused frontend tests pass.
  The rest lane failed only on the schema audit resolved above. Follow-up local
  logs are `/tmp/ci-fix-*.log`; a new exact-head CI run is still required.
- Jupyter PR: https://github.com/sagemathinc/cocalc-ai/pull/668.
- Production has not been changed by this release-preparation work.
