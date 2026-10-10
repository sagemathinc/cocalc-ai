/*
 *  This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 *  License: MS-RSL - see LICENSE.md for details
 */

// An agent's sensors, for its message box and Sensors dialog. Agents propose
// sensors from their own turns, so the list refreshes now and then while
// shown (every open message box polls, so keep it rare) and whenever the
// dialog opens.

import { useCallback, useEffect, useState } from "react";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { AgentSensor } from "@cocalc/conat/agents/sensors";
import { personalAgentApi } from "./api";

const REFRESH_MS = 5 * 60_000;

export function useAgentSensors(
  agent: NamedAgent | undefined,
  { enabled = true }: { enabled?: boolean } = {},
) {
  const [sensors, setSensors] = useState<AgentSensor[]>();
  const [error, setError] = useState("");
  const project_id = agent?.endpoint.project_id;
  const agent_id = agent?.endpoint.agent_id;
  const refresh = useCallback(async () => {
    if (!project_id || !agent_id) return;
    try {
      const result = await personalAgentApi().listSensors({
        project_id,
        agent_id,
      });
      setSensors(result.sensors);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : `${err}`);
    }
  }, [project_id, agent_id]);
  useEffect(() => {
    if (!enabled || !project_id || !agent_id) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [enabled, refresh]);
  return { sensors, error, refresh };
}

/** "2 active, 1 to review" for menus and labels. */
export function sensorsSummary(sensors: AgentSensor[] | undefined): string {
  if (!sensors) return "";
  if (sensors.length === 0) return "None";
  const active = sensors.filter((s) => s.status === "active").length;
  const review = sensors.filter((s) => s.pending_spec != null).length;
  const paused = sensors.filter((s) => s.status === "paused").length;
  return (
    [
      active ? `${active} active` : "",
      review ? `${review} to review` : "",
      paused ? `${paused} paused` : "",
    ]
      .filter(Boolean)
      .join(", ") || `${sensors.length} inactive`
  );
}
