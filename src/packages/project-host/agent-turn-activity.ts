/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Keeps last_edited current while an agent turn runs. William, 2026-11-04:
// "It's just a bug that it isn't updating the "last edited" time."
//
// Every scan reads the turn leases (agent-turns.ts) once. For each project
// with a running turn it moves last_edited at most every UPDATE_MS, and
// queues the project's summary event (so collaborators' project lists see the
// new time) when the turn is first seen, at most every SUMMARY_MS while it
// runs, and once more when no running turn is left. A turn that started and
// ended between two scans is found in the leases that ended since the
// previous scan. These touches move last_edited only: never last_changed
// (backups) or last_active (see hosts.touchProjectActivity).

import getLogger from "@cocalc/backend/logger";
import { readAgentTurns, type AgentTurnRead } from "./agent-turns";
import { touchProjectActivity } from "./last-edited";

const logger = getLogger("project-host:agent-turn-activity");

export const AGENT_TURN_ACTIVITY = {
  scanMs: 60_000,
  updateMs: 5 * 60_000,
  summaryMs: 30 * 60_000,
};

interface Episode {
  updatedAt: number;
  summaryAt: number;
}

export class AgentTurnActivity {
  // Projects with a running turn as of the last accepted scan.
  private episodes = new Map<string, Episode>();
  // Leases that ended after this were already looked at.
  private endedCursor: number;
  readFailures = 0;

  constructor(
    private readonly opts: {
      now: () => number;
      read: (opts: { now: number; endedAfter: number }) => AgentTurnRead;
      touch: (project_id: string, opts: { summary: boolean }) => void;
      updateMs: number;
      summaryMs: number;
      scanMs: number;
    },
  ) {
    this.endedCursor = opts.now() - opts.scanMs;
  }

  scan(): void {
    const now = this.opts.now();
    const read = this.opts.read({ now, endedAfter: this.endedCursor });
    if (!read.ok) {
      // Nothing is touched and the cursor stays: the next good scan still
      // sees every turn that ended meanwhile.
      this.readFailures += 1;
      return;
    }
    for (const project_id of read.projects.keys()) {
      const episode = this.episodes.get(project_id);
      if (episode == null) {
        this.opts.touch(project_id, { summary: true });
        this.episodes.set(project_id, { updatedAt: now, summaryAt: now });
        continue;
      }
      const summary = now - episode.summaryAt >= this.opts.summaryMs;
      if (summary || now - episode.updatedAt >= this.opts.updateMs) {
        this.opts.touch(project_id, { summary });
        episode.updatedAt = now;
        if (summary) episode.summaryAt = now;
      }
    }
    // One final touch with the summary for each project with no running turn
    // left: those seen running before, and those whose short turn ended
    // between scans. Several ended leases of one project give one touch, and
    // a project with another turn still running gets none.
    const finished = new Set<string>();
    for (const project_id of this.episodes.keys()) {
      if (!read.projects.has(project_id)) finished.add(project_id);
    }
    for (const project_id of read.ended) {
      if (!read.projects.has(project_id)) finished.add(project_id);
    }
    for (const project_id of finished) {
      this.opts.touch(project_id, { summary: true });
      this.episodes.delete(project_id);
    }
    this.endedCursor = read.ended_cursor;
  }

  activeCount(): number {
    return this.episodes.size;
  }

  clear(): void {
    this.episodes.clear();
  }
}

export function startAgentTurnActivity({
  now = Date.now,
  read = readAgentTurns,
  touch = touchProjectActivity,
  updateMs = AGENT_TURN_ACTIVITY.updateMs,
  summaryMs = AGENT_TURN_ACTIVITY.summaryMs,
  scanMs = AGENT_TURN_ACTIVITY.scanMs,
}: {
  now?: () => number;
  read?: (opts: { now: number; endedAfter: number }) => AgentTurnRead;
  touch?: (project_id: string, opts: { summary: boolean }) => void;
  updateMs?: number;
  summaryMs?: number;
  scanMs?: number;
} = {}): { stop: () => void } {
  const activity = new AgentTurnActivity({
    now,
    read,
    touch,
    updateMs,
    summaryMs,
    scanMs,
  });
  const scan = () => {
    try {
      activity.scan();
    } catch (err) {
      logger.warn("agent turn activity scan failed", { err: `${err}` });
    }
  };
  const timer = setInterval(scan, scanMs);
  timer.unref?.();
  scan();
  return {
    stop: () => {
      clearInterval(timer);
      activity.clear();
    },
  };
}
