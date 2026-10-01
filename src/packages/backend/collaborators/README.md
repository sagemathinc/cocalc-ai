# Collaboration source producer

See [People architecture](../../../../docs/people-architecture.md) for the
product, ownership, Scan, and enablement contract.

## Supported writes

`filesystem.ts` wraps supported writes with durable intent in `journal.ts`.
`service.ts` resumes dirty sources, validates the current writer epoch, extracts
bounded metadata, and acknowledges only committed owner catalog updates.
`room-source.ts`, `legacy-identity-source.ts`, `relations-source.ts`, and
`notifications.ts` preserve stable identities and distinguish historical
metadata imports from real new-message activity.

The legacy identity adapter handles timestamp-only records inside current
`.chat` files. It is needed for existing user data and is different from the
removed compatibility code for earlier development index schemas. Filesystem
move/copy hooks fence both source identities, retain durable intent, and prevent
late old-path writers from resurrecting catalog entries.

## Explicit filename discovery

The hosted adapter in `project-host/collaborators-census.ts` performs a bounded
`fd` filename search, then passes changed paths through `census-producer.ts` into
the same source journal. There is one discovery implementation; no directory
streaming fallback, bootstrap inventory, or periodic scan scheduler.

The host-private census store retains run/volume scope, a single discovery work
item per project, candidate handoff, compact summaries, exact report retries,
start-time success/failure watermarks, and cancellation tombstones. Pending
handoff and unknown acknowledgments survive restart. Completed candidates may
compact after durable journal acceptance. Scope replacement requires a compare
and swap against the exact prior run. Failed discovery never means an empty
successful inventory, and discovery never deletes missing resources.

Capacity is explicit: `COCALC_COLLABORATORS_CENSUS_PROJECTS` and
`COCALC_COLLABORATORS_CENSUS_BYTES` bound retained census metadata;
`COCALC_COLLABORATORS_CENSUS_CANDIDATES` bounds discovered paths. Journal settings
`COCALC_COLLABORATORS_JOURNAL_SOURCES` and
`COCALC_COLLABORATORS_JOURNAL_BYTES` independently bound source metadata. Lowering
a cap never evicts accepted work. Policy changes affect subsequent explicitly
admitted runs, not background scans. Reports are bounded, change-driven metadata
and retain exact retry payloads; they are not indexing-success checkpoints.

## Runtime recovery

The producer lease, volume lifecycle fence, room lifecycle identity, source
registration epoch, durable journal transactions, copy locks, and exact request
receipts are runtime correctness requirements. They remain even though earlier
prototype schemas are not supported. Database files are private metadata; no
API may infer authority from them or start compute to populate them.

Focused validation: `pnpm exec jest collaborators --runInBand` from this package;
hosted filename discovery and cancellation tests live in project-host.
