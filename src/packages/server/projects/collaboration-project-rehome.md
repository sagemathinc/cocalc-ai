# Project Collaboration Rehome

This helper transfers the nine project-owned collaboration metadata tables. It
does not make general project rehome portable. The existing side-table policy in
`rehome-side-tables.ts` still applies, including registered agent identities,
runtime credentials, artifact catalogs, backups, and other platform state.

## Authority Preflight

For a project with retained collaboration state, before creating an export
receipt the helper rejects authority outside those nine tables:

- Agent resources carrying a registered `agent_id`.
- Any active registered identity in the project, including identities not yet
  indexed, or with only historical/copied threads in discovery.
- Artifact resources, whose Library entry resolution requires the separate
  `artifact_catalog` and `artifact_catalog_sources` authority.
- Any live artifact catalog entry in the project, even when discovery has not
  indexed it. Partial collaboration coverage cannot certify portability.

The error names the nonportable authority. No identity, credential, catalog, or
project ownership row is copied or rewritten to bypass the restriction. Initial
rejection creates no durable export receipt; the parent marks its ordinary
rehome attempt failed. Existing frozen exports are rechecked without discarding
their receipt. A destination also rejects dependency-bearing snapshots from
older senders before invoking the project upsert callback.

Plain human collaboration, genuinely unregistered agent threads, copied threads,
and unavailable tombstones remain portable only when the project has no active
registered identity or live artifact catalog entry. Disabled identities and
deleted catalog entries do not themselves block this handoff. With no
collaboration state, the original legacy rehome path is unchanged, not newly
certified safe.

## Transfer And Retry

Snapshot pages contain at most 50 rows and 256 KiB; each row is limited to 64 KiB.
One transfer permits at most 500,000 rows, 256 MiB of canonical row data, and
20,000 pages. Source and destination checkpoints, header binding, page hashes,
table ordering, and the final manifest reject conflicting or incomplete retries.
Source mutations and authority-registration changes must use the shared durable
project rehome write fence throughout snapshot and cutover.

Activation restores the complete snapshot in the parent's project-upsert
transaction, rotates project generation and source epochs, and invalidates old
writer registrations. A committed activation receipt bypasses the callback on
retry, preserving subsequent destination changes. Activation removes staged
payloads but retains page hashes for duplicate/conflicting retries. Source
retirement removes export pages; the header/checkpoint remains for completion
and log retries. Both cleanup operations are bounded by the transfer limits.
