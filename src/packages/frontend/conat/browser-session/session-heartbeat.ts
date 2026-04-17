import type { HubApi } from "@cocalc/conat/hub/api";

export function createBrowserSessionHeartbeat({
  hub,
  getSnapshot,
  intervalMs,
  retryMs,
  maxRetryMs,
  retryBackoff = 2,
  retryJitter = 0.2,
  onWarn,
}: {
  hub: HubApi;
  getSnapshot: () => Parameters<HubApi["system"]["upsertBrowserSession"]>[0];
  intervalMs: number;
  retryMs: number;
  maxRetryMs?: number;
  retryBackoff?: number;
  retryJitter?: number;
  onWarn?: (message: string) => void;
}): {
  getAccountId: () => string | undefined;
  activate: (accountId: string) => void;
  deactivate: () => string | undefined;
  suspend: () => void;
  resume: () => void;
  heartbeat: () => Promise<void>;
  schedule: (delayMs?: number) => void;
} {
  let accountId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let suspended = false;
  let inFlight: Promise<void> | undefined;
  let consecutiveFailures = 0;

  const canRun = () => !closed && !suspended && !!accountId;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const heartbeat = async () => {
    if (!canRun()) return;
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = (async () => {
      await hub.system.upsertBrowserSession(getSnapshot());
      consecutiveFailures = 0;
    })().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };

  const nextRetryDelay = () => {
    const base = Math.max(1, retryMs);
    const max = Math.max(base, maxRetryMs ?? intervalMs);
    const decay = Math.max(1, retryBackoff);
    const jitter = Math.max(0, retryJitter);
    const raw = Math.min(
      max,
      Math.round(base * decay ** Math.max(0, consecutiveFailures - 1)),
    );
    const factor = jitter == 0 ? 1 : 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(base, Math.round(raw * factor));
  };

  const schedule = (delayMs = intervalMs) => {
    if (!canRun()) return;
    clearTimer();
    timer = setTimeout(async () => {
      if (!canRun()) {
        return;
      }
      try {
        await heartbeat();
        schedule(intervalMs);
      } catch (err) {
        if (!canRun()) {
          return;
        }
        consecutiveFailures += 1;
        onWarn?.(`browser-session heartbeat failed: ${err}`);
        schedule(nextRetryDelay());
      }
    }, delayMs);
  };

  const activate = (nextAccountId: string) => {
    closed = false;
    suspended = false;
    accountId = nextAccountId;
    consecutiveFailures = 0;
  };

  const deactivate = (): string | undefined => {
    closed = true;
    suspended = false;
    clearTimer();
    const currentAccountId = accountId;
    accountId = undefined;
    consecutiveFailures = 0;
    return currentAccountId;
  };

  const suspend = () => {
    if (closed || !accountId) {
      return;
    }
    suspended = true;
    clearTimer();
  };

  const resume = () => {
    if (closed || !accountId) {
      return;
    }
    suspended = false;
    consecutiveFailures = 0;
    schedule(0);
  };

  return {
    getAccountId: () => accountId,
    activate,
    deactivate,
    suspend,
    resume,
    heartbeat,
    schedule,
  };
}
