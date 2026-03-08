import type { SelectionController, SubscribeSelectionReady } from "./types";

export const PENDING_SELECTION_MAX_ATTEMPTS = 5;
export const PENDING_SELECTION_RETRY_MS = 30;
export const CACHED_SELECTION_RESTORE_DELAY_MS = 100;

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface RetrySelectionApplyOptions {
  apply: () => boolean;
  isReady?: () => boolean;
  subscribeReady?: SubscribeSelectionReady;
  maxAttempts?: number;
  delayMs?: number;
}

export function retrySelectionApply({
  apply,
  isReady,
  subscribeReady,
  maxAttempts = PENDING_SELECTION_MAX_ATTEMPTS,
  delayMs = PENDING_SELECTION_RETRY_MS,
}: RetrySelectionApplyOptions): () => void {
  let attempts = 0;
  let cancelled = false;
  let timeout: TimeoutHandle | undefined;
  let unsubscribeReady: (() => void) | undefined;

  const clearPendingWait = () => {
    if (timeout != null) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (unsubscribeReady != null) {
      unsubscribeReady();
      unsubscribeReady = undefined;
    }
  };

  const scheduleRetry = () => {
    if (cancelled) {
      return;
    }
    if (unsubscribeReady == null && subscribeReady != null) {
      unsubscribeReady = subscribeReady(() => {
        if (cancelled) {
          return;
        }
        clearPendingWait();
        tryApply();
      });
    }
    if (timeout == null) {
      timeout = setTimeout(() => {
        timeout = undefined;
        if (unsubscribeReady != null) {
          unsubscribeReady();
          unsubscribeReady = undefined;
        }
        tryApply();
      }, delayMs);
    }
  };

  const tryApply = () => {
    if (cancelled) {
      return;
    }
    if (isReady != null && !isReady()) {
      if (attempts < maxAttempts) {
        scheduleRetry();
      }
      return;
    }
    attempts += 1;
    clearPendingWait();
    if (apply()) {
      return;
    }
    if (attempts < maxAttempts) {
      scheduleRetry();
    }
  };

  tryApply();

  return () => {
    cancelled = true;
    clearPendingWait();
  };
}

interface RestoreSelectionWithRetryOptions {
  getController: () => SelectionController | null;
  selection: any;
  delayMs?: number;
  subscribeReady?: SubscribeSelectionReady;
}

export function restoreSelectionWithRetry({
  getController,
  selection,
  delayMs = CACHED_SELECTION_RESTORE_DELAY_MS,
  subscribeReady,
}: RestoreSelectionWithRetryOptions): () => void {
  const tryRestore = () => {
    const controller = getController();
    if (controller == null) {
      return false;
    }
    if (controller.isSelectionReady != null && !controller.isSelectionReady()) {
      return false;
    }
    try {
      controller.setSelection(selection);
      return true;
    } catch (_err) {
      return false;
    }
  };

  if (tryRestore()) {
    return () => {};
  }

  let cancelled = false;
  let timeout: TimeoutHandle | undefined;
  let unsubscribeReady: (() => void) | undefined;
  const cleanup = () => {
    cancelled = true;
    if (timeout != null) {
      clearTimeout(timeout);
      timeout = undefined;
    }
    if (unsubscribeReady != null) {
      unsubscribeReady();
      unsubscribeReady = undefined;
    }
  };

  if (subscribeReady != null) {
    unsubscribeReady = subscribeReady(() => {
      if (cancelled) {
        return;
      }
      if (tryRestore()) {
        cleanup();
      }
    });
  }

  timeout = setTimeout(() => {
    try {
      if (cancelled) {
        return;
      }
      if (!tryRestore()) {
        // stale or invalid selections are expected to fail harmlessly
      }
    } catch (_retryErr) {
      // stale or invalid selections are expected to fail harmlessly
    }
  }, delayMs);

  return cleanup;
}
