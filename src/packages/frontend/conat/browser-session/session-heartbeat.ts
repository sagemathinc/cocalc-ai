import type { HubApi } from "@cocalc/conat/hub/api";

export function createBrowserSessionHeartbeat({
  hub,
  getSnapshot,
  intervalMs,
  retryMs,
  onWarn,
}: {
  hub: HubApi;
  getSnapshot: () => Parameters<HubApi["system"]["upsertBrowserSession"]>[0];
  intervalMs: number;
  retryMs: number;
  onWarn?: (message: string) => void;
}): {
  getAccountId: () => string | undefined;
  activate: (accountId: string) => void;
  deactivate: () => string | undefined;
  heartbeat: () => Promise<void>;
  schedule: (delayMs?: number) => void;
} {
  let accountId: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let inFlight: Promise<void> | undefined;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const heartbeat = async () => {
    if (closed || !accountId) return;
    if (inFlight) {
      await inFlight;
      return;
    }
    inFlight = (async () => {
      await hub.system.upsertBrowserSession(getSnapshot());
    })().finally(() => {
      inFlight = undefined;
    });
    await inFlight;
  };

  const schedule = (delayMs = intervalMs) => {
    if (closed || !accountId) return;
    clearTimer();
    timer = setTimeout(async () => {
      try {
        await heartbeat();
        schedule(intervalMs);
      } catch (err) {
        onWarn?.(`browser-session heartbeat failed: ${err}`);
        schedule(retryMs);
      }
    }, delayMs);
  };

  const activate = (nextAccountId: string) => {
    closed = false;
    accountId = nextAccountId;
  };

  const deactivate = (): string | undefined => {
    closed = true;
    clearTimer();
    const currentAccountId = accountId;
    accountId = undefined;
    return currentAccountId;
  };

  return {
    getAccountId: () => accountId,
    activate,
    deactivate,
    heartbeat,
    schedule,
  };
}
