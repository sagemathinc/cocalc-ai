/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import getLogger from "@cocalc/backend/logger";
import type { Client as ConatClient } from "@cocalc/conat/core/client";
import {
  BROWSER_RUNTIME_PRESENCE_WILDCARD,
  parseBrowserRuntimePresenceSubject,
} from "@cocalc/conat/project-host/browser-runtime-presence";
import type { ProjectRow } from "./sqlite/projects";
import { listProjectsByStates } from "./sqlite/projects";
import type { ProjectStopStateRow } from "./sqlite/stop-policy";
import {
  getProjectStopState,
  noteProjectBrowserActivity,
} from "./sqlite/stop-policy";

const logger = getLogger("project-host:browser-runtime");
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const STOP_CONCURRENCY = 4;

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function browserIdleTimeoutSeconds(run_quota: unknown): number {
  if (run_quota == null || typeof run_quota !== "object") return 0;
  const value = Number(
    (run_quota as Record<string, unknown>).browser_idle_timeout,
  );
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function browserIdleStopDeadline({
  project,
  stopState,
}: {
  project: ProjectRow;
  stopState?: ProjectStopStateRow;
}): number | undefined {
  if (project.state !== "running" || project.exam_run_id) return;
  const timeoutSeconds = browserIdleTimeoutSeconds(project.run_quota);
  if (timeoutSeconds <= 0) return;
  const activityTimes = [
    project.state_updated_at,
    stopState?.last_started_ms,
    stopState?.last_browser_activity_ms,
  ].filter(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  if (activityTimes.length === 0) return;
  return Math.max(...activityTimes) + timeoutSeconds * 1_000;
}

export function startBrowserRuntimePresenceService({
  client,
}: {
  client: ConatClient;
}): () => void {
  let closed = false;
  let subscription: { close: () => void } | undefined;
  void (async () => {
    try {
      subscription = await client.subscribe(BROWSER_RUNTIME_PRESENCE_WILDCARD);
      for await (const message of subscription as any) {
        if (closed) break;
        const parsed = parseBrowserRuntimePresenceSubject(message.subject);
        if (!parsed) continue;
        // Host receipt time is authoritative; browser clocks and payloads are
        // intentionally ignored.
        noteProjectBrowserActivity(parsed.project_id);
      }
    } catch (err) {
      if (!closed) {
        logger.warn("browser runtime presence subscription failed", {
          err: `${err}`,
        });
      }
    }
  })();
  return () => {
    closed = true;
    subscription?.close();
  };
}

export function startBrowserIdleStopMaintenance({
  stopProject,
  interval_ms = positiveIntegerEnv(
    "COCALC_PROJECT_HOST_BROWSER_IDLE_SWEEP_INTERVAL_MS",
    DEFAULT_SWEEP_INTERVAL_MS,
  ),
  now = Date.now,
}: {
  stopProject: (project_id: string) => Promise<void>;
  interval_ms?: number;
  now?: () => number;
}): () => void {
  let closed = false;
  let sweepRunning = false;
  const stopping = new Set<string>();

  const sweep = async () => {
    if (closed || sweepRunning) return;
    sweepRunning = true;
    try {
      const sweepNow = now();
      const due = listProjectsByStates(["running"]).flatMap((project) => {
        const deadline = browserIdleStopDeadline({
          project,
          stopState: getProjectStopState(project.project_id),
        });
        return deadline != null && deadline <= sweepNow
          ? [{ project, deadline }]
          : [];
      });
      let next = 0;
      const worker = async () => {
        while (!closed) {
          const item = due[next++];
          if (!item) return;
          const { project, deadline } = item;
          if (stopping.has(project.project_id)) continue;
          stopping.add(project.project_id);
          try {
            logger.info("stopping browser-idle project", {
              project_id: project.project_id,
              deadline: new Date(deadline).toISOString(),
              timeout_seconds: browserIdleTimeoutSeconds(project.run_quota),
            });
            await stopProject(project.project_id);
          } catch (err) {
            logger.warn("unable to stop browser-idle project", {
              project_id: project.project_id,
              err: `${err}`,
            });
          } finally {
            stopping.delete(project.project_id);
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(STOP_CONCURRENCY, due.length) }, worker),
      );
    } finally {
      sweepRunning = false;
    }
  };

  const timer = setInterval(() => void sweep(), interval_ms);
  timer.unref?.();
  void sweep();
  return () => {
    closed = true;
    clearInterval(timer);
  };
}
