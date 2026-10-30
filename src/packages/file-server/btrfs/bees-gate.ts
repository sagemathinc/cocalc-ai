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
import { refusedByStorageWrapper, sudo } from "./util";

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
  intervalMs?: number;
  config?: BeesGateConfig;
  now?: () => number;
  readInputs?: () => Promise<Omit<BeesGateInputs, "lifecycle_active">>;
  apply?: (action: BeesGateAction) => Promise<void>;
}

export class BeesGate {
  private state: BeesGateState;
  private timer?: NodeJS.Timeout;
  private ticking = false;
  private unsupported = false;
  private lastInputs?: BeesGateInputs;
  // commit samples within the window: [time, worst ms seen at that sample]
  private commitSamples: Array<[number, number]> = [];
  private lastCommits?: number;
  private readonly now: () => number;
  private readonly config: BeesGateConfig;

  constructor(private readonly opts: BeesGateOptions) {
    this.now = opts.now ?? Date.now;
    this.config = opts.config ?? DEFAULT_BEES_GATE_CONFIG;
    // Unknown until the first decision, which freezes unless BEES may run
    // (also bringing a cgroup left frozen or thawed by a restart in line).
    this.state = { frozen: false, since_ms: this.now(), reason: "startup" };
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
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  getStatus() {
    return {
      enabled: !this.unsupported,
      frozen: this.state.frozen,
      since: new Date(this.state.since_ms).toISOString(),
      reason: this.state.reason,
      inputs: this.lastInputs,
    };
  }

  async tick(): Promise<void> {
    if (this.ticking || this.unsupported) return;
    this.ticking = true;
    try {
      const inputs: BeesGateInputs = {
        ...(await (this.opts.readInputs ?? (() => this.readInputs()))()),
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
      if (refusedByStorageWrapper(err)) {
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

  private async readInputs(): Promise<
    Omit<BeesGateInputs, "lifecycle_active">
  > {
    const now = this.now();
    let free_fraction: number | undefined;
    try {
      const s = await statfs(this.opts.mount);
      free_fraction = s.blocks > 0 ? s.bavail / s.blocks : undefined;
    } catch {}
    let io: { avg10?: number; avg60?: number } = {};
    try {
      io = parseIoSomeAverages(await readFile("/proc/pressure/io", "utf8"));
    } catch {}
    let worst_commit_ms: number | undefined;
    if (this.opts.filesystemUuid) {
      try {
        const stats = parseCommitStats(
          await readFile(
            `/sys/fs/btrfs/${this.opts.filesystemUuid}/commit_stats`,
            "utf8",
          ),
        );
        // the commit running now, and the last one if it finished since
        let worst = stats.cur_commit_ms ?? 0;
        if (
          this.lastCommits != null &&
          stats.commits != null &&
          stats.commits > this.lastCommits
        ) {
          worst = Math.max(worst, stats.last_commit_ms ?? 0);
        }
        this.lastCommits = stats.commits;
        // keep about two ticks of samples
        const windowMs = 2 * (this.opts.intervalMs ?? 30_000);
        this.commitSamples = this.commitSamples.filter(
          ([at]) => now - at < windowMs,
        );
        this.commitSamples.push([now, worst]);
        worst_commit_ms = Math.max(...this.commitSamples.map(([, ms]) => ms));
      } catch {}
    }
    return {
      free_fraction,
      io_some_avg10: io.avg10,
      io_some_avg60: io.avg60,
      worst_commit_ms,
    };
  }
}
