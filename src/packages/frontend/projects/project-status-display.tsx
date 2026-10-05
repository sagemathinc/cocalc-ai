/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// How a project's state reads in the agent and project headers: a word, a
// colored dot, and "Restarting…" for the whole of a restart.

import { useEffect, useState } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";

export function projectStatusLabel(state?: string, network?: unknown): string {
  if (network === false || network === 0) return "Internet access blocked";
  switch (state) {
    case "running":
      return "Running";
    case "starting":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    case "opened":
    case "closed":
    case "stopped":
      return "Stopped";
    default:
      return state ? `Project ${state}` : "Status unknown";
  }
}

const RESTART_LABEL_MAX_MS = 5 * 60_000;

// A restart passes through stopping, stopped and starting (and is shown as
// "starting" before it even stops). Say "Restarting…" for all of it: from the
// request until the project runs again with a new start time.
export function useRestarting(
  projectId: string,
  state: string | undefined,
  startedAt: string | undefined,
): boolean {
  const request = useTypedRedux({ project_id: projectId }, "restart_request");
  const token = request?.get?.("token") as string | undefined;
  const [restart, setRestart] = useState<{
    token: string;
    startedAt?: string;
    at: number;
  }>();
  useEffect(() => {
    if (token && token !== restart?.token) {
      setRestart({ token, startedAt, at: Date.now() });
    }
  }, [token]);
  useEffect(() => {
    if (!restart) return;
    if (state === "running" && startedAt !== restart.startedAt) {
      setRestart(undefined);
      return;
    }
    const timer = setTimeout(
      () => setRestart(undefined),
      Math.max(0, restart.at + RESTART_LABEL_MAX_MS - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [restart, state, startedAt]);
  return restart != null;
}

// A dot in the header says what the words used to: green running, amber
// changing, grey stopped, red blocked. The words stay in the tooltip.
export function projectStatusColor(
  state?: string,
  network?: unknown,
  blocked?: boolean,
): string {
  if (blocked || network === false || network === 0) return "#cf1322";
  switch (state) {
    case "running":
      return "#52c41a";
    case "starting":
    case "stopping":
      return "#faad14";
    default:
      return "#8c8c8c";
  }
}
