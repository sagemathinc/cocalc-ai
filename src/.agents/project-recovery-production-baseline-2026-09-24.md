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

## 2026-09-24 17:15 UTC operator health

One hour later, the same read-only check reported project-start lifecycle p95
of 5.3 seconds from 149 starts, below the seven-second target. Backend start
time was 4.3 seconds p95, admission 639 ms, and convergence 1.2 seconds.
Terminal readiness was 5.7 seconds, Jupyter 1.2 seconds, exec 5 ms, file
content paint 1.3 seconds, and file sync 3.2 seconds p95. Bay backup restore
and PITR checks remained healthy. Overall health was warning for checks other
than browser latency. The marked change from the preceding hour reinforces
the need for a multi-day distribution and investigation of the earlier start
spike; neither sample alone is a stable baseline.

## 2026-09-24 18:40 UTC operator health

A third read-only 60-minute window reported project-start lifecycle p95 of
10 seconds from 148 starts, again above the seven-second target. Admission
p95 was 1.1 seconds, backend p95 4.5 seconds, and convergence p95 1.9
seconds. Terminal readiness was 4.0 seconds, Jupyter 1.1 seconds, exec 7 ms,
file-content paint 1.7 seconds from 358 opens, and file sync 3.2 seconds
from 292 opens. Bay backup restore and PITR checks remained healthy. The
overall operator health was warning, including the project-start latency
warning. Three point-in-time windows remain insufficient for a seven-day
baseline; the 81-second, 5.3-second, and 10-second lifecycle p95 values
demonstrate substantial hour-to-hour variation.

## 2026-09-24 19:41 UTC operator health

A fourth read-only 60-minute window reported project-start lifecycle p95 of
22 seconds from 144 starts, above the seven-second production target. Admission
p95 was 4.2 seconds, backend p95 5.3 seconds, and frontend convergence p95
7.2 seconds from 143 measured convergences. Terminal readiness was 7.6
seconds, Jupyter 867 ms, exec 5 ms, file-content paint 1.1 seconds from 424
opens, and file sync 2.8 seconds from 344 opens. Bay backup restore and PITR
checks remained healthy. Overall operator health was critical because of
project-start latency. The four observed lifecycle p95 values are now 81,
5.3, 10, and 22 seconds; this variation remains an open baseline and capacity
investigation. Production still runs without the project recovery scheduler
changes, so this sample cannot be attributed to them.

## 2026-09-24 20:50 UTC operator health

A fifth read-only 60-minute window reported project-start lifecycle p95 of
20 seconds from 176 starts, above the existing seven-second target. Admission
p95 was 1.5 seconds from 177 observations, backend p95 8.4 seconds from 177,
and frontend convergence p95 7.9 seconds from 177. Terminal readiness was
7.2 seconds, Jupyter 905 ms, exec 5 ms, file-content paint 1.3 seconds from
390 opens, and file sync 2.5 seconds from 309 opens. Bay backup restore and
PITR checks remained healthy. Overall health was critical because of
project-start latency. The five observed lifecycle p95 values are now 81,
5.3, 10, 22, and 20 seconds. The recovery scheduler has not been deployed to
production, so these measurements cannot be attributed to it. This remains
five rolling windows sampled over several hours, not the required seven-day
baseline.

## Remaining measurements

- A bounded seven-day aggregate over the historical `ux_latency_events`
  table has not yet been extracted. The audited read-only production SQL route
  requires a cookie-backed fresh-auth session, and the general operator
  health request for a 10,080-minute window timed out at its 30-second RPC
  limit. The first-party short elevation flow failed before presenting an
  approval URL with `user must be a collaborator on project`, even with
  ambient project authentication defaults disabled. No approval occurred and
  no historical SQL ran. Resolve that authorization path before attempting a
  bounded aggregate or making a seven-day baseline claim.
- Seven days of start, terminal, Jupyter, exec, file, and host pressure
  distributions, with host and maintenance activity context.
- Snapshot and off-host backup due-to-confirmed-success distributions by bay,
  host, and storage funding class after the new ledger is rolled out.
- Per-stage execution, retry, and byte distributions plus sampled restore
  success, without exposing project contents.
- Safe maintenance capacity calibrated against interactive latency and host
  pressure. Production release requires the maintainer's review and a
  coordinated rollout.
