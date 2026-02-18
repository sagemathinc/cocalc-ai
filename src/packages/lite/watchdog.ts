import os from "node:os";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import getLogger from "@cocalc/backend/logger";
import { getPersistClientDebugStats } from "@cocalc/conat/persist/client";
import { getChangefeedServerDebugStats } from "@cocalc/conat/hub/changefeeds";
import { getAcpWatchdogStats } from "./hub/acp";

const logger = getLogger("lite:watchdog");

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_SUMMARY_MS = 5 * 60_000;
const DEFAULT_CPU_WARN_PCT = 85;
const DEFAULT_ELU_WARN_PCT = 85;
const DEFAULT_LOOP_DELAY_WARN_MS = 250;
const DEFAULT_PERSIST_ACTIVE_WARN = 120;
const DEFAULT_CHANGEFEED_ACTIVE_WARN = 200;
const DEFAULT_ACP_ACTIVE_WRITERS_WARN = 20;
const DEFAULT_TOP_N = 6;

let timer: NodeJS.Timeout | undefined;

function envNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (value == null || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function envEnabled(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value == null) return fallback;
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return fallback;
}

function bytesToMB(bytes: number): number {
  return Math.round((bytes / 1e6) * 10) / 10;
}

function summarizeConstructors(values: any[], topN = 8) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const name =
      value?.constructor?.name ??
      Object.prototype.toString.call(value).slice(8, -1) ??
      "unknown";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map(([type, count]) => ({ type, count }));
}

function getActiveHandleStats(topN = 8) {
  const handles =
    typeof (process as any)._getActiveHandles === "function"
      ? ((process as any)._getActiveHandles() as any[])
      : [];
  const requests =
    typeof (process as any)._getActiveRequests === "function"
      ? ((process as any)._getActiveRequests() as any[])
      : [];
  return {
    handleCount: handles.length,
    requestCount: requests.length,
    handleTypesTop: summarizeConstructors(handles, topN),
    requestTypesTop: summarizeConstructors(requests, topN),
  };
}

export function initWatchdog() {
  if (timer != null) {
    return;
  }
  if (envEnabled("COCALC_WATCHDOG_DISABLED", false)) {
    logger.debug("watchdog disabled by COCALC_WATCHDOG_DISABLED");
    return;
  }

  const intervalMs = Math.max(
    1_000,
    envNumber("COCALC_WATCHDOG_INTERVAL_MS", DEFAULT_INTERVAL_MS),
  );
  const summaryMs = Math.max(
    intervalMs,
    envNumber("COCALC_WATCHDOG_SUMMARY_MS", DEFAULT_SUMMARY_MS),
  );
  const summaryEnabled = envEnabled("COCALC_WATCHDOG_SUMMARY", false);
  const topN = Math.max(1, envNumber("COCALC_WATCHDOG_TOP_N", DEFAULT_TOP_N));

  const cpuWarnPct = envNumber("COCALC_WATCHDOG_CPU_WARN_PCT", DEFAULT_CPU_WARN_PCT);
  const eluWarnPct = envNumber("COCALC_WATCHDOG_ELU_WARN_PCT", DEFAULT_ELU_WARN_PCT);
  const loopDelayWarnMs = envNumber(
    "COCALC_WATCHDOG_LOOP_DELAY_WARN_MS",
    DEFAULT_LOOP_DELAY_WARN_MS,
  );
  const persistActiveWarn = envNumber(
    "COCALC_WATCHDOG_PERSIST_ACTIVE_WARN",
    DEFAULT_PERSIST_ACTIVE_WARN,
  );
  const changefeedActiveWarn = envNumber(
    "COCALC_WATCHDOG_CHANGEFEED_ACTIVE_WARN",
    DEFAULT_CHANGEFEED_ACTIVE_WARN,
  );
  const acpActiveWritersWarn = envNumber(
    "COCALC_WATCHDOG_ACP_ACTIVE_WRITERS_WARN",
    DEFAULT_ACP_ACTIVE_WRITERS_WARN,
  );

  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();

  let lastCpu = process.cpuUsage();
  let lastTime = process.hrtime.bigint();
  let lastElu = performance.eventLoopUtilization();
  let lastSummary = Date.now();
  let hotStreak = 0;

  logger.debug("watchdog enabled", {
    intervalMs,
    summaryMs,
    summaryEnabled,
    cpuWarnPct,
    eluWarnPct,
    loopDelayWarnMs,
    persistActiveWarn,
    changefeedActiveWarn,
    acpActiveWritersWarn,
  });

  const tick = () => {
    const now = Date.now();
    const nowHr = process.hrtime.bigint();
    const wallMs = Number(nowHr - lastTime) / 1e6;
    lastTime = nowHr;
    if (!Number.isFinite(wallMs) || wallMs <= 0) {
      return;
    }

    const cpuDelta = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const cpuMs = (cpuDelta.user + cpuDelta.system) / 1000;
    const cpuPct = (cpuMs / wallMs) * 100;

    const eluNow = performance.eventLoopUtilization();
    const eluDelta = performance.eventLoopUtilization(eluNow, lastElu);
    lastElu = eluNow;
    const eluPct = (eluDelta.utilization ?? 0) * 100;

    const loopDelayMeanMs = Number(loopDelay.mean) / 1e6;
    const loopDelayMaxMs = Number(loopDelay.max) / 1e6;
    const loopDelayP99Ms = Number(loopDelay.percentile(99)) / 1e6;
    loopDelay.reset();

    const memory = process.memoryUsage();
    const persist = getPersistClientDebugStats({ topN });
    const changefeeds = getChangefeedServerDebugStats({ topN });
    const acp = getAcpWatchdogStats({ topN });

    const reasons: string[] = [];
    if (cpuPct >= cpuWarnPct) reasons.push(`cpu=${cpuPct.toFixed(1)}%`);
    if (eluPct >= eluWarnPct) reasons.push(`elu=${eluPct.toFixed(1)}%`);
    if (loopDelayMaxMs >= loopDelayWarnMs)
      reasons.push(`loopDelayMax=${loopDelayMaxMs.toFixed(1)}ms`);
    if (persist.active >= persistActiveWarn)
      reasons.push(`persist.active=${persist.active}`);
    if (changefeeds.activeSockets >= changefeedActiveWarn)
      reasons.push(`changefeeds.activeSockets=${changefeeds.activeSockets}`);
    if (acp.activeWriters >= acpActiveWritersWarn)
      reasons.push(`acp.activeWriters=${acp.activeWriters}`);

    const hot = reasons.length > 0;
    hotStreak = hot ? hotStreak + 1 : 0;

    const snapshot = {
      timestamp: new Date(now).toISOString(),
      hotStreak,
      reasons,
      cpuPct: Math.round(cpuPct * 10) / 10,
      eventLoopUtilizationPct: Math.round(eluPct * 10) / 10,
      loopDelayMs: {
        mean: Math.round(loopDelayMeanMs * 10) / 10,
        p99: Math.round(loopDelayP99Ms * 10) / 10,
        max: Math.round(loopDelayMaxMs * 10) / 10,
      },
      memoryMB: {
        rss: bytesToMB(memory.rss),
        heapUsed: bytesToMB(memory.heapUsed),
        heapTotal: bytesToMB(memory.heapTotal),
        external: bytesToMB(memory.external),
      },
      loadavg: os.loadavg().map((x) => Math.round(x * 100) / 100),
      acp,
      persist,
      changefeeds,
    };

    if (hot) {
      logger.warn("watchdog hot", {
        ...snapshot,
        runtime: getActiveHandleStats(topN),
      });
      return;
    }

    if (summaryEnabled && now - lastSummary >= summaryMs) {
      lastSummary = now;
      logger.debug("watchdog summary", snapshot);
    }
  };

  timer = setInterval(tick, intervalMs);
  timer.unref?.();
  process.once("exit", closeWatchdog);
}

export function closeWatchdog() {
  if (timer != null) {
    clearInterval(timer);
    timer = undefined;
  }
}
