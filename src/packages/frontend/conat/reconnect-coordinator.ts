import { EventEmitter } from "events";

const DEFAULT_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_DELAY_MAX_MS = 30_000;
const DEFAULT_RECONNECT_DELAY_DECAY = 2;
const DEFAULT_RECONNECT_DELAY_JITTER = 0.2;
const DEFAULT_RECONNECT_STABLE_RESET_MS = 60_000;
const BACKGROUND_TAB_RECONNECT_DELAY_MS = 15_000;

export type ReconnectPriority = "foreground" | "background";

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
  onReconnectScheduled?: (event: ReconnectScheduleEvent) => void;
  onReconnectStable?: () => void;
}

export class ReconnectCoordinator extends EventEmitter {
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectStableTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private pendingDelayMs?: number;
  private pendingPriority?: ReconnectPriority;
  private pendingReason?: string;
  private readonly visibilityHandler = () => {
    if (this.visibilityPriority() !== "foreground") {
      return;
    }
    if (!this.options.canReconnect() || this.options.isConnected()) {
      return;
    }
    this.requestReconnect({
      reason: "tab_became_visible",
      priority: "foreground",
      resetBackoff: true,
    });
  };

  constructor(private readonly options: ReconnectCoordinatorOptions) {
    super();
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.visibilityHandler);
    }
  }

  close = () => {
    this.clearReconnectTimer();
    this.cancelReconnectStableReset();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.removeAllListeners();
  };

  standby = () => {
    this.resetReconnectBackoff();
  };

  resume = () => {
    this.requestReconnect({
      reason: "resume",
      priority: this.visibilityPriority(),
      resetBackoff: true,
    });
  };

  noteConnected = () => {
    this.clearReconnectTimer();
    this.scheduleReconnectStableReset();
  };

  requestReconnect = ({
    reason,
    priority = this.visibilityPriority(),
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
      visibility: this.visibilityPriority(),
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

  private visibilityPriority = (): ReconnectPriority => {
    if (typeof document === "undefined") {
      return "foreground";
    }
    return document.visibilityState === "hidden" ? "background" : "foreground";
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
}
