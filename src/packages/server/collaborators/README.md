# Hosted People services

See [People architecture](../../../../docs/people-architecture.md) and
[review guide](../../../../docs/people-review-guide.md).

`api.ts` resolves account homes and project owners before authorization or data
access. Public auth-first Conat APIs and trusted inter-bay handlers share the
domain contract, with distinct credential boundaries. Host-authenticated source
registration/ingestion verifies current project placement and writer fences.

`maintenance.ts` installs the complete schema before starting bounded workers.
Source revision delivery and demand-driven home projections are separate from
durable notification fanout. Access renewal does not wait for source pages.
Revocation expires metadata leases and authoritative opens check membership.

`scan-batch.ts` owns account admission and the LRO. `scan-child.ts` routes exact
project execution to its owner and host. `scan-worker.ts` and `scan-recovery.ts`
resume already admitted work, never discover projects or admit scans themselves.
Reservations survive ambiguous host outcomes; cancellation requires an exact
stop acknowledgment. Candidate listing reads account-home projections only;
execution rechecks current owner membership, archive state, and host readiness.

Invitation services own invitation intent separately from membership changes,
delivery, and content opening. Personal URL resolution is separate from indexing
and resolves stable identities without granting access.

Default-off enablement is intentional. The retained Scan rollout gate protects
unfinished aggregate campaign capacity validation; removing obsolete prototypes
does not mean those capacity gates have passed. See the review guide for remaining
work and focused validation commands. Account/project rehome and deletion must
carry or reclaim the appropriate retained state through existing routed services.
