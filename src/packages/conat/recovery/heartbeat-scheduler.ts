import { EventEmitter } from "events";

const DEFAULT_MAX_CONCURRENT_HEARTBEATS = 1;

export interface HeartbeatSchedulerOptions {
  canRun: () => boolean;
  maxConcurrentHeartbeats?: number;
}

export interface HeartbeatProbeOptions {
  canPing: () => boolean;
  nextDueAt: () => number | undefined;
  ping: () => Promise<void>;
  onPingSuccess?: () => void;
  onPingFailure?: (err: unknown) => void;
}

export interface RegisteredHeartbeatProbe {
  schedule: () => void;
  close: () => void;
}

interface HeartbeatProbeEntry {
  options: HeartbeatProbeOptions;
}

export class HeartbeatScheduler extends EventEmitter {
  private readonly probes = new Map<string, HeartbeatProbeEntry>();
  private nextProbeId = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private pingsInFlight = 0;

  constructor(private readonly options: HeartbeatSchedulerOptions) {
    super();
  }

  close = () => {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.probes.clear();
    this.removeAllListeners();
  };

  registerProbe = (
    options: HeartbeatProbeOptions,
  ): RegisteredHeartbeatProbe => {
    const id = `heartbeat-${this.nextProbeId++}`;
    const probe: HeartbeatProbeEntry = { options };
    this.probes.set(id, probe);
    return {
      schedule: () => {
        this.scheduleDueProbes();
      },
      close: () => {
        this.probes.delete(id);
        this.scheduleDueProbes();
      },
    };
  };

  private scheduleDueProbes = () => {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.options.canRun()) {
      return;
    }
    if (
      this.pingsInFlight >=
      (this.options.maxConcurrentHeartbeats ??
        DEFAULT_MAX_CONCURRENT_HEARTBEATS)
    ) {
      return;
    }
    const nextProbe = this.pickNextProbe();
    if (nextProbe == null) {
      return;
    }
    const delay = Math.max(
      0,
      (nextProbe.options.nextDueAt() ?? 0) - Date.now(),
    );
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.runDueProbes();
    }, delay);
    this.timer.unref?.();
  };

  private runDueProbes = async () => {
    if (!this.options.canRun()) {
      return;
    }
    while (
      this.pingsInFlight <
      (this.options.maxConcurrentHeartbeats ??
        DEFAULT_MAX_CONCURRENT_HEARTBEATS)
    ) {
      const probe = this.pickNextProbe();
      if (probe == null) {
        break;
      }
      const dueAt = probe.options.nextDueAt();
      if (dueAt == null || dueAt > Date.now()) {
        break;
      }
      void this.runOneProbe(probe);
    }
    this.scheduleDueProbes();
  };

  private runOneProbe = async (probe: HeartbeatProbeEntry) => {
    this.pingsInFlight += 1;
    try {
      await probe.options.ping();
      probe.options.onPingSuccess?.();
    } catch (err) {
      probe.options.onPingFailure?.(err);
    } finally {
      this.pingsInFlight = Math.max(0, this.pingsInFlight - 1);
      this.scheduleDueProbes();
    }
  };

  private pickNextProbe = () => {
    const probes = Array.from(this.probes.values()).filter((probe) => {
      if (!probe.options.canPing()) {
        return false;
      }
      return probe.options.nextDueAt() != null;
    });
    probes.sort((left, right) => {
      const leftDue = left.options.nextDueAt() ?? Number.POSITIVE_INFINITY;
      const rightDue = right.options.nextDueAt() ?? Number.POSITIVE_INFINITY;
      return leftDue - rightDue;
    });
    return probes[0];
  };
}
