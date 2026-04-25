import type { HubApi } from "@cocalc/conat/hub/api";

export function createBrowserSessionHeartbeat({
  hub,
  getSnapshot,
  retryMs,
  maxRetryMs,
  retryBackoff = 2,
  retryJitter = 0.2,
  onWarn,
  onFailure,
}: {
  hub: HubApi;
  getSnapshot: () => Parameters<HubApi["system"]["upsertBrowserSession"]>[0];
  retryMs: number;
  maxRetryMs?: number;
  retryBackoff?: number;
  retryJitter?: number;
  onWarn?: (message: string) => void;
  onFailure?: (err: unknown, consecutiveFailures: number) => void;
}): {
  getAccountId: () => string | undefined;
  activate: (accountId: string) => void;
  deactivate: () => string | undefined;
  suspend: () => void;
  resume: () => void;
  heartbeat: () => Promise<void>;
  schedule: (delayMs?: number) => void;
  markDirty: (delayMs?: number) => void;
} {
  let accountId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let active = false;
  let suspended = false;
  let inFlight: Promise<void> | undefined;
  let consecutiveFailures = 0;
  let changeSerial = 0;
  let dirty = true;
  let lastPublishedSignature: string | undefined;
  let forceNextSync = false;

  const canRun = () => active && !suspended && !!accountId;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const nextRetryDelay = () => {
    const base = Math.max(1, retryMs);
    const max = Math.max(base, maxRetryMs ?? base);
    const decay = Math.max(1, retryBackoff);
    const jitter = Math.max(0, retryJitter);
    const raw = Math.min(
      max,
      Math.round(base * decay ** Math.max(0, consecutiveFailures - 1)),
    );
    const factor = jitter == 0 ? 1 : 1 + (Math.random() * 2 - 1) * jitter;
    return Math.max(base, Math.round(raw * factor));
  };

  const syncNow = async (opts: { force?: boolean } = {}) => {
    if (!canRun()) return;
    if (inFlight) {
      await inFlight;
      return;
    }
    const syncSeq = changeSerial;
    const force = opts.force === true || forceNextSync;
    forceNextSync = false;
    const snapshot = getSnapshot();
    const signature = JSON.stringify(snapshot);
    if (!force && signature === lastPublishedSignature) {
      if (changeSerial === syncSeq) {
        dirty = false;
      }
      return;
    }
    inFlight = (async () => {
      await hub.system.upsertBrowserSession(snapshot);
      consecutiveFailures = 0;
      lastPublishedSignature = signature;
      if (changeSerial === syncSeq) {
        dirty = false;
      }
    })()
      .catch((err) => {
        consecutiveFailures += 1;
        dirty = true;
        onWarn?.(`browser-session sync failed: ${err}`);
        onFailure?.(err, consecutiveFailures);
        schedule(nextRetryDelay());
      })
      .finally(() => {
        inFlight = undefined;
        if (canRun() && dirty) {
          schedule(0);
        }
      });
    await inFlight;
  };

  const schedule = (delayMs = 0) => {
    if (!canRun()) return;
    clearTimer();
    timer = setTimeout(
      () => {
        void syncNow();
      },
      Math.max(0, delayMs),
    );
  };

  const markDirty = (delayMs = 0) => {
    changeSerial += 1;
    dirty = true;
    schedule(delayMs);
  };

  const activate = (nextAccountId: string) => {
    active = true;
    suspended = false;
    accountId = nextAccountId;
    consecutiveFailures = 0;
    changeSerial = 0;
    dirty = true;
    forceNextSync = true;
    lastPublishedSignature = undefined;
  };

  const deactivate = (): string | undefined => {
    active = false;
    suspended = false;
    clearTimer();
    const currentAccountId = accountId;
    accountId = undefined;
    consecutiveFailures = 0;
    changeSerial = 0;
    dirty = true;
    forceNextSync = false;
    lastPublishedSignature = undefined;
    return currentAccountId;
  };

  const suspend = () => {
    if (!active || !accountId) {
      return;
    }
    suspended = true;
    clearTimer();
  };

  const resume = () => {
    if (!active || !accountId) {
      return;
    }
    suspended = false;
    schedule(0);
  };

  return {
    getAccountId: () => accountId,
    activate,
    deactivate,
    suspend,
    resume,
    heartbeat: async () => {
      await syncNow({ force: true });
    },
    schedule,
    markDirty,
  };
}
