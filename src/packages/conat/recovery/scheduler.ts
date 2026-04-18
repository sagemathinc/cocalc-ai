import { EventEmitter } from "events";

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_DELAY_DECAY = 1.8;
const DEFAULT_DELAY_JITTER = 0.25;
const DEFAULT_MAX_CONCURRENT_RECOVERIES = 1;

export type RecoveryPriority = "foreground" | "background";

export interface RecoveryRequest {
  reason?: string;
  resetBackoff?: boolean;
}

export interface RecoverableResourceOptions {
  canRecover?: () => boolean;
  isConnected?: () => boolean;
  priority?: () => RecoveryPriority;
  recover: () => Promise<void>;
}

export interface RegisteredRecoverableResource {
  requestRecovery: (request?: RecoveryRequest) => void;
  close: () => void;
}

export interface RecoverySchedulerOptions {
  canRun: () => boolean;
  isTransportReady: () => boolean;
  maxConcurrentRecoveries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  delayDecay?: number;
  delayJitter?: number;
}

interface PendingRecoverableResource {
  attempts: number;
  options: RecoverableResourceOptions;
  pendingAt?: number;
  pendingReason?: string;
  readyAt?: number;
}

export class RecoveryScheduler extends EventEmitter {
  private readonly resources = new Map<string, PendingRecoverableResource>();
  private nextResourceId = 0;
  private runTimer?: ReturnType<typeof setTimeout>;
  private recoveriesInFlight = 0;

  constructor(private readonly options: RecoverySchedulerOptions) {
    super();
  }

  close = () => {
    if (this.runTimer != null) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
    this.resources.clear();
    this.removeAllListeners();
  };

  noteTransportConnected = () => {
    this.schedulePendingRecoveries();
  };

  noteTransportDisconnected = () => {
    if (this.runTimer != null) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
  };

  registerResource = (
    options: RecoverableResourceOptions,
  ): RegisteredRecoverableResource => {
    const id = `recoverable-${this.nextResourceId++}`;
    const resource: PendingRecoverableResource = {
      attempts: 0,
      options,
    };
    this.resources.set(id, resource);
    return {
      requestRecovery: (request = {}) => {
        this.requestRecovery(resource, request);
      },
      close: () => {
        this.resources.delete(id);
        this.schedulePendingRecoveries();
      },
    };
  };

  private requestRecovery = (
    resource: PendingRecoverableResource,
    { reason = "recover", resetBackoff = false }: RecoveryRequest,
  ) => {
    if (resource.options.canRecover?.() === false) {
      return;
    }
    if (resetBackoff) {
      resource.attempts = 0;
    }
    const now = Date.now();
    const readyAt = now + this.computeDelay(resource);
    resource.pendingReason = reason;
    resource.pendingAt ??= now;
    resource.readyAt =
      resource.readyAt == null ? readyAt : Math.min(resource.readyAt, readyAt);
    this.schedulePendingRecoveries();
  };

  private schedulePendingRecoveries = () => {
    if (this.runTimer != null) {
      clearTimeout(this.runTimer);
      this.runTimer = undefined;
    }
    if (!this.options.canRun() || !this.options.isTransportReady()) {
      return;
    }
    if (
      this.recoveriesInFlight >=
      (this.options.maxConcurrentRecoveries ??
        DEFAULT_MAX_CONCURRENT_RECOVERIES)
    ) {
      return;
    }
    const next = this.pickNextPendingResource();
    if (!next) {
      return;
    }
    const delay = Math.max(0, (next.readyAt ?? 0) - Date.now());
    this.runTimer = setTimeout(() => {
      this.runTimer = undefined;
      void this.runPendingRecoveries();
    }, delay);
    this.runTimer.unref?.();
  };

  private runPendingRecoveries = async () => {
    if (!this.options.canRun() || !this.options.isTransportReady()) {
      return;
    }
    while (
      this.recoveriesInFlight <
      (this.options.maxConcurrentRecoveries ??
        DEFAULT_MAX_CONCURRENT_RECOVERIES)
    ) {
      const resource = this.pickNextPendingResource();
      if (!resource || resource.readyAt == null) {
        break;
      }
      if (resource.readyAt > Date.now()) {
        break;
      }
      void this.runOneRecovery(resource);
    }
    this.schedulePendingRecoveries();
  };

  private runOneRecovery = async (resource: PendingRecoverableResource) => {
    this.recoveriesInFlight += 1;
    resource.readyAt = undefined;
    try {
      await resource.options.recover();
      resource.pendingAt = undefined;
      resource.pendingReason = undefined;
      resource.attempts = 0;
    } catch {
      resource.attempts += 1;
      resource.readyAt = Date.now() + this.computeDelay(resource);
    } finally {
      this.recoveriesInFlight = Math.max(0, this.recoveriesInFlight - 1);
      this.schedulePendingRecoveries();
    }
  };

  private pickNextPendingResource = () => {
    const resources = Array.from(this.resources.values()).filter((resource) => {
      if (resource.readyAt == null) {
        return false;
      }
      if (resource.options.canRecover?.() === false) {
        return false;
      }
      if (resource.options.isConnected?.()) {
        resource.readyAt = undefined;
        resource.pendingAt = undefined;
        resource.pendingReason = undefined;
        resource.attempts = 0;
        return false;
      }
      return true;
    });
    resources.sort((left, right) => {
      const leftPriority = this.priorityWeight(left);
      const rightPriority = this.priorityWeight(right);
      if (leftPriority !== rightPriority) {
        return rightPriority - leftPriority;
      }
      const leftReady = left.readyAt ?? Number.POSITIVE_INFINITY;
      const rightReady = right.readyAt ?? Number.POSITIVE_INFINITY;
      if (leftReady !== rightReady) {
        return leftReady - rightReady;
      }
      return (left.pendingAt ?? 0) - (right.pendingAt ?? 0);
    });
    return resources[0];
  };

  private priorityWeight = (resource: PendingRecoverableResource) => {
    return resource.options.priority?.() === "background" ? 0 : 1;
  };

  private computeDelay = (resource: PendingRecoverableResource) => {
    const base = Math.max(1, this.options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS);
    const max = Math.max(base, this.options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS);
    const decay = Math.max(1, this.options.delayDecay ?? DEFAULT_DELAY_DECAY);
    const jitter = Math.max(
      0,
      this.options.delayJitter ?? DEFAULT_DELAY_JITTER,
    );
    const raw = Math.min(
      max,
      Math.round(base * decay ** Math.max(0, resource.attempts)),
    );
    const factor = jitter == 0 ? 1 : 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(base, Math.round(raw * factor));
  };
}
