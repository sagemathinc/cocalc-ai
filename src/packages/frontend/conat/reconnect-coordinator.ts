import { EventEmitter } from "events";
import { AdaptiveWindow } from "@cocalc/conat/recovery/adaptive-window";

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_DELAY_MAX_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_DECAY = 2;
const DEFAULT_RECONNECT_DELAY_JITTER = 0.2;
const DEFAULT_RECONNECT_STABLE_RESET_MS = 60_000;
const BACKGROUND_TAB_RECONNECT_DELAY_MS = 15_000;
const FOREGROUND_RESOURCE_RECONNECT_DELAY_MS = 1_000;
const BACKGROUND_RESOURCE_RECONNECT_DELAY_MS = 5_000;
const MAX_RESOURCE_RECONNECT_DELAY_MS = 30_000;
const DEFAULT_RESOURCE_RECONNECT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_RESOURCE_RECONNECTS = 32;
const DEFAULT_INITIAL_CONCURRENT_RESOURCE_RECONNECTS = 8;

export type ReconnectPriority = "foreground" | "background";
export type StandbyStage = "active" | "soft" | "hard";

export interface ReconnectScheduleEvent {
  reason: string;
  delay_ms: number;
  attempt: number;
  priority: ReconnectPriority;
  visibility: ReconnectPriority;
}

export interface ReconnectCoordinatorOptions {
  canReconnect: () => boolean;
  connect: () => Promise<void>;
  isConnected: () => boolean;
  initialConcurrentResourceReconnects?: number;
  maxConcurrentResourceReconnects?: number;
  onReconnectScheduled?: (event: ReconnectScheduleEvent) => void;
  onReconnectStable?: () => void;
  resourceReconnectTimeoutMs?: number;
}

export interface ReconnectResourceOptions {
  canReconnect?: () => boolean;
  isConnected?: () => boolean;
  priority?: () => ReconnectPriority;
  reconnect: () => Promise<void>;
}

export interface ReconnectResourceRequest {
  reason?: string;
  resetBackoff?: boolean;
}

export interface RegisteredReconnectResource {
  requestReconnect: (request?: ReconnectResourceRequest) => void;
  close: () => void;
}

interface PendingReconnectResource {
  attempts: number;
  options: ReconnectResourceOptions;
  pendingAt?: number;
  pendingReason?: string;
  readyAt?: number;
  reconnecting?: boolean;
}

export class ReconnectCoordinator extends EventEmitter {
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectStableTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private pendingDelayMs?: number;
  private pendingPriority?: ReconnectPriority;
  private pendingReason?: string;
  private nextResourceId = 0;
  private readonly resources = new Map<string, PendingReconnectResource>();
  private readonly resourceConcurrencyWindow: AdaptiveWindow;
  private resourceReconnectsInFlight = 0;
  private resourceReconnectTimer?: ReturnType<typeof setTimeout>;
  private standbyStage: StandbyStage = "active";
  private readonly foregroundStateHandler = () => {
    if (this.standbyStage !== "active") {
      return;
    }
    if (this.tabPriority() !== "foreground") {
      return;
    }
    if (!this.options.canReconnect() || this.options.isConnected()) {
      this.schedulePendingResourceReconnects();
      return;
    }
    this.requestReconnect({
      reason: "tab_became_foreground",
      priority: "foreground",
      resetBackoff: true,
    });
  };

  constructor(private readonly options: ReconnectCoordinatorOptions) {
    super();
    this.resourceConcurrencyWindow = new AdaptiveWindow({
      min: 1,
      initial:
        options.initialConcurrentResourceReconnects ??
        Math.min(
          DEFAULT_INITIAL_CONCURRENT_RESOURCE_RECONNECTS,
          options.maxConcurrentResourceReconnects ??
            DEFAULT_MAX_CONCURRENT_RESOURCE_RECONNECTS,
        ),
      max:
        options.maxConcurrentResourceReconnects ??
        DEFAULT_MAX_CONCURRENT_RESOURCE_RECONNECTS,
    });
    if (typeof document !== "undefined") {
      document.addEventListener(
        "visibilitychange",
        this.foregroundStateHandler,
      );
      window.addEventListener("focus", this.foregroundStateHandler);
      window.addEventListener("blur", this.foregroundStateHandler);
    }
  }

  close = () => {
    this.clearReconnectTimer();
    this.clearResourceReconnectTimer();
    this.cancelReconnectStableReset();
    this.resources.clear();
    if (typeof document !== "undefined") {
      document.removeEventListener(
        "visibilitychange",
        this.foregroundStateHandler,
      );
      window.removeEventListener("focus", this.foregroundStateHandler);
      window.removeEventListener("blur", this.foregroundStateHandler);
    }
    this.removeAllListeners();
  };

  softStandby = () => {
    if (this.standbyStage === "soft") {
      return;
    }
    this.standbyStage = "soft";
    this.clearResourceReconnectTimer();
    this.emit("standby_stage", this.standbyStage);
  };

  standby = () => {
    this.standbyStage = "hard";
    this.clearResourceReconnectTimer();
    this.resetReconnectBackoff();
    this.emit("standby_stage", this.standbyStage);
  };

  prepareForTransportRestart = () => {
    this.clearResourceReconnectTimer();
    this.resetReconnectBackoff();
  };

  resume = () => {
    const previousStage = this.standbyStage;
    this.standbyStage = "active";
    this.emit("standby_stage", this.standbyStage);
    if (previousStage === "hard" || !this.options.isConnected()) {
      this.requestReconnect({
        reason: "resume",
        priority: this.tabPriority(),
        resetBackoff: true,
      });
      return;
    }
    this.schedulePendingResourceReconnects();
  };

  noteConnected = () => {
    this.clearReconnectTimer();
    this.scheduleReconnectStableReset();
    this.schedulePendingResourceReconnects();
  };

  registerResource = (
    options: ReconnectResourceOptions,
  ): RegisteredReconnectResource => {
    const id = `resource-${this.nextResourceId++}`;
    const resource: PendingReconnectResource = {
      attempts: 0,
      options,
    };
    this.resources.set(id, resource);
    return {
      requestReconnect: (request = {}) => {
        this.requestResourceReconnect(resource, request);
      },
      close: () => {
        this.resources.delete(id);
        this.schedulePendingResourceReconnects();
      },
    };
  };

  requestReconnect = ({
    reason,
    priority = this.tabPriority(),
    resetBackoff = false,
  }: {
    reason: string;
    priority?: ReconnectPriority;
    resetBackoff?: boolean;
  }) => {
    if (!this.options.canReconnect()) {
      return;
    }
    this.cancelReconnectStableReset();
    if (this.options.isConnected()) {
      this.resetReconnectBackoff();
      return;
    }
    if (resetBackoff) {
      this.reconnectAttempt = 0;
    }
    const delay = this.computeDelay(priority);
    if (
      this.reconnectTimer != null &&
      this.pendingDelayMs != null &&
      delay >= this.pendingDelayMs
    ) {
      return;
    }
    this.clearReconnectTimer();
    this.pendingDelayMs = delay;
    this.pendingPriority = priority;
    this.pendingReason = reason;
    this.options.onReconnectScheduled?.({
      reason,
      delay_ms: delay,
      attempt: this.reconnectAttempt,
      priority,
      visibility: this.tabPriority(),
    });
    this.reconnectTimer = setTimeout(async () => {
      this.clearReconnectTimer();
      if (!this.options.canReconnect() || this.options.isConnected()) {
        return;
      }
      await this.options.connect();
      if (!this.options.isConnected()) {
        this.requestReconnect({
          reason: this.pendingReason ?? reason,
          priority: this.pendingPriority ?? priority,
        });
      }
    }, delay);
    this.reconnectTimer.unref?.();
  };

  private tabPriority = (): ReconnectPriority => {
    if (typeof document === "undefined") {
      return "foreground";
    }
    if (document.visibilityState === "hidden") {
      return "background";
    }
    if (typeof document.hasFocus === "function" && !document.hasFocus()) {
      return "background";
    }
    return "foreground";
  };

  private clearReconnectTimer = () => {
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    delete this.pendingDelayMs;
    delete this.pendingPriority;
    delete this.pendingReason;
  };

  private cancelReconnectStableReset = () => {
    if (this.reconnectStableTimer != null) {
      clearTimeout(this.reconnectStableTimer);
      this.reconnectStableTimer = undefined;
    }
  };

  private resetReconnectBackoff = () => {
    this.clearReconnectTimer();
    this.cancelReconnectStableReset();
    this.reconnectAttempt = 0;
    this.options.onReconnectStable?.();
  };

  private clearResourceReconnectTimer = () => {
    if (this.resourceReconnectTimer != null) {
      clearTimeout(this.resourceReconnectTimer);
      this.resourceReconnectTimer = undefined;
    }
  };

  private requestResourceReconnect = (
    resource: PendingReconnectResource,
    {
      reason = "resource_reconnect",
      resetBackoff = false,
    }: ReconnectResourceRequest,
  ) => {
    if (resource.options.canReconnect?.() === false) {
      return;
    }
    if (resetBackoff) {
      resource.attempts = 0;
    }
    const now = Date.now();
    const readyAt = now + this.computeResourceDelay(resource);
    resource.pendingReason = reason;
    resource.pendingAt ??= now;
    resource.readyAt =
      resource.readyAt == null ? readyAt : Math.min(resource.readyAt, readyAt);
    this.schedulePendingResourceReconnects();
  };

  private schedulePendingResourceReconnects = () => {
    this.clearResourceReconnectTimer();
    if (
      this.resourceReconnectsInFlight >=
      this.resourceConcurrencyWindow.capacity()
    ) {
      return;
    }
    if (this.standbyStage !== "active") {
      return;
    }
    if (!this.options.canReconnect() || !this.options.isConnected()) {
      return;
    }
    const next = this.pickNextPendingResource();
    if (!next) {
      return;
    }
    const delay = Math.max(0, (next.readyAt ?? 0) - Date.now());
    this.resourceReconnectTimer = setTimeout(() => {
      this.clearResourceReconnectTimer();
      void this.runPendingResourceReconnects();
    }, delay);
    this.resourceReconnectTimer.unref?.();
  };

  private pickNextPendingResource = () => {
    const resources = Array.from(this.resources.values()).filter((resource) => {
      if (resource.reconnecting) {
        return false;
      }
      if (resource.readyAt == null) {
        return false;
      }
      if (resource.options.canReconnect?.() === false) {
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
      const leftPriority = this.resourcePriorityWeight(left);
      const rightPriority = this.resourcePriorityWeight(right);
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

  private resourcePriorityWeight = (resource: PendingReconnectResource) => {
    const priority = this.resourcePriority(resource);
    return priority === "foreground" ? 1 : 0;
  };

  private runPendingResourceReconnects = async () => {
    if (this.standbyStage !== "active") {
      return;
    }
    if (!this.options.canReconnect() || !this.options.isConnected()) {
      return;
    }
    while (
      this.resourceReconnectsInFlight <
      this.resourceConcurrencyWindow.capacity()
    ) {
      const resource = this.pickNextPendingResource();
      if (!resource || resource.readyAt == null) {
        break;
      }
      if (resource.readyAt > Date.now()) {
        break;
      }
      void this.runOneResourceReconnect(resource);
    }
    this.schedulePendingResourceReconnects();
  };

  private runOneResourceReconnect = async (
    resource: PendingReconnectResource,
  ) => {
    this.resourceReconnectsInFlight += 1;
    resource.reconnecting = true;
    resource.readyAt = undefined;
    try {
      await this.runResourceReconnectWithTimeout(resource);
      resource.pendingAt = undefined;
      resource.pendingReason = undefined;
      resource.attempts = 0;
      this.resourceConcurrencyWindow.noteSuccess();
    } catch {
      resource.attempts += 1;
      resource.readyAt = Date.now() + this.computeResourceDelay(resource);
      this.resourceConcurrencyWindow.noteFailure();
    } finally {
      resource.reconnecting = false;
      this.resourceReconnectsInFlight = Math.max(
        0,
        this.resourceReconnectsInFlight - 1,
      );
      this.schedulePendingResourceReconnects();
    }
  };

  private runResourceReconnectWithTimeout = async (
    resource: PendingReconnectResource,
  ) => {
    const timeoutMs = Math.max(
      1,
      this.options.resourceReconnectTimeoutMs ??
        DEFAULT_RESOURCE_RECONNECT_TIMEOUT_MS,
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        resource.options.reconnect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(Error(`resource reconnect timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer != null) {
        clearTimeout(timer);
      }
    }
  };

  private scheduleReconnectStableReset = () => {
    if (this.reconnectAttempt == 0) {
      return;
    }
    this.cancelReconnectStableReset();
    const attempt = this.reconnectAttempt;
    this.reconnectStableTimer = setTimeout(() => {
      if (this.options.isConnected() && this.reconnectAttempt === attempt) {
        this.reconnectAttempt = 0;
        this.options.onReconnectStable?.();
      }
    }, DEFAULT_RECONNECT_STABLE_RESET_MS);
    this.reconnectStableTimer.unref?.();
  };

  private computeDelay = (priority: ReconnectPriority) => {
    const base = this.nextReconnectDelay();
    if (priority === "background") {
      return Math.max(base, BACKGROUND_TAB_RECONNECT_DELAY_MS);
    }
    return base;
  };

  private nextReconnectDelay = () => {
    const base = Math.max(1, DEFAULT_RECONNECT_DELAY_MS);
    const max = Math.max(base, DEFAULT_RECONNECT_DELAY_MAX_MS);
    const decay = Math.max(1, DEFAULT_RECONNECT_DELAY_DECAY);
    const jitter = Math.max(0, DEFAULT_RECONNECT_DELAY_JITTER);
    this.reconnectAttempt += 1;
    const raw = Math.min(
      max,
      Math.round(base * decay ** Math.max(0, this.reconnectAttempt - 1)),
    );
    const factor = jitter == 0 ? 1 : 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(base, Math.round(raw * factor));
  };

  getReconnectAttempt = () => this.reconnectAttempt;
  getStandbyStage = (): StandbyStage => this.standbyStage;

  private resourcePriority = (
    resource: PendingReconnectResource,
  ): ReconnectPriority => {
    if (this.tabPriority() !== "foreground") {
      return "background";
    }
    return resource.options.priority?.() ?? "foreground";
  };

  private computeResourceDelay = (resource: PendingReconnectResource) => {
    const base = Math.min(
      MAX_RESOURCE_RECONNECT_DELAY_MS,
      Math.round(
        FOREGROUND_RESOURCE_RECONNECT_DELAY_MS *
          DEFAULT_RECONNECT_DELAY_DECAY ** Math.max(0, resource.attempts),
      ),
    );
    if (this.resourcePriority(resource) === "background") {
      return Math.max(base, BACKGROUND_RESOURCE_RECONNECT_DELAY_MS);
    }
    return base;
  };
}
