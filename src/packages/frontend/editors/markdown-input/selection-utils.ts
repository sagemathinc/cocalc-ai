import type { SelectionController } from "./types";

export const PENDING_SELECTION_MAX_ATTEMPTS = 5;
export const PENDING_SELECTION_RETRY_MS = 30;
export const CACHED_SELECTION_RESTORE_DELAY_MS = 100;

type TimeoutHandle = ReturnType<typeof setTimeout>;

interface RetrySelectionApplyOptions {
  apply: () => boolean;
  maxAttempts?: number;
  delayMs?: number;
}

export function retrySelectionApply({
  apply,
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
  const controller = getController();
  if (controller == null) {
    return () => {};
  }

  try {
    controller.setSelection(selection);
    return () => {};
  } catch (_err) {
    const timeout = setTimeout(() => {
      try {
        getController()?.setSelection(selection);
      } catch (_retryErr) {
        // stale or invalid selections are expected to fail harmlessly
      }
    }, delayMs);

    return () => {
      clearTimeout(timeout);
    };
  }
}
