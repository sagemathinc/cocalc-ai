# API-first connector: revised current PR scope

Approved direction: separate distributed read admission into a draft follow-up.
This document supersedes the cross-instance read/download concurrency requirement
in the September 24 plan for this PR. It does not declare phases 1-4 complete.

## Architectural boundary

1. Ordinary account-owned scoped API keys define account capabilities and
   project-specific full-runtime or viewer grants.
2. The ordinary CLI uses those keys through existing API routing. Account homes
   own key authority; project/host ownership determines routing. Data stays on
   the project-host data plane.
3. Manual API-key settings and the CoCalc connector share the permission editor.
4. The connector only supplies consent/configuration, trusted temporary-key
   issuance/renewal/revocation, and standard CLI credential delivery.

Keep the independently reviewed transport, inbox isolation, revocation,
credential-provider, viewer-policy, HTTP expiry, and project-list admission
fixes. They are requirements of this access path, not a new resource scheduler.

## Exact split

- Boundary: `7e76c72c8880520a69eda4f2aafe802724502813`.
- Move the 19 commits from `c9ad07533b` through `4d9e53163b` to
  `followup/distributed-read-admission`, stacked on the current branch.
- Preserve the independent lifecycle test correction originally committed as
  `31ae5e5a21`; it waits for observed revocation instead of polling event-loop
  turns while filesystem cleanup remains pending.
- Backup: `backup/api-first-before-read-split-20260927` preserves the original
  tip. No discarded work, deployment, database rollback, or runtime cleanup is
  implied by changing source branches.

The follow-up owns account/key active-read reservations, completion receipts,
clock watermarks for those receipts, host journals, worker incarnations,
supervisor retirement, recovery, descriptor admission coordination, and its
local canonicalization preflight guard. These were internal and not wired into
the production file service. The entire sequence, including its cancellation
primitive, moves together.

Current scope retains existing finite request/response limits, including the
viewer read's 8 MiB maximum and bounded project-summary pages/search admission.
It does NOT promise a cluster-wide 4-read/key or 32-read/account ceiling, nor
that per-response byte bounds are a global memory/metadata-I/O concurrency cap.
Exact read/download fairness across hosts, durable crash accounting, and
general archive/search/preview resource isolation belong to the follow-up.

## Remaining work: finite acceptance checklist

Prior tests and live reports remain evidence only for their recorded commits
and environments. Close these items against the narrowed candidate, recording
pass, failure, or explicitly unsupported behavior rather than adding services.

1. **Validate the split.** Verify no current source references the removed
   subsystem; rebuild affected TypeScript packages and rerun focused viewer,
   connector lifecycle, routing, and scope tests. Check the follow-up diff
   contains only the deferred sequence. Full rebuild/deploy remains a separate
   operator step; stale generated output must not stand in for current source.
2. **Manual CLI/API acceptance.** With disposable keys/projects, test list-only;
   B full-runtime / C directory-viewer / D absent; exact-ID access without list
   scope; all-projects defaults and explicit overrides. Exercise file list/read/
   write/exec, terminal, Jupyter, synchronized editing, and advertised app proxy
   access. Verify denials via raw API as well as CLI. Unsupported viewer routes
   must deny, not gain a new implementation in this PR.
3. **Managed replay of the same operations.** Use a real native agent turn and
   installed CLI, not only lifecycle mocks. Verify the scoped provider is
   selected for account/other-project work, current-project access remains
   unchanged, and missing/invalid providers do not fall back to broader auth.
   Verify completion, error/cancel, source membership loss, disconnect/reduction,
   renewal over a long turn, process reuse, and crash expiry. The reported delta
   project-list failure must have an explicit successful end-to-end retest.
4. **Authorization under change.** Check established credential-backed sessions
   lose authority within the documented bound after deletion, scope narrowing,
   expiry, or membership loss. Test account-home outage/stale directory and
   active placement change across the available test bays, including old
   subscriptions/RPC interest. Detached processes may survive; old credentials
   must not reattach. Automatic replay or seamless recovery of every client
   family is not an acceptance requirement: explicit interruption and a fresh
   authorized reconnect are acceptable; replaying uncertain mutations is not.
5. **Shared UI and first approval operation.** Verify manual-key and connector
   scope round trips, source-project exclusion, all-projects controls, connector
   entry/help drawer, and revoke/disconnect. Finish real interactive fresh-auth
   and stale-review tests for the existing manual-key revocation-request flow.
   Finish native 200% zoom/focus checks; retain existing theme/mobile/keyboard
   evidence with its stated limits. No additional management families are due.
6. **Release hygiene and pinned review.** Record actual finite limits and
   unsupported routes; check credential redaction on error paths; exercise
   existing-schema upgrade/legacy keys; document DB/hub/host/CLI/frontend order
   and disable/revoke rollback. Obtain final review on the narrowed commit and
   consolidate the above evidence. A review PASS is not deployment acceptance.

Fix reproducible failures within these paths. Stop and seek a separate scope
decision if a fix needs a new distributed subsystem or new operation family.
Issue #713, general workflow/approval expansion, universal automatic transport
recovery, and distributed read admission are not current-PR requirements.

## Current evidence and environment limitation

Before the split, recent focused checks passed: 31 server connector lifecycle/
configuration tests, 7 CLI credential-provider tests, 41 host lifecycle tests,
15 shared-editor tests, frontend lint, and relevant builds. These are not new
post-split or live results. See the existing live-validation report for earlier
positive and failed probes; its historical outstanding notes are not all new
implementation requirements.

The last live attempt could not connect to the local hub on port 9100, and
browser discovery timed out waiting for info. No service was restarted or
deployed. Live acceptance requires an available test stack; it cannot be
replaced by repeated unit-test runs.
