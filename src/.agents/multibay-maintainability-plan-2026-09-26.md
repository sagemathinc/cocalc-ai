# Multibay Maintainability and Inter-Bay Extraction Plan

Date: 2026-09-26

Status: proposal only. This PR changes no runtime code, configuration, database
schema, or deployment. Implementation requires separate, focused PRs.

## Decision and Goal

Keep the multibay architecture. Its primary purpose is horizontal control-plane
scalability and useful data locality, not high availability. Availability within
a bay and the availability of seed/global services remain separate operational
concerns. Production can remain one bay while we improve the implementation and
continuously exercise the multibay paths.

The primary engineering goal is to make it easy for Codex and human contributors
to implement a feature correctly without rediscovering the multibay architecture.
The secondary goal is to make the resulting changes easy for a maintainer to
review. Fewer lines are useful only when they reduce duplication or make authority
and behavior clearer; hiding decisions inside a large framework is not progress.

Start with small, behavior-preserving extractions before expanding production to
multiple bays. Do not combine those extractions with correctness fixes, protocol
redesign, or new infrastructure.

### Success Looks Like

- A contributor can find a domain's contract, routing entrypoint, owner-local
  implementation, authorization boundary, and focused tests from one short index.
- A normal change to an extracted domain does not require editing the giant
  inter-bay files or studying unrelated domains.
- Local and remote calls have an obvious path to the same domain implementation;
  important authorization checks remain explicit and testable.
- Reviewers can distinguish mechanical moves from policy or behavioral changes.
- One-bay and multibay behavior remain covered by repeatable checks; passing the
  one-bay case alone is not evidence of multibay correctness.

## Current Baseline

Inspected public baseline: `4d07eba3ba489ab3de2b94cec000b4f0b542b14b`
on `origin/main`. Counts below are a dated inventory, not file-size targets.

| Location                                                                               | Size / responsibility                                                | First improvement                                                         |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [server/inter-bay/service.ts](../packages/server/inter-bay/service.ts)                 | 3,547 lines; registration plus cross-domain adapters and some policy | Extract domain registration modules; retain startup ordering              |
| [conat/inter-bay/api.ts](../packages/conat/inter-bay/api.ts)                           | 13,573 lines; contracts, subjects, clients, and handlers             | Extract cohesive domain transport modules; retain compatibility exports   |
| [server/inter-bay/accounts.ts](../packages/server/inter-bay/accounts.ts)               | 1,143 lines; account-related routing                                 | Document supported entrypoints before considering smaller domain splits   |
| [server/inter-bay/project-control.ts](../packages/server/inter-bay/project-control.ts) | 979 lines; owner-side project operations                             | Keep authority checks visible; do not redesign while extracting transport |

`startAccountLocalService` alone is about 1,000 lines. Extracting that whole block
into another 1,000-line file is only an intermediate move, not the desired finish.
The contract/client/handler repetition in `api.ts` is at least as important as the
size of the server registration file.

Existing building blocks to reuse:

- [Agent identity transport](../packages/conat/inter-bay/agent-identities.ts)
  demonstrates a small domain-specific contract, client, and handler module.
- [Agent identity routing](../packages/server/agents/identity-routing.ts)
  demonstrates a named owner-routing boundary rather than scattered local/remote
  branching at every caller.
- [Billing authority](../packages/server/purchases/billing-authority/inter-bay.ts)
  already has a distinct domain transport. Do not fold it into a generic account
  service or change its authority as part of this work.
- [Table ownership](../packages/util/db-schema/table-ownership.ts) and its
  [coverage tests](../packages/util/db-schema/table-ownership.test.ts) already
  classify durable state. Extend these mechanisms rather than creating another
  independent ownership registry.

This inventory identifies maintenance work, not a claim that any particular
operation is broken or that all failure modes have been audited.

## Invariants and Non-Goals

The [scalable architecture](./scalable-architecture.md) remains authoritative.
Account state routes by `home_bay_id`, project state by `owning_bay_id`, and host
state by `bay_id`. Seed-global and other ownership classes follow the existing
table ownership manifest. The acting account is not necessarily the account
whose data is authoritative, and a project's owner bay is not necessarily its
host's bay. Source and destination projects may also have different owners.

- Keep Launchpad as the one-bay case, not a second implementation of business
  rules. Do not add single-bay shortcuts that bypass established checks.
- Keep ordinary project data traffic direct to project hosts. Do not introduce
  hub proxying to simplify routing; preserve documented exceptions only.
- Preserve subject strings, service/method names, request/response shapes,
  serialization, errors, and existing versioning exactly during extraction.
- Preserve authenticated actor/delegation context, fresh-auth requirements,
  scoped credentials, owner checks, and Conat subject authorization. Moving a
  handler must neither broaden its callers nor trust caller-supplied authority.
- Preserve transport selection, timeout overrides, concurrency/admission limits,
  cache scope, and retry behavior, including unknown outcomes after timeouts.
- Preserve initialization order, singleton lifetime, shutdown behavior, and
  import-time side effects. Moving imports can change behavior even when function
  bodies are unchanged.
- Keep existing import paths usable through explicit re-exports. Do not require
  a coordinated all-bays upgrade for a file move.
- Do not migrate databases, change placement/rehome semantics, replace the
  ownership directory, add a generic RPC framework, or introduce automatic
  retries/rebalancing in extraction PRs.

If characterization exposes a bug, report it and handle it in a distinct fix PR;
do not silently preserve it as a desired contract or bury its fix in a move.
Suspected vulnerabilities affecting deployed code follow [SECURITY.md](../../SECURITY.md),
not a public extraction PR or a public list of exploit details.

## Intended Module Boundaries

The intended flow is:

```text
authenticated public entrypoint
  -> domain routing entrypoint: resolve the authoritative owner
  -> local call OR typed inter-bay client
  -> owner-side domain implementation and authorization
  -> authoritative database / existing project-host control layer
```

Entrypoint checks and owner-side checks may both be required. This diagram does
not authorize removing either, nor resolving sensitive resources before the
existing permission checks. Cross-owner workflows remain explicit orchestration,
not functions that pretend all participating data is local.

Proposed organization for extracted code:

| Layer                      | Location / responsibility                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Domain wire contract       | `conat/inter-bay/<domain>.ts`: request types, existing subject builders, typed clients and handlers                        |
| Domain registration        | `server/inter-bay/services/<domain>.ts`: bind transport to the existing implementation and return service handles          |
| Startup composition        | `server/inter-bay/service.ts`: initialize registrations in the existing order and manage their existing lifecycle          |
| Routing and business logic | Existing `server/<domain>/...` and owner-side modules; publish clear supported entrypoints rather than mass-renaming files |
| Compatibility              | `conat/inter-bay/api.ts`: explicit re-exports for migrated symbols, plus unextracted code during transition                |

The `services/` layout is proposed, not already implemented. Match each boundary
to a cohesive operation family rather than enforcing one file per method or an
arbitrary maximum line count. New leaf transport modules must not import back
through the compatibility barrel; avoid circular runtime dependencies and use
`import type` for type-only edges.

Keep transport helpers small and mechanical. A helper may remove repeated typed
registration syntax after its need is demonstrated. It must not infer authority,
authorization, retries, or timeout policy from reflection, ambient state, or
untyped method-name strings. Do not replace existing per-method subjects with a
new shared subject merely because newer modules use that pattern.

## Implementation Sequence

Each numbered item is a mergeable PR or a series of explicitly separate domain
PRs. Land the pilot before copying its structure widely. Do not run simultaneous
edits against the same giant files just to accelerate extraction.

### 1. Pilot Characterization and Navigation

- Add narrowly scoped characterization tests for project reference/details
  clients and handlers, chosen as a small read-only pilot. Read-only still
  requires authorization tests.
- Extend existing transport test conventions to pin subjects, method envelopes,
  result/error propagation, timeout behavior, and registration options.
- Add a short `server/inter-bay/README.md` index mapping the pilot's public
  entrypoint, routing, contract, implementation, and tests. Link it from the
  contributor guidance in a small follow-up if appropriate.

Acceptance: the tests pass against the pre-extraction implementation, and the PR
does not alter runtime behavior. Avoid a snapshot of all 13,000 lines; assert the
observable contract of the operations being moved.

### 2. Extract Project Reference/Details End to End

- Move the pilot's contract, subjects, client, and handler code to domain files.
- Move its server registrations into a small service module, retaining the
  existing owner-local implementation and permission checks.
- Re-export old symbols explicitly and update only the imports needed for the
  extraction. Include an old-import/new-import compatibility test.
- Update the index with the actual paths and validation commands.

Acceptance: one cohesive domain extraction, no wire or policy changes, unchanged
registration coverage, focused tests/typechecks passing, and an isolated
local-owner/remote-owner smoke check. Review both the ordinary diff and moved-code
view; list any non-move edits individually.

### 3. Repeat for Small Domain Families

Use separate PRs for directory transport, account project/notification feeds,
and project control families. Split lifecycle mutations from read-only control
operations if a proposed diff becomes difficult to review.

Only move directory transport/registration in its extraction: do not change the
sequential fallback, caching, or error semantics. Only move feed transport in its
extraction: do not change durability, ordering, or reconciliation behavior.
Keep project-control owner checks and runtime admission policy in their existing
domain implementation until a separately justified cleanup.

Acceptance: each PR repeats the pilot gates and adds tests for that domain's
distinctive behavior, such as forwarded LRO progress or feed serialization.

### 4. Decompose Account and Host Aggregations

This is a series, not one PR. Suggested account slices are authentication/session
operations, membership/license operations, legacy migration, and the existing
compute/funding adapters. Keep billing authority separate. Suggested host slices
are connection lookup, lifecycle/control, and token issuance. Bay operations and
registry registration get their own extractions.

Use typed sub-implementations to compose the existing aggregate interfaces while
consumers migrate. Preserve special dispatch or startup order explicitly; do not
rely on object spread where duplicate method names could silently replace a
handler. Auth, billing, secrets, and token slices need a focused security review
even when the intended change is mechanical.

Acceptance: each slice can be reviewed without understanding every other account
or host operation. New feature work in an extracted domain stays in that domain.
The startup file is only composition/lifecycle code for extracted services, and
the old API file increasingly becomes a compatibility facade, not a new home for
unrelated methods.

### 5. Make the Pattern Easy to Follow

After successful extractions, add a concise "add or change an operation" recipe
to the index. Maintain one canonical worked example and its executable tests,
not copied examples that drift independently.

The recipe should direct Codex to:

1. Identify the durable state owner using the table ownership manifest; name all
   owners for cross-account/project/host workflows.
2. Find the domain's supported routing entrypoint and existing owner-local
   implementation. Do not infer ownership from the current hub or actor alone.
3. Extend the domain contract and adapters while preserving compatibility, then
   implement policy in the owner-side domain layer, not the startup registry.
4. Preserve actor and scoped authorization context on both paths. Test that a
   remote path does not bypass checks enforced locally.
5. Add local/remote and denial cases to colocated tests; record retry and delivery
   semantics rather than adding a blanket retry loop.
6. Run the listed focused checks and update the index if the boundary changes.

Add narrow dependency/registration checks where useful: domain transport modules
must not import their compatibility barrel, migrated exports must remain usable,
and migrated methods must retain handler coverage. Prefer compile-time typing and
small tests to a new code generator or framework. A cross-cutting operation may
legitimately need extra modules; document why rather than forcing a file-count
rule.

Acceptance: a representative small operation can be changed using the index and
one domain's files/tests without modifying the giant aggregators. Record what
still required whole-repository searching and improve the navigation accordingly.

## Validation and Review Gates

For this plan-only PR: Markdown formatting, link/path checks, `git diff --check`,
and confirmation that the diff contains only this plan. Runtime tests are not
required for a document-only change.

For implementation PRs, begin with existing coverage:

- [Conat transport tests](../packages/conat/inter-bay/api.test.ts) and
  [agent identity transport tests](../packages/conat/inter-bay/agent-identities.test.ts).
- [Fabric routing](../packages/server/inter-bay/fabric-routing.test.ts),
  [bridge](../packages/server/inter-bay/bridge.test.ts), and
  [directory](../packages/server/inter-bay/directory.test.ts) tests.
- [Project start policy](../packages/server/inter-bay/project-control.start-policy.test.ts),
  [LRO forwarding](../packages/server/inter-bay/start-lro-forward.test.ts), and
  [remote feed application](../packages/server/account/project-feed.remote.test.ts).

Run affected package builds/typechecks and the moved domain's tests, including
existing callers through compatibility imports. In a fresh worktree, install
dependencies and build referenced packages before running Jest, as described in
[AGENTS.md](../../AGENTS.md). Do not treat missing workspace build outputs as
application regressions. Use disposable test databases for database-backed tests.

Examples from the repository root after that preparation:

```sh
pnpm -C src/packages/conat build
pnpm -C src/packages/server build
pnpm -C src/packages/conat test --runInBand inter-bay/api.test.ts inter-bay/agent-identities.test.ts
pnpm -C src/packages/server test:pglite --runInBand inter-bay/bridge.test.ts inter-bay/directory.test.ts inter-bay/fabric-routing.test.ts
```

These are a baseline, not the complete suite for every slice. Record the exact
commands and results in each PR, including existing failures and any checks not
run. Run the supported PostgreSQL tests as well when the changed domain depends
on real PostgreSQL transaction/locking behavior.

Every extraction PR should answer:

- Which symbols moved from which files, and what remains in the old locations?
- Which owner and authorization checks govern these operations?
- What, if anything, changed beyond moves, imports, and compatibility exports?
- Which tests pin the old contract and exercise local and remote dispatch?
- Is mixed-version operation unchanged, and can the code-only PR be reverted
  without database/configuration changes?

Keep method/subject assertions independent of the builders under test so the
same accidental change on both sides cannot make a compatibility test pass.
Preserve denied and unavailable outcomes, not just successful requests. Keep
baseline client/handler contract fixtures to check old-client/new-handler and
new-client/old-handler compatibility for extracted operations.

For isolated multibay smoke testing, build on
[browser QA](../scripts/dev/multibay-browser-qa.mjs) and
[reconnect smoke](../scripts/dev/multibay-reconnect-smoke.mjs). Use separate bay
databases and the real fabric rather than a local/remote boolean mock alone.
Refresh the matching dev hub environment and verify targets before running;
some smoke scenarios restart services or mutate projects. Do not run them against
production as a side effect of a refactor.

## Follow-Up Work, Not Extraction Scope

After the mechanical series, propose focused PRs for improvements that can change
behavior or require deeper operational evidence:

- Consolidate repeated owner-routing decisions behind domain entrypoints, using
  `withAgentIdentityOwner` as a precedent, not a mandate for one universal router.
  Migrate one operation at a time with local/remote authorization equivalence tests.
- Document each domain's failure contract: authority, retry/idempotency rules,
  durable versus best-effort delivery, projection rebuild/reconciliation, and
  unknown outcomes. Reuse existing outboxes, operation IDs, and observability.
- Measure directory fallback frequency/latency before designing a replacement;
  keep an indexed ownership directory separate from the file-extraction work.
- Make existing projection lag, RPC failures, and seed/fabric dependencies easy
  for operators to inspect. Multiple bays do not remove shared dependencies.
- Establish an authoritative continuous multibay suite using existing harnesses:
  one-bay behavior, cross-bay collaborators, distinct account/project/host owners,
  peer/seed unavailability, restarts, mixed versions, lost replies after mutation,
  and duplicated/reordered delivery where the protocol permits it. Verify actual
  convergence and absence of duplicate effects, not only request acceptance.

Keep rehome exceptional. Add interruption/stale-route cases to its own test
surface without making routine rebalancing or full bay evacuation a prerequisite
for these extractions. Coordinate any correctness fixes independently.

The production multibay rollout decision requires explicit review of current
test and soak evidence. Finishing this cleanup is not certification that the
architecture has no bugs, and this plan does not authorize a rollout.

## Tracking

- [ ] Pilot characterization tests and navigation index.
- [ ] Project reference/details extraction and review of the pattern.
- [ ] Small domain extractions, one cohesive family per PR.
- [ ] Account, host, and bay-operation extractions in separately reviewed slices.
- [ ] Contributor recipe, compatibility checks, and dependency guardrails.
- [ ] Separate proposals for routing/recovery improvements and continuous QA.

Update this checklist with merged PR links and evidence as work lands. The first
implementation task is the pilot characterization work, not a large rewrite of
`service.ts` or `api.ts`.
