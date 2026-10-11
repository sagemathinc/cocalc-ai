/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Time on the computer. Plan: src/.agents/computers-plan-2026-10-11.md
// ("The daemon's checks", item 8; "Policy and time").
//
// - The session deadline is local: the daemon counts elapsed time from
//   pairing, and nothing the hub signs can push it past max_duration.
// - Elapsed time is the LARGER of two clocks: wall time and a monotonic
//   clock that counts suspend where we can read one (Linux /proc/uptime is
//   boot time). Setting the wall clock back doesn't help (the monotonic clock
//   still runs) and neither does sleeping (the wall clock still runs).
// - A time-limited computer keeps its key in memory only, so the session
//   never outlives the daemon process; nothing here is persisted.

import { readFileSync } from "node:fs";

export interface Clocks {
  /** Wall clock, ms since the epoch. */
  wall(): number;
  /** Monotonic ms from an arbitrary origin; counts suspend if it can. */
  continuous(): number;
}

function linuxBootTimeMs(): number | undefined {
  try {
    const uptime = Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
    return Number.isFinite(uptime) ? uptime * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export const systemClocks: Clocks = {
  wall: () => Date.now(),
  continuous: () => {
    if (process.platform === "linux") {
      const boot = linuxBootTimeMs();
      if (boot != null) return boot;
    }
    return Number(process.hrtime.bigint() / 1_000_000n);
  },
};

/**
 * The session's time limit, from the moment of pairing. `deadline_ms` and
 * `max_ms` are durations from the anchor; null means no limit.
 */
export class SessionClock {
  private readonly anchorWall: number;
  private readonly anchorContinuous: number;
  private deadlineMs: number | null;
  private readonly maxMs: number | null;

  constructor(
    private readonly clocks: Clocks,
    limits: { deadline_ms: number | null; max_ms: number | null },
  ) {
    this.anchorWall = clocks.wall();
    this.anchorContinuous = clocks.continuous();
    this.maxMs = limits.max_ms;
    this.deadlineMs =
      limits.deadline_ms == null || limits.max_ms == null
        ? limits.deadline_ms
        : Math.min(limits.deadline_ms, limits.max_ms);
  }

  /** Time since pairing: the larger of the two clocks, never negative. */
  elapsedMs(): number {
    const wall = this.clocks.wall() - this.anchorWall;
    const continuous = this.clocks.continuous() - this.anchorContinuous;
    return Math.max(0, wall, continuous);
  }

  /** ms left, or null without a limit. */
  remainingMs(): number | null {
    if (this.deadlineMs == null) return null;
    return Math.max(0, this.deadlineMs - this.elapsedMs());
  }

  ended(): boolean {
    return this.remainingMs() === 0;
  }

  /**
   * Move the deadline (the owner extended the session). It never goes past
   * max_duration, and never moves earlier than now.
   */
  extendTo(deadline_ms: number): number | null {
    if (this.deadlineMs == null) return null;
    const capped =
      this.maxMs == null ? deadline_ms : Math.min(deadline_ms, this.maxMs);
    this.deadlineMs = Math.max(this.deadlineMs, capped);
    return this.remainingMs();
  }
}

/**
 * The daemon's estimate of hub time: local wall time plus an offset measured
 * when it connects. Between connections the offset may move only a little,
 * so a hub (or a network attacker) can't swing the start-by window.
 */
export class HubClock {
  private offsetMs: number | null = null;

  constructor(
    private readonly clocks: Clocks,
    private readonly maxDriftMs = 2 * 60 * 1000,
  ) {}

  /**
   * Record a measured offset (hub time minus local time). The first one is
   * taken as is; later ones are refused if they move more than the bound.
   */
  observe(offsetMs: number): boolean {
    if (!Number.isFinite(offsetMs)) return false;
    if (this.offsetMs == null) {
      this.offsetMs = offsetMs;
      return true;
    }
    if (Math.abs(offsetMs - this.offsetMs) > this.maxDriftMs) return false;
    this.offsetMs = offsetMs;
    return true;
  }

  /** Hub time now, or undefined before the first measurement. */
  now(): number | undefined {
    if (this.offsetMs == null) return undefined;
    return this.clocks.wall() + this.offsetMs;
  }
}
