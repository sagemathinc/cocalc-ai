# CoCalc.ai Production Cluster Health Checklist

This is the default read-only checklist for checking `cocalc.ai` production
health after a deploy, alert, or suspected incident.

The goal is to answer three questions quickly:

1. Is the site healthy for users right now?
2. Are any hosts refusing work or close to a resource cliff?
3. Is anything trending badly enough that we should act before it becomes an
   outage?

## Safety Rules

- Default to read-only commands.
- Do not restart services, mutate Postgres, start/stop hosts, delete files, or
  change cloud resources as part of this checklist.
- If a check suggests a mutation, write down the evidence first and make the
  mutation a separate deliberate action.
- Use the CoCalc CLI directly; do not assume `cocalc` in `PATH` is the right
  binary:

```bash
COCALC=(/opt/cocalc/bin/node /opt/cocalc/bin2/cocalc-cli.js)
```

For live prod CLI checks:

```bash
"${COCALC[@]}" --profile prod --api https://cocalc.ai auth status --check
```

If fresh auth is required for an admin action, use browser-approved bootstrap
from the repo-built CLI. Do not try to satisfy dangerous admin auth using API
keys or bearer tokens.

## Fast Pass

Run this first. It is intentionally simple and should usually take under five
minutes.

### Bay-0 OS Health

```bash
ssh prod 'hostname; date -Is; uptime; df -h / /mnt/cocalc 2>/dev/null || df -h /; free -h; ps -eo pid,comm,%cpu,%mem,etime,args --sort=-%cpu | head -35'
```

Healthy:

- Load is comfortably below CPU count and not climbing.
- CPU iowait is low; sustained iowait above roughly `10-15%` is worth
  investigating.
- `/` is below `75%`; `/var/log` is not unexpectedly huge.
- `/mnt/cocalc` has large absolute headroom.
- Available memory is comfortably above `20%`; swap is not active or thrashing.
- Top CPU is explainable: hub workers, Postgres, cloudflared, backup jobs, or
  short-lived admin checks.

Actionable:

- Root filesystem above `85%`.
- `/mnt/cocalc` above `80%` or rapidly growing.
- Sustained load near or above CPU count.
- Sustained iowait above `20%`.
- OOM, hung tasks, many zombies, or repeated service restarts.

### Host Inventory

```bash
"${COCALC[@]}" --profile prod --api https://cocalc.ai host list --json
```

Healthy:

- All expected production hosts are present.
- Shared hosts are `running`.
- `last_seen` is fresh, usually within one minute.
- No unexpected runtime overrides.

Actionable:

- Missing host.
- Shared host stuck in `starting`, `stopping`, `error`, or stale heartbeat.
- Unexpected override on a shared production host.

### Host Metrics And Admission

Check every host, not only the one mentioned in an alert.

```bash
node <<'NODE'
const { execFileSync } = require("node:child_process");

const cocalc = ["/opt/cocalc/bin/node", "/opt/cocalc/bin2/cocalc-cli.js"];
function cli(args) {
  return JSON.parse(
    execFileSync(
      cocalc[0],
      [cocalc[1], "--profile", "prod", "--api", "https://cocalc.ai", ...args, "--json"],
      { encoding: "utf8" },
    ),
  );
}

const raw = cli(["host", "list"]);
const hosts = Array.isArray(raw) ? raw : raw.hosts ?? raw.result ?? [];
const rows = [];

for (const host of hosts) {
  const m = cli(["host", "metrics", host.id]);
  const metrics = m.metrics ?? m.result?.metrics ?? m;
  const disk = metrics.disk ?? metrics.storage ?? {};
  const admission = metrics.admission ?? metrics.storage_admission ?? {};
  rows.push({
    name: host.name ?? host.id,
    running: metrics.projects?.running ?? metrics.running_projects,
    assigned: metrics.projects?.assigned ?? metrics.assigned_projects,
    total_gb: disk.total_gb ?? disk.total_bytes / 1e9,
    used_gb: disk.used_gb ?? disk.used_bytes / 1e9,
    conservative_gb: admission.conservative_free_gb,
    admission_gb: admission.admission_headroom_gb,
    disk_level: admission.disk_level ?? disk.level,
    metadata_level: admission.metadata_level,
    admission_allowed: admission.allowed ?? admission.admission_allowed,
    auto_grow: admission.auto_grow_requested ?? admission.auto_grow,
  });
}

console.table(rows);
console.log(
  "Potential issues:",
  rows.filter(
    (r) =>
      r.admission_allowed === false ||
      r.disk_level === "critical" ||
      r.disk_level === "error" ||
      r.metadata_level === "critical" ||
      r.metadata_level === "error",
  ),
);
NODE
```

Healthy:

- `admission_allowed=true` on every shared production host.
- `disk_level=healthy` or at worst a clearly understood `warning`.
- `metadata_level=healthy`.
- `conservative_gb` and `admission_gb` are comfortably positive.
- Auto-grow is not repeatedly requested without increasing disk capacity.

Actionable:

- `admission_allowed=false`.
- `metadata_level=critical`.
- Negative or near-zero admission headroom.
- A host with many assigned projects and no meaningful free/admission headroom.

## Deployment Convergence

Use this after deploying `project-host`, `project-bundle`, `tools`, `hub`, or
`static`.

```bash
"${COCALC[@]}" --profile prod --api https://cocalc.ai host get <host-id-or-name> --json
```

Healthy:

- `project_host` desired, installed, and running versions are aligned after a
  `project-host` deploy.
- `project_bundle` and `tools` desired and installed versions match after their
  deploys.
- Bootstrap status is `done` or `in_sync`.
- Runtime rollout reports healthy/promoted for the target artifact.

Known normal:

- `conat-router`, `conat-persist`, and often `acp-worker` may intentionally
  report runtime component drift. They are disruptive to update and should not
  be rolled just to remove drift unless there was a specific deploy that
  requires them.

Actionable:

- `project-host` itself is drifted after a `project-host` deploy.
- Bootstrap is stuck or repeatedly failing.
- Runtime rollout is unhealthy, waiting indefinitely, or repeatedly falling
  back.
- A shared host is not on the intended cluster default when it should be.

## Logs

Start broad, then narrow to relevant services.

```bash
ssh prod 'journalctl --since "30 minutes ago" --no-pager | grep -Ei "admission|disk pressure|auto-grow|Bootstrap failed|start failed|ERROR|FATAL|panic|exception|no space|ENOSPC|EMFILE|OOM|killed process|btrfs" | tail -200'
```

```bash
ssh prod 'journalctl --since "15 minutes ago" --no-pager -u bay-hub -u bay-hub-worker -u bay-postgres-run 2>/dev/null | tail -200'
```

Healthy:

- No repeated current errors.
- Deploy-era disconnects stop shortly after deploy.
- Cloudflared transient reconnect warnings are rare and self-heal.

Usually not urgent by itself:

- A short burst of `Error: disconnected` during hub or worker deploy.
- A single stale LRO timeout for an old browser operation.
- A one-off `relation does not exist` from optional/admin paths, if it does not
  repeat and the user-visible feature is not active.

Actionable:

- Repeated `admission denied` tied to user-visible methods over several
  minutes.
- Repeated `ENOSPC`, btrfs metadata errors, or disk pressure messages.
- Repeated Postgres errors for the same query.
- Repeated project start failures, bootstrap failures, or host connection
  failures.
- OOM killer events or service restarts.

## Postgres And Hub Load

Bay-0 is currently also the central control-plane database host, so Postgres
load matters directly for site latency.

Read-only OS-level check:

```bash
ssh prod 'ps -eo pid,comm,%cpu,%mem,etime,args --sort=-%cpu | grep -E "postgres|node|rustic|pg_basebackup|pg_dumpall" | head -40'
```

Healthy:

- Postgres CPU is moderate and not monopolizing the VM.
- Hub workers are active but not pegged.
- Backup jobs, if present, are low priority and not causing high iowait.

Actionable:

- Postgres consumes most CPU for sustained periods.
- Many long-running Postgres backends appear during a user-visible outage.
- `rustic`, `pg_basebackup`, or `pg_dumpall` coincide with high iowait or start
  latency alerts.
- `pg_stat_statements` or an equivalent read-only query diagnostic path is
  unavailable during a database load incident.

## Service Admission Alerts

Service admission alerts are useful, but interpret the span.

Healthy or informational:

- Large denial count in a sub-second or few-second span during a burst or retry
  fan-out.
- Denials dominated by low-priority/admin/history methods while the site is
  otherwise healthy.

Actionable:

- Denial span is sustained for several minutes.
- Denials involve core user-visible paths such as project start, file open,
  terminal, Jupyter, or host connection.
- The same method repeatedly saturates a limit in multiple alert windows.
- Alerts coincide with elevated bay load, Postgres CPU, or browser-observed UX
  latency.

Follow-up checks:

- Look for client retry fan-out.
- Look for one expensive endpoint being polled by many browsers.
- Check whether a low-priority limit is too low or whether the endpoint should
  be cached/coalesced.

## Project Start UX Alerts

Project start alerts should be checked against actual project state.

Healthy or likely instrumentation issue:

- Alert says timeout/stuck, but the project is running and usable.
- A small number of repeated samples refer to the same browser operation.
- The project was CPU-abuse cut off or intentionally blocked and should not be
  counted as a stuck normal start.

Actionable:

- Multiple accounts/projects on the same host are genuinely unable to start.
- Browser stream shows `opened -> opened` while backend state is running; this
  suggests a frontend/project stream sync issue.
- Alerts correlate with one host having `admission_allowed=false`, stale
  heartbeat, high disk pressure, or bootstrap failures.
- Alerts correlate with bay load, Postgres load, or backup iowait.

## Backups

Check backup health when a host was recently deployed, resized, migrated, or
shows many projects needing backup.

```bash
"${COCALC[@]}" --profile prod --api https://cocalc.ai host projects <host-id-or-name> --json
```

Healthy:

- Most provisioned projects have a recent backup.
- `needs_backup` projects are explainable by recent writes.
- Backup counts recover after the next scheduled backup cycle.

Actionable:

- Old projects with files and automatic backups enabled have no backup.
- A host has a large persistent `provisioned_needs_backup` count that does not
  shrink over time.
- Backup jobs are running concurrently enough to cause iowait or user-visible
  latency.
- Backups repeatedly fail for one host, bucket, or region.

## Abuse And Egress Signals

For abuse detection pages and managed egress checks:

Healthy:

- Admin overview pages load quickly with explicit refresh.
- Managed egress event volume is low after rollup/coalescing.
- Users with normal project traffic show near-zero or small egress.

Actionable:

- `*_managed_egress_events` insert/query load rises again.
- Admin abuse pages time out for short ranges.
- A single browser/page causes repeated expensive egress history queries.
- High egress appears for new free accounts or projects with miner-like
  process/network signals.

## Host-Specific Deep Dive

For one suspicious host:

```bash
"${COCALC[@]}" --profile prod --api https://cocalc.ai host get <host-id-or-name> --json
"${COCALC[@]}" --profile prod --api https://cocalc.ai host metrics <host-id-or-name> --json
"${COCALC[@]}" --profile prod --api https://cocalc.ai host projects <host-id-or-name> --json
```

Check:

- status, `last_seen`, bay, provider, region
- desired versus installed software versions
- project-host runtime version and rollout phase
- disk totals, conservative free space, admission headroom, metadata pressure
- running project count and assigned project count
- backup backlog and oldest missing backup
- recent project starts or migrations involving that host

## Production Health Summary Template

Use this format when reporting findings:

```text
Prod health: healthy / watch / degraded

Bay-0:
- load:
- disk:
- memory:
- notable processes:

Hosts:
- running/fresh:
- admission:
- disk/metadata:
- deploy convergence:

Alerts/logs:
- recent alerts:
- repeated errors:
- deploy-era noise:

Backups:
- concerning hosts/projects:

Action:
- no action needed / monitor / proposed separate mutation:
```

## Escalation Thresholds

Escalate to an active incident if any of these are true:

- The prod page cannot load for multiple independent clients.
- Multiple shared hosts are stale or refusing admission.
- Bay-0 root disk is near full or Postgres cannot write.
- `/mnt/cocalc` or btrfs metadata pressure is critical on any busy shared host.
- Project starts fail broadly across hosts for more than a few minutes.
- Postgres or hub workers are saturated and user-visible operations are timing
  out.
- Backups or migration jobs are creating sustained high iowait.
- Cloud provider policy risk is active, e.g. confirmed mining traffic not being
  cut off.
