/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A running project keeps the project code (bundle) and the tools (cocalc
// CLI, codex, Claude Code, ...) it started with. When its host has newer ones,
// a restart is recommended; below the site's minimum project version it is
// required. Projects are never restarted automatically.

import { type CSSProperties, useEffect, useState } from "react";

import {
  useActions,
  useProjectMapField,
  useTypedRedux,
} from "@cocalc/frontend/app-framework";
import {
  UpdatePill,
  type UpdateLevel,
  versionTime,
} from "@cocalc/frontend/app/update-indicator";
import { useHostInfo } from "@cocalc/frontend/projects/host-info";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { useProjectState } from "./project-state-hook";

const CHECK_INTERVAL_MS = 5 * 60 * 1000;
// After a restart, a browser can still hold the previous run's versions for
// about half a minute, until the new project reports its own. Showing the pill
// then makes it look as if the update did nothing, and invites more restarts.
// Two upgrades within this window are very unlikely.
export const UPDATE_QUIET_MS = 3 * 60 * 1000;

// When this browser last asked each project to restart for an update.
const restartRequestedAt = new Map<string, number>();

function timeMs(value: unknown): number | undefined {
  if (value == null || value === "") return undefined;
  const ms = new Date(value as string | number | Date).valueOf();
  return Number.isFinite(ms) ? ms : undefined;
}

/** Until when to hide the update pill after a restart was requested or began. */
export function updateQuietUntil({
  requestedAt,
  startedAt,
}: {
  requestedAt?: number;
  startedAt?: unknown;
}): number {
  return Math.max(
    (requestedAt ?? -Infinity) + UPDATE_QUIET_MS,
    (timeMs(startedAt) ?? -Infinity) + UPDATE_QUIET_MS,
  );
}

interface LiveProjectStatus {
  state?: string;
  project_bundle_version?: string;
  tools_version?: string;
}

function versionString(value: unknown): string | undefined {
  const s = `${value ?? ""}`.trim();
  return s || undefined;
}

export interface ProjectUpdateStatus {
  level: UpdateLevel;
  // What is newer on the host: "project code" and/or "tools".
  parts: string[];
  since?: number;
}

/**
 * Compare what a running project uses with what its host has now.
 * `minProject` is the site's required project version, in seconds like the
 * browser versions; 0 means none.
 */
export function projectUpdateStatus({
  runningBundle,
  runningTools,
  hostBundle,
  hostTools,
  minProject = 0,
}: {
  runningBundle?: string;
  runningTools?: string;
  hostBundle?: string;
  hostTools?: string;
  minProject?: number;
}): ProjectUpdateStatus | undefined {
  const parts: string[] = [];
  const since: number[] = [];
  for (const [part, running, host] of [
    ["project code", runningBundle, hostBundle],
    ["tools", runningTools, hostTools],
  ] as const) {
    if (running == null || host == null || running === host) continue;
    const runningTime = versionTime(running);
    const hostTime = versionTime(host);
    // A host rolled back to older software is no reason to restart.
    if (runningTime != null && hostTime != null && hostTime < runningTime)
      continue;
    parts.push(part);
    if (hostTime != null) since.push(hostTime);
  }
  // Required only when a restart actually brings newer project code: a
  // bundle built just before the minimum was set must not stay red forever.
  const bundleTime = versionTime(runningBundle);
  const required =
    minProject > 0 &&
    bundleTime != null &&
    bundleTime < minProject * 1000 &&
    parts.includes("project code");
  if (!required && parts.length === 0) return undefined;
  return {
    level: required ? "required" : "recommended",
    parts,
    ...(since.length ? { since: Math.min(...since) } : {}),
  };
}

/** Whether a project should restart; also for features that need it. */
export function useProjectUpdate(project_id: string): {
  status?: ProjectUpdateStatus;
  restart: () => void;
} {
  const actions = useActions("projects");
  const projectState = useProjectState(project_id);
  const host_id = useProjectMapField<string>(project_id, "host_id");
  const publicDirectoryShareProjection = !!useProjectMapField<boolean>(
    project_id,
    "public_directory_share_projection",
  );
  const hostInfo = useHostInfo(host_id);
  const minProject = useTypedRedux("customize", "version_min_project") ?? 0;
  const [liveStatus, setLiveStatus] = useState<LiveProjectStatus>();
  const [, setTick] = useState(0);

  // The project's own state record is live; liveStatus is a periodic fetch
  // that is only a fallback for versions and must never outlive its run.
  const state = `${projectState?.get?.("state") ?? ""}`;
  const run = `${state}:${projectState?.get?.("started_at") ?? ""}:${
    projectState?.get?.("runtime_generation") ?? ""
  }`;

  useEffect(() => {
    setLiveStatus(undefined);
    if (publicDirectoryShareProjection) return;
    if (state !== "running") return;
    let closed = false;
    const refresh = async () => {
      try {
        if (host_id) {
          await actions?.ensure_host_info?.(host_id, true);
        }
        const status = await webapp_client.conat_client.hub.projects.status?.({
          project_id,
        });
        if (!closed) {
          setLiveStatus(status);
        }
      } catch {
        // Missing update metadata should not interrupt normal project use.
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), CHECK_INTERVAL_MS);
    return () => {
      closed = true;
      clearInterval(interval);
    };
  }, [actions, host_id, project_id, publicDirectoryShareProjection, run]);

  const quietUntil = updateQuietUntil({
    requestedAt: restartRequestedAt.get(project_id),
    startedAt: projectState?.get?.("started_at"),
  });
  const quietMs = quietUntil - Date.now();
  useEffect(() => {
    if (!(quietMs > 0)) return;
    // Re-check once the quiet period ends.
    const timer = setTimeout(() => setTick((n) => n + 1), quietMs + 100);
    return () => clearTimeout(timer);
  }, [quietUntil]);

  const restart = () => {
    restartRequestedAt.set(project_id, Date.now());
    setTick((n) => n + 1);
    void actions?.restart_project(project_id);
  };
  if (publicDirectoryShareProjection || state !== "running" || quietMs > 0)
    return { restart };
  return {
    status: projectUpdateStatus({
      runningBundle:
        versionString(projectState?.get?.("project_bundle_version")) ??
        versionString(liveStatus?.project_bundle_version),
      runningTools:
        versionString(projectState?.get?.("tools_version")) ??
        versionString(liveStatus?.tools_version),
      hostBundle: versionString(hostInfo?.get?.("project_bundle_version")),
      hostTools: versionString(hostInfo?.get?.("tools_version")),
      minProject: Number(minProject) || 0,
    }),
    restart,
  };
}

export function ProjectUpdateIndicator({
  project_id,
  style,
}: {
  project_id: string;
  style?: CSSProperties;
}) {
  const { status, restart } = useProjectUpdate(project_id);
  if (!status) return null;
  const required = status.level === "required";
  const what = status.parts.join(" and ");
  return (
    <span style={{ display: "inline-flex", flex: "0 0 auto", ...style }}>
      <UpdatePill
        level={status.level}
        since={status.since}
        label={required ? "Update required" : "Update"}
        description={
          required
            ? `This project runs ${what} that is no longer supported. Updating restarts the project; running kernels, terminals and agent turns stop.`
            : `Newer ${what} ${status.parts.length > 1 ? "are" : "is"} available. Updating restarts the project; running kernels, terminals and agent turns stop.`
        }
        actionLabel="Update project"
        onAction={restart}
      />
    </span>
  );
}

export default function ProjectVersionUpdate({
  project_id,
}: {
  project_id: string;
}) {
  return (
    <ProjectUpdateIndicator
      project_id={project_id}
      style={{ margin: "3px 6px 0 0" }}
    />
  );
}
