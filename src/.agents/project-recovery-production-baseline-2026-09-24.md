# Project recovery production baseline

Started: 2026-09-24 UTC

Status: first read-only observation; seven-day baseline incomplete. No
production configuration, software, project, or host was changed.

The snapshot and backup reliability plan requires a seven-day production
baseline before capacity sizing and a comparison of interactive latency during
staging canaries. The current production release does not expose the new
per-project recovery ledger or its due-to-success distribution. This record
must not be used as evidence that the proposed recovery objectives are met.

## 2026-09-24 16:14 UTC operator health

The production `admin health --wide` read-only check reported 37 registered
project hosts on bay-0 and 16 active hosts in the separate intrusion monitor
check. Bay backup restore and PITR checks were healthy. Browser-observed
project-start lifecycle p95 was 81 seconds from 239 starts in the preceding
60 minutes, above the existing seven-second production target. Its backend
component was 76 seconds p95, admission 1.1 seconds, and convergence 4.5
seconds. Terminal readiness was 6.0 seconds, Jupyter 1.2 seconds, exec 11 ms,
file content paint 1.8 seconds, and file sync 4.4 seconds p95. The
project-start result made the overall health critical at this observation.

This is a single 60-minute window and predates the recovery scheduler rollout.
It cannot establish a seven-day distribution or attribute the slow starts to
snapshots or backups. It does show that the current production start target is
not a usable green baseline at this point. Before evaluating maintenance
impact, collect comparable windows and investigate the start backend delay.

The legacy `admin db backup-health` diagnostic was also available, but its
bounded first page includes unprovisioned and unchanged projects and does not
compute due-to-success by funding class. It is unsuitable as the objective
baseline without a more selective, audited aggregate query.

## Remaining measurements

- Seven days of start, terminal, Jupyter, exec, file, and host pressure
  distributions, with host and maintenance activity context.
- Snapshot and off-host backup due-to-confirmed-success distributions by bay,
  host, and storage funding class after the new ledger is rolled out.
- Per-stage execution, retry, and byte distributions plus sampled restore
  success, without exposing project contents.
- Safe maintenance capacity calibrated against interactive latency and host
  pressure. Production release requires the maintainer's review and a
  coordinated rollout.
