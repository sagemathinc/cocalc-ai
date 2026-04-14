# Project-Host SQLite Phase 2 Audit

Status: proposed

Related:

- `src/.agents/project-host-freeze-elimination-plan.md`

Goal: define the second-stage cleanup after ACP is isolated, so remaining
SQLite use in `project-host` is constrained to places where synchronous local
SQLite is actually a good fit.

This document is intentionally narrower than a general storage redesign. It
answers:

- what SQLite use is still acceptable in `project-host`
- what SQLite use should move off the main event loop
- why the ACP split is necessary but not the end of the SQLite audit

## Executive Summary

The current production blocker is ACP contention. The freeze-elimination plan
addresses that.

However, after ACP is split out, `project-host` will still have several
remaining synchronous SQLite touchpoints in the main process. Those remaining
touchpoints are much smaller risk than ACP, but they are not all equally
appropriate.

The Phase 2 target is:

- keep SQLite for small, host-local metadata with low write frequency and clear
  ownership
- remove synchronous SQLite reads from hot auth and request paths
- stop using the generic local SQLite mirror as a control-plane dependency for
  frequent per-request authorization checks

In short:

- SQLite stays
- synchronous SQLite stays only where it is clearly the right tool
- hot-path authorization should become memory-first, not SQLite-first

## What We Learned From Production

The ACP freeze incident already established the key operational lesson:

- SQLite itself is not the problem
- shared lock domains plus synchronous access in the wrong process are the
  problem

That same lesson applies more broadly inside `project-host`.

The current wrapper in `src/packages/lite/hub/sqlite/database.ts` uses:

- `DatabaseSync`
- `PRAGMA journal_mode=WAL`
- `PRAGMA synchronous=NORMAL`
- `PRAGMA busy_timeout=5000`

That configuration is not inherently wrong. It is appropriate only when:

- contention is low
- writes are infrequent
- ownership is simple
- the calling thread can safely block briefly

Those conditions are not true for ACP.
They are also not true for every remaining `project-host` use.

## Audit: Remaining SQLite Use In Project-Host

## A. Clearly Fine To Keep Synchronous

These are good fits for local sync SQLite after ACP is isolated.

### 1. Host identity and host-local key material

Files:

- `src/packages/project-host/host-id.ts`
- `src/packages/project-host/sqlite/hosts.ts`

Why this is fine:

- tiny data set
- very low write frequency
- read mostly at startup or infrequent control points
- single-host ownership

This is exactly the sort of durable local metadata SQLite is good at.

### 2. Provisioning/report cursors and other infrequent local bookkeeping

Files:

- `src/packages/project-host/sqlite/provisioning.ts`
- `src/packages/project-host/sqlite/account-revocations.ts`

Why this is mostly fine:

- low cardinality
- small rows
- low write rate
- operationally local

Important nuance:

- the table design is fine
- the problem is whether reads happen on a hot request path

So the storage itself is acceptable. The access pattern may still need to
change.

### 3. Startup-time local initialization

Files:

- `src/packages/project-host/sqlite/init.ts`

Why this is fine:

- boot-time only
- not user-facing request latency
- simple local metadata initialization

## B. Acceptable Storage, Wrong Access Pattern

These are places where SQLite can remain the persistence mechanism, but the main
process should stop hitting it synchronously on frequent request paths.

### 1. Conat auth collaborator checks

Files:

- `src/packages/project-host/conat-auth.ts`
- `src/packages/project-host/http-proxy-auth.ts`

Current pattern:

- read collaborator/project membership from local SQLite on auth checks
- read account revocation state from local SQLite on auth checks

Why this is concerning:

- auth is a hot path
- it is latency-sensitive
- it can be hit repeatedly during reconnect storms
- a synchronous DB read in this path amplifies any storage hiccup into
  connection-level instability

Even after ACP is removed, this is still the wrong default shape.

The right model is:

- in-memory auth snapshot/cache
- refreshed from hub-driven local state updates
- SQLite as the durability layer of record, not the per-request dependency

### 2. Document activity collaborator checks

File:

- `src/packages/project-host/document-activity-service.ts`

Current pattern:

- each authorization check reads the project row from local SQLite and inspects
  `users`

Why this is concerning:

- this is still request-path authorization
- it is not as critical as primary Conat auth, but it is still latency-sensitive
- it duplicates the same collaborator lookup pattern as the auth layer

This should use the same in-memory project membership cache as auth.

### 3. Local project metadata mirror

Files:

- `src/packages/project-host/sqlite/projects.ts`
- `src/packages/project-host/master.ts`

The storage goal is reasonable:

- maintain a local project metadata mirror for degraded operation

What is not ideal:

- the generic `data` mirror is used by request-path auth
- multiple concerns are bundled into one local mirror:
  - project runtime metadata
  - collaborator membership
  - UI/changefeed mirroring
  - auth-adjacent state

That makes it too easy for the generic mirror to become a hidden dependency for
hot paths.

The better design is:

- keep a durable local project metadata store
- but maintain a separate in-memory projection for auth and request-path checks

## C. Probably Fine For Now, But Should Stay Narrow

### 1. Storage reservations

File:

- `src/packages/project-host/storage-reservations.ts`

This is not my top concern after ACP is split.

Why it is less concerning:

- it is operational, not per-keystroke or per-connection auth
- it should not be hit at high frequency by normal terminal/editor traffic

What still matters:

- keep it narrowly scoped
- do not let it become a general-purpose coordination store
- avoid sharing it with unrelated hot subsystems

If needed later, this could move to its own tiny metadata DB, but that is not a
Phase 2 blocker.

## What Should The End State Be?

After ACP isolation, the desired `project-host` storage model is:

- `project-host` main process:
  - small local SQLite for durable host-local metadata
  - no synchronous request-path dependency on SQLite for repeated auth checks
- ACP daemon:
  - sole owner of `acp.sqlite`
- in-memory projections:
  - collaborator membership
  - revocation cutoffs
  - project auth tokens / local auth facts needed on hot paths

This is the key principle:

> Durable local metadata may live in SQLite, but hot-path authorization should
> be memory-first.

## Why This Should Work

This works because it matches what sync SQLite is actually good at.

SQLite is a strong fit when:

- one process owns the data
- writes are small and infrequent
- the schema is simple
- the application benefits from embedded durability

SQLite is a poor fit when:

- many request handlers repeatedly depend on it
- multiple processes contend on the same file
- lock waiting blocks a latency-sensitive event loop

The Phase 2 design restores the good case:

- ACP is isolated to its own owner and file
- `project-host` keeps SQLite only for genuinely local durable metadata
- auth becomes a cheap in-memory read path

That gives the simplicity benefits of SQLite without making every reconnect or
authorization check depend on synchronous DB access.

## Phase 2 Plan

### Phase 2.1: Introduce Memory-First Auth State

Add a dedicated in-memory auth state module inside `project-host` that tracks:

- project collaborator membership by `project_id`
- account revocation cutoffs
- project secret token/auth facts needed on request paths

Sources of truth:

- local durable SQLite tables remain the persisted backing store
- hub/master sync updates feed both SQLite and memory

Hot-path code should read memory only.

Targeted files:

- `src/packages/project-host/conat-auth.ts`
- `src/packages/project-host/http-proxy-auth.ts`
- `src/packages/project-host/document-activity-service.ts`

### Phase 2.2: Stop Reading Generic Project Mirror In Auth Paths

Remove direct `getRow("projects", ...)` lookups from request-path auth checks.

Instead:

- update in-memory collaborator state when local project metadata changes
- keep SQLite as fallback durability only
- if a memory entry is missing, fail in a controlled way or trigger a refresh,
  but do not make repeated request handling block on local SQLite

### Phase 2.3: Narrow The Meaning Of The Local Project Mirror

Refactor the local project mirror so it is explicitly for:

- degraded control-plane recovery
- host-local project metadata
- reconciliation/reporting state

It should not be the default auth lookup substrate.

This may mean:

- a dedicated collaborator projection in memory
- less dependence on the generic `data` table shape

### Phase 2.4: Add Request-Path Guardrails

For the main `project-host` process:

- no `DatabaseSync` reads/writes inside per-message or per-connection hot paths
- any remaining request-path local persistence should be audited and justified
- add comments or lint-like conventions around this boundary if needed

This is more of an engineering rule than a code feature, but it matters.

### Phase 2.5: Re-audit Non-ACP SQLite Call Sites

After the auth/memory split lands, do one more targeted review of:

- `storage-reservations.ts`
- `master.ts`
- any local HTTP/auth/session helpers

The bar should be:

- if a path is rare and operational, sync SQLite may remain
- if a path is hot and user-facing, it should not block on SQLite

## Recommended Implementation Order

1. Land the ACP isolation work from the freeze-elimination plan.
2. Introduce an in-memory auth/project membership cache in `project-host`.
3. Switch Conat auth, HTTP auth, and document-activity auth to that cache.
4. Leave the existing SQLite tables in place as durable backing state.
5. Re-audit the remaining main-process SQLite uses.

This order matters.

If Phase 2 is attempted before ACP isolation, the dominant production freeze
risk remains.

## What Not To Do

Do not:

- replace all SQLite with a more complex service just because ACP was misusing
  it
- increase `busy_timeout` and call it solved
- keep auth request paths dependent on local synchronous DB reads because they
  are "usually fast"
- let the generic project mirror remain an accidental auth database

Those all preserve the same category error: using synchronous embedded storage
on paths where latency spikes directly affect live user sessions.

## Bottom Line

My current view is:

- SQLite is still a good tool for parts of `project-host`
- ACP is the part where it is clearly the wrong tool in the current form
- after ACP is isolated, the next cleanup is not "remove SQLite"
- it is "remove SQLite from hot request-path authorization and keep it only
  where single-owner local durability is the actual requirement"
