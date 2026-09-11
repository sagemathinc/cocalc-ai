# Project-host persistence alerts

Open stream count is a workload/cardinality observation, not a supported maximum
or an enforced limit. Keep it in host metrics/history and `host persistence`
output; do not notify admins merely because it exceeds 2,000 or 5,000. Those
counts can be normal on busy hosts. The CLI's instantaneous pressure indicators
are not the notification policy.

## Notification policy

The owning bay evaluates its existing persisted host metrics. No new host probes,
automatic restarts, project stops, admission changes, or schema migrations are
introduced by this policy.

| Signal              | Required evidence                                                                                         | Severity |
| ------------------- | --------------------------------------------------------------------------------------------------------- | -------- |
| Health              | Diagnostics unavailable or readiness false for 2 minutes                                                  | Critical |
| RSS                 | At least 4 GiB for 2 minutes                                                                              | Critical |
| RSS                 | At least 2 GiB for 10 minutes                                                                             | Warning  |
| Diagnostics latency | Local diagnostics requests take at least 2 seconds for 10 minutes                                         | Warning  |
| RSS growth          | At least 512 MiB and 50% growth over 30 minutes, with at least 102.4 MiB growth in each 10-minute segment | Warning  |

Every sustained condition requires at least three distinct observations. Samples
must be fresh (5 minutes by default), with no gaps over 3 minutes. Memory and
latency windows cannot cross a PID change or an observed uptime reset. A single
spike, missing history, and stale samples do not establish sustained pressure.
Unavailable diagnostics do not include RSS and can still establish a health
failure across daemon restarts.

Only the highest-priority established signal is sent for a host on each pass
(table order). Health takes precedence over memory; memory takes precedence over
latency and growth. A good current sample stops reminders for that condition.
There is no recovery notification. A recurrence within the reminder interval
remains deduplicated; this is intentionally not a full incident-management system.

Diagnostics duration measures the local diagnostics HTTP request, **not** user
operation latency. RSS growth is a capacity/retention warning, not proof of a
leak. Actual persistence operation latency histograms and error-rate SLOs remain
future instrumentation work; cumulative event-loop utilization is not used as a
current latency signal.

## Reminders and configuration

Warnings repeat at most every 4 hours and critical alerts at most every hour,
independently per host, severity, and signal. Changes in PID, display name, RSS,
or stream count do not bypass deduplication. Escalation and another affected host
are not hidden by a fleet-wide subject. Existing durable message history provides
deduplication across hub restarts, and a bay-local advisory lock serializes passes
so multiple hub workers cannot race the deduplication check.

The existing `COCALC_HOST_CONAT_PERSIST_WARNING_RSS_BYTES`,
`COCALC_HOST_CONAT_PERSIST_CRITICAL_RSS_BYTES`, and
`COCALC_HOST_CONAT_PERSIST_ALERT_FRESH_METRICS_MS` environment settings still apply.
The former `COCALC_HOST_CONAT_PERSIST_WARNING_OPEN_STREAMS` and
`COCALC_HOST_CONAT_PERSIST_CRITICAL_OPEN_STREAMS` settings no longer affect admin
notifications. Duration, growth, and reminder defaults are in
`src/packages/server/hosts/persistence-alert-policy.ts`.

## Rollout and operator follow-up

Deploy the server/hub change through the normal staging/release process. Project
hosts and persistence daemons need no restart for this notification change. Do not
change production thresholds just to silence the existing notifier before review.

Inspect `host persistence`, host metrics history, and persistence logs when an
alert arrives. Compare RSS, heap/external memory, opened/closed stream totals,
readiness, and workload over time. Look for recovery after load declines before
diagnosing a leak. Missing/stale telemetry is not proof of health: existing host
heartbeat/availability monitoring remains necessary alongside this policy.

History reads are bounded to the configured freshness window plus 30 minutes
(35 minutes by default) and at most 512 samples per host using the
existing `(host_id, collected_at)` index. Existing one-minute metrics sampling
provides sufficient resolution. No fleet-wide scan of old metric history is
needed, and this PR does not deploy or change production services itself.
