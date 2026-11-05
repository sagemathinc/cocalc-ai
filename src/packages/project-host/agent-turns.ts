/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Which projects on this host have an agent turn running, from the turn
// leases the ACP worker writes and heartbeats every 2 s (acp_turns in this
// host's acp.sqlite, see lite/hub/sqlite/acp-turns.ts). The pressure
// controller, browser-idle maintenance and the last_edited activity touch all
// read through here, so they agree on what "running" means.
//
// William, 2026-11-04: "We should never stop a project with an agent turn
// running." There is no age limit (2026-11-05: "No time limit"): a lease
// protects its project for as long as it heartbeats, and stops protecting it
// AGENT_TURN_LEASE_FRESH_MS after its last heartbeat (the turn ended, or the
// worker died). Each lease is checked on its own; a project is protected if
// any of its leases is.

import getLogger from "@cocalc/backend/logger";
import {
  listAcpTurnLeasesForProtection,
  type AcpTurnLeaseRow,
} from "@cocalc/lite/hub/sqlite/acp-turns";
import { isValidUUID } from "@cocalc/util/misc";

const logger = getLogger("project-host:agent-turns");

function integerEnv(name: string, fallback: number, minimum: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= minimum ? value : fallback;
}

export const AGENT_TURN_LEASE_FRESH_MS = integerEnv(
  "COCALC_PROJECT_HOST_AGENT_TURN_LEASE_FRESH_MS",
  120_000,
  1,
);
// Optional cap on how many projects one host protects at once (the newest
// turns are kept). 0, the default, means no cap.
export const AGENT_TURN_PROTECT_MAX_PROJECTS = integerEnv(
  "COCALC_PROJECT_HOST_AGENT_TURN_PROTECT_MAX_PROJECTS",
  0,
  0,
);

export interface AgentTurnProject {
  // The newest start among the project's eligible leases.
  started_at: number;
  leases: number;
}

export interface AgentTurnSnapshot {
  ok: true;
  projects: Map<string, AgentTurnProject>;
  // Projects whose turns ended in (ended_after, now]; only when asked for.
  ended: Set<string>;
  // Where the next ended_after cursor should be.
  ended_cursor: number;
  // Rows ignored as malformed (bad project id, impossible times).
  invalid: number;
}

export type AgentTurnRead = AgentTurnSnapshot | { ok: false };

function projectId(value: unknown): string | undefined {
  const id = `${value ?? ""}`.trim().toLowerCase();
  return isValidUUID(id) ? id : undefined;
}

function time(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export function activeAgentTurnProjects(
  rows: AcpTurnLeaseRow[],
  {
    now,
    freshMs = AGENT_TURN_LEASE_FRESH_MS,
    maxProjects = AGENT_TURN_PROTECT_MAX_PROJECTS,
  }: { now: number; freshMs?: number; maxProjects?: number },
): { projects: Map<string, AgentTurnProject>; invalid: number } {
  const projects = new Map<string, AgentTurnProject>();
  let invalid = 0;
  for (const row of rows) {
    if (row?.state !== "running") continue;
    const heartbeat = time(row.heartbeat_at);
    if (heartbeat == null || heartbeat < now - freshMs) continue;
    const started = time(row.started_at);
    const project_id = projectId(row.project_id);
    if (
      heartbeat > now ||
      started == null ||
      started > heartbeat ||
      project_id == null
    ) {
      invalid += 1;
      continue;
    }
    const existing = projects.get(project_id);
    projects.set(project_id, {
      started_at: Math.max(existing?.started_at ?? 0, started),
      leases: (existing?.leases ?? 0) + 1,
    });
  }
  if (maxProjects > 0 && projects.size > maxProjects) {
    const kept = [...projects]
      .sort(
        ([a, left], [b, right]) =>
          right.started_at - left.started_at || a.localeCompare(b),
      )
      .slice(0, maxProjects);
    return { projects: new Map(kept), invalid };
  }
  return { projects, invalid };
}

export function endedAgentTurnProjects(
  rows: AcpTurnLeaseRow[],
  { now, endedAfter }: { now: number; endedAfter: number },
): { projects: Set<string>; invalid: number } {
  const projects = new Set<string>();
  let invalid = 0;
  for (const row of rows) {
    if (row?.state === "running") continue;
    const ended = time(row.ended_at);
    const started = time(row.started_at);
    const project_id = projectId(row.project_id);
    if (
      ended == null ||
      ended > now ||
      ended <= endedAfter ||
      started == null ||
      ended < started ||
      project_id == null
    ) {
      invalid += 1;
      continue;
    }
    projects.add(project_id);
  }
  return { projects, invalid };
}

/**
 * One consistent read. With endedAfter, also the projects whose turns ended
 * since then and the next cursor (now, or the last row's ended_at if the read
 * was truncated). Any failure is { ok: false }: callers must not treat it as
 * "no turns".
 */
export function readAgentTurns({
  now = Date.now(),
  endedAfter,
  list = listAcpTurnLeasesForProtection,
}: {
  now?: number;
  endedAfter?: number;
  list?: typeof listAcpTurnLeasesForProtection;
} = {}): AgentTurnRead {
  try {
    const rows = list({
      now,
      heartbeat_since: now - AGENT_TURN_LEASE_FRESH_MS,
      ended_after: endedAfter,
    });
    const active = activeAgentTurnProjects(rows.running, { now });
    const ended =
      endedAfter == null
        ? { projects: new Set<string>(), invalid: 0 }
        : endedAgentTurnProjects(rows.ended, { now, endedAfter });
    const last = rows.ended.at(-1);
    const lastEnded = time(last?.ended_at);
    return {
      ok: true,
      projects: active.projects,
      ended: ended.projects,
      ended_cursor:
        rows.ended_truncated && lastEnded != null && lastEnded <= now
          ? lastEnded
          : now,
      invalid: active.invalid + ended.invalid,
    };
  } catch (err) {
    logger.warn("unable to read agent turn leases", { err: `${err}` });
    return { ok: false };
  }
}
