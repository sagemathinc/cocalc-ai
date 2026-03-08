import type { SelectionController } from "./types";

export const PENDING_SELECTION_MAX_ATTEMPTS = 5;
export const PENDING_SELECTION_RETRY_MS = 30;
export const CACHED_SELECTION_RESTORE_DELAY_MS = 100;

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface RetrySelectionApplyOptions {
  apply: () => boolean;
  isReady?: () => boolean;
  maxAttempts?: number;
  delayMs?: number;
}

export function retrySelectionApply({
  apply,
  isReady,
  maxAttempts = PENDING_SELECTION_MAX_ATTEMPTS,
  delayMs = PENDING_SELECTION_RETRY_MS,
}: RetrySelectionApplyOptions): () => void {
  let attempts = 0;
  let cancelled = false;
  let timeout: TimeoutHandle | undefined;

  const tryApply = () => {
    if (cancelled) {
      return;
    }
    attempts += 1;
    if (isReady != null && !isReady()) {
      if (attempts < maxAttempts) {
        timeout = setTimeout(tryApply, delayMs);
      }
      return;
    }
    if (apply()) {
      return;
    }
    if (attempts < maxAttempts) {
      timeout = setTimeout(tryApply, delayMs);
    }
  };

  tryApply();

  return () => {
    cancelled = true;
    if (timeout != null) {
      clearTimeout(timeout);
    }
  };
}

interface RestoreSelectionWithRetryOptions {
  getController: () => SelectionController | null;
  selection: any;
  delayMs?: number;
}

export function restoreSelectionWithRetry({
  getController,
  selection,
  delayMs = CACHED_SELECTION_RESTORE_DELAY_MS,
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

  const timeout = setTimeout(() => {
    try {
      if (!tryRestore()) {
        // stale or invalid selections are expected to fail harmlessly
      }
    } catch (_retryErr) {
      // stale or invalid selections are expected to fail harmlessly
    }
  }, delayMs);

  return () => {
    clearTimeout(timeout);
  };
}
