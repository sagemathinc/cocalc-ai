import type { HostConatPersistMetrics } from "@cocalc/conat/hub/api/hosts";

const MINUTE = 60_000;
const GIB = 1024 ** 3;
export const PERSISTENCE_HISTORY_MS = 35 * MINUTE;

export interface PersistenceAlert {
  level: "warning" | "critical";
  signal: "health" | "rss" | "diagnostics" | "growth";
  reason: string;
}

export interface PersistenceAlertPolicy {
  warningRss: number;
  criticalRss: number;
  freshMs: number;
}

export const DEFAULT_PERSISTENCE_ALERT_POLICY: PersistenceAlertPolicy = {
  warningRss: 2 * GIB,
  criticalRss: 4 * GIB,
  freshMs: 5 * MINUTE,
};

// History comes from the owning bay's existing host metrics, not an in-memory
// timer: restarting a hub must not reset the observation window.
export function persistenceAlert(
  history: (HostConatPersistMetrics | null)[],
  now: number,
  policy = DEFAULT_PERSISTENCE_ALERT_POLICY,
): PersistenceAlert | undefined {
  const samples = [
    ...new Map(
      history.filter((m) => m != null).map((m) => [m.collected_at, m]),
    ).values(),
  ]
    .filter((m) => {
      const age = now - Date.parse(m.collected_at);
      return age >= 0 && age <= PERSISTENCE_HISTORY_MS;
    })
    .sort((a, b) => Date.parse(b.collected_at) - Date.parse(a.collected_at));
  const latest = samples[0];
  if (!latest || now - Date.parse(latest.collected_at) > policy.freshMs) {
    return;
  }
  const window = (
    duration: number,
    matches: (m: HostConatPersistMetrics) => boolean,
    sameProcess = true,
  ): HostConatPersistMetrics[] | undefined => {
    const result: HostConatPersistMetrics[] = [];
    for (const sample of samples) {
      const previous = result.at(-1);
      if (
        !matches(sample) ||
        (sameProcess &&
          (latest.pid == null ||
            sample.pid !== latest.pid ||
            (previous?.uptime_seconds != null &&
              sample.uptime_seconds != null &&
              sample.uptime_seconds > previous.uptime_seconds))) ||
        (previous &&
          Date.parse(previous.collected_at) - Date.parse(sample.collected_at) >
            3 * MINUTE)
      ) {
        return;
      }
      result.push(sample);
      if (
        result.length >= 3 &&
        Date.parse(latest.collected_at) - Date.parse(sample.collected_at) >=
          duration
      ) {
        return result;
      }
    }
  };
  if (
    window(2 * MINUTE, (m) => m.available === false || m.ready === false, false)
  ) {
    return {
      level: "critical",
      signal: "health",
      reason:
        "Persistence diagnostics unavailable or not ready for at least 2 minutes",
    };
  }
  for (const [level, threshold, minutes] of [
    ["critical", policy.criticalRss, 2],
    ["warning", policy.warningRss, 10],
  ] as const) {
    if (
      window(
        minutes * MINUTE,
        (m) => m.available && finite(m.rss_bytes) && m.rss_bytes >= threshold,
      )
    ) {
      return {
        level,
        signal: "rss",
        reason: `RSS >= ${(threshold / GIB).toFixed(2)} GiB for at least ${minutes} minutes`,
      };
    }
  }
  if (
    window(
      10 * MINUTE,
      (m) =>
        m.available &&
        finite(m.diagnostics_duration_ms) &&
        m.diagnostics_duration_ms >= 2000,
    )
  ) {
    return {
      level: "warning",
      signal: "diagnostics",
      reason:
        "Local diagnostics requests took >= 2 seconds for at least 10 minutes (not a user-request latency measurement)",
    };
  }
  const growth = window(30 * MINUTE, (m) => m.available && finite(m.rss_bytes));
  if (growth) {
    const rss = growth.map((m) => m.rss_bytes!);
    const oldest = rss.at(-1)!;
    // Require growth in each third of the window, not just a single jump or
    // rising stream cardinality. This is a capacity warning, not a leak verdict.
    const checkpoints = [0, 10, 20, 30].map(
      (minutes) =>
        growth.find(
          (m) =>
            Date.parse(latest.collected_at) - Date.parse(m.collected_at) >=
            minutes * MINUTE,
        )!.rss_bytes!,
    );
    if (
      rss[0] - oldest >= 0.5 * GIB &&
      rss[0] >= oldest * 1.5 &&
      checkpoints
        .slice(1)
        .every((value, i) => checkpoints[i] - value >= 0.1 * GIB)
    ) {
      return {
        level: "warning",
        signal: "growth",
        reason: `RSS grew by ${((rss[0] - oldest) / GIB).toFixed(2)} GiB (>= 50%) across 30 minutes; investigate capacity and retention`,
      };
    }
  }
}

function finite(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function persistenceAlertDelivery(
  hostId: string,
  alert: PersistenceAlert,
) {
  return {
    // Stable identity excludes counters/PID/name, so normal metric fluctuations
    // do not bypass deduplication; new hosts, signals and severity can notify.
    subject: `Project-host persistence ${alert.level}: ${hostId} (${alert.signal})`,
    dedupMinutes: alert.level === "critical" ? 60 : 240,
    dedupBySubject: true,
  };
}
