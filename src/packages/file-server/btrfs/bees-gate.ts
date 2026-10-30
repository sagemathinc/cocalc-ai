/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
BEES (dedup) runs only while it is worth it and cheap.

Measured on prod los-angeles-1 (2026-10-30): with BEES running, btrfs
commits averaged 1.2 s (worst per minute typically 6 s, up to 48 s) and
every project waited on them; frozen for an hour, 0.4 s (worst about
0.3 s), while BEES had saved 2.3 GB on a disk with 361 GB free. So BEES is
frozen (cgroup freezer: it keeps its state, holds no lock, and the
supervisor does not see an exit) unless the disk is getting full and the
host is calm, and frozen again as soon as it is not.
*/

import { readFile, statfs } from "node:fs/promises";
import getLogger from "@cocalc/backend/logger";
import { sudo } from "./util";

const logger = getLogger("file-server:btrfs:bees-gate");

export interface BeesGateConfig {
  // Thaw only while less than this fraction of the filesystem is free...
  thawBelowFreeFraction: number;
  // ...and freeze again once more than this is free (hysteresis).
  freezeAboveFreeFraction: number;
  // Thaw only while io PSI "some" avg60 is below this (percent)...
  thawMaxIoSomeAvg60: number;
  // ...and freeze when avg10 goes above this.
  freezeIoSomeAvg10: number;
  // Thaw only if no btrfs commit in the last window took longer than this...
  thawMaxCommitMs: number;
  // ...and freeze when one does.
  freezeCommitMs: number;
  // Once frozen, stay frozen at least this long.
  minFrozenMs: number;
}

export const DEFAULT_BEES_GATE_CONFIG: BeesGateConfig = {
  thawBelowFreeFraction: 0.2,
  freezeAboveFreeFraction: 0.25,
  thawMaxIoSomeAvg60: 5,
  freezeIoSomeAvg10: 10,
  thawMaxCommitMs: 2_000,
  freezeCommitMs: 5_000,
  minFrozenMs: 10 * 60_000,
};

export interface BeesGateInputs {
  // undefined when unknown: then the gate keeps (or puts) BEES frozen
  free_fraction?: number;
  io_some_avg10?: number;
  io_some_avg60?: number;
  worst_commit_ms?: number;
  lifecycle_active: boolean;
}

export interface BeesGateState {
  frozen: boolean;
  since_ms: number;
  reason: string;
}

export function decideBeesGate(
  state: BeesGateState,
  inputs: BeesGateInputs,
  now: number,
  config: BeesGateConfig = DEFAULT_BEES_GATE_CONFIG,
): BeesGateState {
  const {
    free_fraction,
    io_some_avg10,
    io_some_avg60,
    worst_commit_ms,
    lifecycle_active,
  } = inputs;
  if (!state.frozen) {
    const reason = lifecycle_active
      ? "lifecycle_active"
      : io_some_avg10 == null || io_some_avg10 > config.freezeIoSomeAvg10
        ? "io_pressure"
        : worst_commit_ms == null || worst_commit_ms > config.freezeCommitMs
          ? "slow_commit"
          : free_fraction == null ||
              free_fraction > config.freezeAboveFreeFraction
            ? "enough_free_space"
            : undefined;
    return reason ? { frozen: true, since_ms: now, reason } : state;
  }
  const thaw =
    now - state.since_ms >= config.minFrozenMs &&
    !lifecycle_active &&
    free_fraction != null &&
    free_fraction < config.thawBelowFreeFraction &&
    io_some_avg60 != null &&
    io_some_avg60 < config.thawMaxIoSomeAvg60 &&
    worst_commit_ms != null &&
    worst_commit_ms < config.thawMaxCommitMs;
  return thaw
    ? { frozen: false, since_ms: now, reason: "low_free_space_and_calm" }
    : state;
}

export function parseIoSomeAverages(text: string): {
  avg10?: number;
  avg60?: number;
} {
  const line = text.split("\n").find((l) => l.startsWith("some "));
  const value = (key: string) => {
    const match = line?.match(new RegExp(`${key}=([0-9.]+)`));
    return match ? Number(match[1]) : undefined;
  };
  return { avg10: value("avg10"), avg60: value("avg60") };
}

export function parseCommitStats(text: string): {
  commits?: number;
  cur_commit_ms?: number;
  last_commit_ms?: number;
} {
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const [key, value] = line.trim().split(/\s+/);
    if (key && value != null && Number.isFinite(Number(value))) {
      out[key] = Number(value);
    }
  }
  return out;
}

// BEES modes (project-host env):
//   COCALC_DISABLE_BEES=yes  BEES is off; a BEES left over by an earlier daemon
//                            is stopped (bees.ts, filesystem.ts)
//   default                  BEES runs gated (this file)
//   COCALC_BEES_GATE=off     BEES runs ungated, as before the gate
export function beesGateEnabled(): boolean {
  const value = `${process.env.COCALC_BEES_GATE ?? ""}`.trim().toLowerCase();
  return !["0", "false", "no", "off"].includes(value);
}

export type BeesGateAction = "freeze" | "thaw" | "stop";

// The root helper freezes or thaws the BEES cgroup ("stop" kills what is in
// it and leaves it thawed, so a later BEES does not start frozen).
export async function applyBeesGateAction(
  mount: string,
  action: BeesGateAction,
): Promise<void> {
  await sudo({
    command: "bees-gate",
    args: [mount, action],
    verbose: false,
  });
}

export interface BeesGateOptions {
  mount: string;
  filesystemUuid?: string;
  lifecycleActive: () => boolean;
  // decisions (free space, io pressure, thawing)
  intervalMs?: number;
  // commit and lifecycle samples, which freeze a running BEES at once
  sampleMs?: number;
  config?: BeesGateConfig;
  now?: () => number;
  readInputs?: () => Promise<
    Omit<BeesGateInputs, "lifecycle_active" | "worst_commit_ms">
  >;
  readCommitStats?: () => Promise<string>;
  apply?: (action: BeesGateAction) => Promise<void>;
}

// Only this denial means an older root helper without "bees-gate"; any other
// failure (e.g. the BEES cgroup policy refusing a thaw) is retried.
function gateUnsupported(err: unknown): boolean {
  return /\bSECURITY_DENY code=unsupported-command\b/.test(
    `${(err as any)?.message ?? err}`,
  );
}

const COMMIT_WINDOW_MS = 60_000;

export class BeesGate {
  private state: BeesGateState;
  private timer?: NodeJS.Timeout;
  private sampleTimer?: NodeJS.Timeout;
  private ticking = false;
  private sampling = false;
  private unsupported = false;
  // Whether the cgroup is known to match this.state: false until a freeze
  // succeeds (a restart or handoff may have left it either way).
  private synced = false;
  private lastInputs?: BeesGateInputs;
  // [time, longest commit seen then (ms, a conservative bound)]
  private commitSamples: Array<[number, number]> = [];
  private lastCommits?: number;
  private readonly now: () => number;
  private readonly config: BeesGateConfig;
  private readonly sampleMs: number;

  constructor(private readonly opts: BeesGateOptions) {
    this.now = opts.now ?? Date.now;
    this.config = opts.config ?? DEFAULT_BEES_GATE_CONFIG;
    this.sampleMs = opts.sampleMs ?? 1_000;
    this.state = { frozen: true, since_ms: this.now(), reason: "startup" };
  }

  async start(): Promise<void> {
    logger.info("BEES gate started", {
      mount: this.opts.mount,
      config: this.config,
    });
    await this.tick();
    if (this.unsupported) return;
    this.timer = setInterval(
      () => void this.tick(),
      this.opts.intervalMs ?? 30_000,
    );
    this.timer.unref?.();
    this.sampleTimer = setInterval(() => void this.sample(), this.sampleMs);
    this.sampleTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.sampleTimer) clearInterval(this.sampleTimer);
    this.timer = this.sampleTimer = undefined;
  }

  getStatus() {
    return {
      enabled: !this.unsupported,
      applied: this.synced,
      frozen: this.state.frozen,
      since: new Date(this.state.since_ms).toISOString(),
      reason: this.state.reason,
      inputs: this.lastInputs,
    };
  }

  /** Between decisions: freeze a running BEES at once when a project starts
   * or stops or a commit runs long, rather than at the next decision. */
  async sample(): Promise<void> {
    // One at a time: under the I/O stalls this gate is for, a read can take
    // longer than the period (and then the samples go stale: unsafe).
    if (this.sampling) return;
    this.sampling = true;
    try {
      await this.sampleCommit();
      if (!this.synced || this.state.frozen) return;
      if (
        this.opts.lifecycleActive() ||
        (this.worstCommitMs() ?? Infinity) > this.config.freezeCommitMs
      ) {
        await this.tick();
      }
    } finally {
      this.sampling = false;
    }
  }

  async tick(): Promise<void> {
    if (this.ticking || this.unsupported) return;
    this.ticking = true;
    try {
      if (!this.synced) {
        // Freeze first, whatever the cgroup holds; the frozen period starts
        // when that succeeds.
        if (await this.apply("freeze")) {
          this.synced = true;
          this.state = {
            frozen: true,
            since_ms: this.now(),
            reason: "startup",
          };
          logger.info("BEES frozen", {
            mount: this.opts.mount,
            reason: "startup",
          });
        }
        return;
      }
      const inputs: BeesGateInputs = {
        ...(await (this.opts.readInputs ?? (() => this.readInputs()))()),
        worst_commit_ms: this.worstCommitMs(),
        lifecycle_active: this.opts.lifecycleActive(),
      };
      this.lastInputs = inputs;
      const next = decideBeesGate(this.state, inputs, this.now(), this.config);
      if (next.frozen === this.state.frozen) return;
      if (await this.apply(next.frozen ? "freeze" : "thaw")) {
        logger.info(next.frozen ? "BEES frozen" : "BEES thawed", {
          mount: this.opts.mount,
          reason: next.reason,
          inputs,
        });
        this.state = next;
      }
    } catch (err) {
      logger.warn("BEES gate tick failed", { err: `${err}` });
    } finally {
      this.ticking = false;
    }
  }

  private async apply(action: BeesGateAction): Promise<boolean> {
    try {
      await (
        this.opts.apply ?? ((a) => applyBeesGateAction(this.opts.mount, a))
      )(action);
      return true;
    } catch (err) {
      if (gateUnsupported(err)) {
        // An older root helper without "bees-gate": BEES runs as before.
        this.unsupported = true;
        this.stop();
        logger.warn("BEES gate unavailable; BEES runs ungated", {
          mount: this.opts.mount,
          action,
          err: `${err}`,
        });
      } else {
        // e.g. a sudo timeout under I/O pressure: the next tick retries
        logger.warn("BEES gate action failed; retrying", {
          mount: this.opts.mount,
          action,
          err: `${err}`,
        });
      }
      return false;
    }
  }

  // Sampled every second: a commit that lasts a second or more is seen while
  // it runs (cur_commit_ms, plus the sampling period to be safe), and the
  // last one when it ends; shorter ones are below every threshold.
  private async sampleCommit(): Promise<void> {
    const read =
      this.opts.readCommitStats ??
      (this.opts.filesystemUuid
        ? () =>
            readFile(
              `/sys/fs/btrfs/${this.opts.filesystemUuid}/commit_stats`,
              "utf8",
            )
        : undefined);
    if (!read) return;
    let worst: number;
    try {
      const stats = parseCommitStats(await read());
      worst = stats.cur_commit_ms ? stats.cur_commit_ms + this.sampleMs : 0;
      if (
        this.lastCommits != null &&
        stats.commits != null &&
        stats.commits > this.lastCommits
      ) {
        worst = Math.max(worst, stats.last_commit_ms ?? 0);
      }
      this.lastCommits = stats.commits;
    } catch {
      // A missed sample may hide a slow commit: unsafe for the whole window.
      worst = Infinity;
    }
    const now = this.now();
    this.commitSamples = this.commitSamples.filter(
      ([at]) => now - at < COMMIT_WINDOW_MS,
    );
    this.commitSamples.push([now, worst]);
  }

  // The longest commit in about the last minute; undefined (unsafe) without
  // samples covering it or once sampling falls behind (e.g. a hung read).
  private worstCommitMs(): number | undefined {
    const now = this.now();
    const recent = this.commitSamples.filter(
      ([at]) => now - at < COMMIT_WINDOW_MS,
    );
    const newest = recent[recent.length - 1]?.[0];
    if (newest == null || now - newest > 5 * this.sampleMs) return undefined;
    return Math.max(...recent.map(([, ms]) => ms));
  }

  private async readInputs(): Promise<
    Omit<BeesGateInputs, "lifecycle_active" | "worst_commit_ms">
  > {
    let free_fraction: number | undefined;
    try {
      const s = await statfs(this.opts.mount);
      free_fraction = s.blocks > 0 ? s.bavail / s.blocks : undefined;
    } catch {}
    let io: { avg10?: number; avg60?: number } = {};
    try {
      io = parseIoSomeAverages(await readFile("/proc/pressure/io", "utf8"));
    } catch {}
    return {
      free_fraction,
      io_some_avg10: io.avg10,
      io_some_avg60: io.avg60,
    };
  }
}
