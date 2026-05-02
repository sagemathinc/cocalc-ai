// Block sync policy is centralized here for the block editor.
// It manages debounced saves, remote merge deferral, and local edit tracking,
// keeping synchronization concerns out of the core editor component.

import { debounce } from "lodash";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SimpleInputMerge } from "../../../sync/editor/generic/simple-input-merge";
import { Actions } from "./types";
import {
  debugSyncLog,
  getBlockDeferChars,
  getBlockDeferMs,
  summarizeMarkdown,
} from "./block-sync-utils";

const DEFAULT_SAVE_DEBOUNCE_MS = 750;

type UseBlockSyncArgs = {
  actions?: Actions;
  value?: string;
  initialValue: string;
  valueRef: React.MutableRefObject<string>;
  blocksRef: React.MutableRefObject<string[]>;
  focusedIndex: number | null;
  ignoreRemoteWhileFocused?: boolean;
  remoteMergeIdleMs?: number;
  saveDebounceMs?: number;
  setBlocksFromValue: (markdown: string) => void;
  getFullMarkdown: () => string;
};

type UseBlockSyncResult = {
  applyBlocksFromValue: (markdown: string) => void;
  allowNextValueUpdateWhileFocused: () => void;
  flushPendingRemoteMerge: (force?: boolean) => void;
  markLocalEdit: () => void;
  pendingRemoteIndicator: boolean;
  saveBlocksDebounced: () => void;
  saveBlocksNow: () => void;
  lastLocalEditAtRef: React.MutableRefObject<number>;
  lastRemoteMergeAtRef: React.MutableRefObject<number>;
};

export function useBlockSync({
  actions,
  value,
  initialValue,
  valueRef,
  blocksRef,
  focusedIndex,
  ignoreRemoteWhileFocused = false,
  remoteMergeIdleMs,
  saveDebounceMs,
  setBlocksFromValue,
  getFullMarkdown,
}: UseBlockSyncArgs): UseBlockSyncResult {
  const lastSetValueRef = useRef<string | null>(null);
  const lastObservedValueRef = useRef<string | null>(null);
  const pendingRemoteRef = useRef<string | null>(null);
  const pendingRemoteTimerRef = useRef<number | null>(null);
  const mergeHelperRef = useRef<SimpleInputMerge>(
    new SimpleInputMerge(initialValue),
  );
  const lastLocalEditAtRef = useRef<number>(0);
  const lastRemoteMergeAtRef = useRef<number>(0);
  const remoteMergeConfig =
    typeof window === "undefined"
      ? {}
      : ((window as any).COCALC_SLATE_REMOTE_MERGE ?? {});
  const mergeIdleMs =
    remoteMergeConfig.idleMs ??
    remoteMergeIdleMs ??
    saveDebounceMs ??
    DEFAULT_SAVE_DEBOUNCE_MS;
  const mergeIdleMsRef = useRef<number>(mergeIdleMs);
  mergeIdleMsRef.current = mergeIdleMs;
  const [pendingRemoteIndicator, setPendingRemoteIndicator] =
    useState<boolean>(false);
  const allowFocusedValueUpdateRef = useRef<boolean>(false);

  const updatePendingRemoteIndicator = useCallback(
    (remote: string, local: string) => {
      const preview = mergeHelperRef.current.previewMerge({ remote, local });
      debugSyncLog("pending-indicator:preview", {
        changed: preview.changed,
        remoteLength: remote.length,
        localLength: local.length,
      });
      if (!preview.changed) {
        pendingRemoteRef.current = null;
        mergeHelperRef.current.noteApplied(preview.merged);
      } else {
        pendingRemoteRef.current = remote;
      }
      setPendingRemoteIndicator((prev) =>
        prev === preview.changed ? prev : preview.changed,
      );
      return preview.changed;
    },
    [],
  );

  const pendingValueRef = useRef<string | null>(null);
  const pendingValueTimerRef = useRef<number | null>(null);

  const flushPendingValue = useCallback(() => {
    if (pendingValueTimerRef.current != null) {
      window.clearTimeout(pendingValueTimerRef.current);
      pendingValueTimerRef.current = null;
    }
    const pending = pendingValueRef.current;
    if (pending == null) return;
    pendingValueRef.current = null;
    setBlocksFromValue(pending);
  }, [setBlocksFromValue]);

  const schedulePendingValue = useCallback(
    (markdown: string) => {
      pendingValueRef.current = markdown;
      if (pendingValueTimerRef.current != null) {
        window.clearTimeout(pendingValueTimerRef.current);
      }
      const delay = getBlockDeferMs();
      pendingValueTimerRef.current = window.setTimeout(() => {
        pendingValueTimerRef.current = null;
        flushPendingValue();
      }, delay);
    },
    [flushPendingValue],
  );

  const applyBlocksFromValue = useCallback(
    (markdown: string) => {
      debugSyncLog("apply-blocks:request", {
        focusedIndex,
        blocksLength: blocksRef.current.length,
        sameAsValueRef: markdown === valueRef.current,
        markdown: summarizeMarkdown(markdown),
      });
      if (markdown === valueRef.current && blocksRef.current.length > 0) {
        debugSyncLog("apply-blocks:skip-same-value", {
          focusedIndex,
          blocksLength: blocksRef.current.length,
        });
        return;
      }
      const deferChars = getBlockDeferChars();
      if (focusedIndex == null && markdown.length >= deferChars) {
        debugSyncLog("apply-blocks:defer-large-unfocused", {
          focusedIndex,
          deferChars,
          markdown: summarizeMarkdown(markdown),
        });
        schedulePendingValue(markdown);
        return;
      }
      flushPendingValue();
      debugSyncLog("apply-blocks:apply-now", {
        focusedIndex,
        markdown: summarizeMarkdown(markdown),
      });
      setBlocksFromValue(markdown);
    },
    [
      blocksRef,
      focusedIndex,
      flushPendingValue,
      schedulePendingValue,
      setBlocksFromValue,
      valueRef,
    ],
  );

  useEffect(() => {
    if (actions?._syncstring != null) {
      debugSyncLog("value-prop:ignored-because-syncstring", {
        focusedIndex,
        value: summarizeMarkdown(value ?? ""),
        current: summarizeMarkdown(valueRef.current),
      });
      return;
    }
    const nextValue = value ?? "";
    const valueChanged = lastObservedValueRef.current !== nextValue;
    lastObservedValueRef.current = nextValue;
    debugSyncLog("value-prop", {
      focusedIndex,
      valueChanged,
      sameAsLastSet: nextValue === lastSetValueRef.current,
      sameAsValueRef: nextValue === valueRef.current,
      pendingRemote: pendingRemoteRef.current != null,
    });
    if (nextValue === lastSetValueRef.current) {
      lastSetValueRef.current = null;
      return;
    }
    if (!valueChanged) {
      return;
    }
    if (nextValue === valueRef.current) return;
    const allowFocusedValueUpdate = allowFocusedValueUpdateRef.current;
    if (
      ignoreRemoteWhileFocused &&
      focusedIndex != null &&
      !allowFocusedValueUpdate
    ) {
      debugSyncLog("value-prop:defer-focused", {
        focusedIndex,
      });
      updatePendingRemoteIndicator(nextValue, getFullMarkdown());
      return;
    }
    allowFocusedValueUpdateRef.current = false;
    if (pendingRemoteRef.current != null) return;
    applyBlocksFromValue(nextValue);
  }, [
    actions,
    value,
    focusedIndex,
    ignoreRemoteWhileFocused,
    applyBlocksFromValue,
    updatePendingRemoteIndicator,
    getFullMarkdown,
    valueRef,
  ]);

  useEffect(() => {
    if (focusedIndex != null) {
      flushPendingValue();
    }
  }, [focusedIndex, flushPendingValue]);

  function shouldDeferRemoteMerge(): boolean {
    const idleMs = mergeIdleMsRef.current;
    return Date.now() - lastLocalEditAtRef.current < idleMs;
  }

  function clearPendingRemoteState(reason: string, remote?: string) {
    if (pendingRemoteTimerRef.current != null) {
      window.clearTimeout(pendingRemoteTimerRef.current);
      pendingRemoteTimerRef.current = null;
    }
    if (pendingRemoteRef.current != null) {
      debugSyncLog("pending-remote:clear", {
        reason,
        pending: summarizeMarkdown(pendingRemoteRef.current),
        ...(remote == null ? {} : { remote: summarizeMarkdown(remote) }),
      });
    }
    pendingRemoteRef.current = null;
    setPendingRemoteIndicator(false);
  }

  function schedulePendingRemoteMerge() {
    if (pendingRemoteTimerRef.current != null) {
      window.clearTimeout(pendingRemoteTimerRef.current);
    }
    const idleMs = mergeIdleMsRef.current;
    debugSyncLog("pending-remote:schedule", { idleMs });
    pendingRemoteTimerRef.current = window.setTimeout(() => {
      pendingRemoteTimerRef.current = null;
      flushPendingRemoteMerge();
    }, idleMs);
  }

  function flushPendingRemoteMerge(force = false) {
    const pending = pendingRemoteRef.current;
    if (pending == null) return;
    const local = getFullMarkdown();
    if (!force && shouldDeferRemoteMerge()) {
      debugSyncLog("pending-remote:defer", {
        idleMs: mergeIdleMsRef.current,
        pending: summarizeMarkdown(pending),
        local: summarizeMarkdown(local),
      });
      schedulePendingRemoteMerge();
      return;
    }
    debugSyncLog("pending-remote:flush", {
      force,
      pending: summarizeMarkdown(pending),
      local: summarizeMarkdown(local),
    });
    pendingRemoteRef.current = null;
    setPendingRemoteIndicator(false);
    lastRemoteMergeAtRef.current = Date.now();
    mergeHelperRef.current.handleRemote({
      remote: pending,
      getLocal: getFullMarkdown,
      applyMerged: applyBlocksFromValue,
    });
  }

  useEffect(() => {
    return () => {
      if (pendingRemoteTimerRef.current != null) {
        window.clearTimeout(pendingRemoteTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (actions?._syncstring == null) return;
    const change = () => {
      const remote = actions._syncstring?.to_str() ?? "";
      const local = getFullMarkdown();
      clearPendingRemoteState("new-syncstring", remote);
      debugSyncLog("syncstring:change", {
        focusedIndex,
        remote: summarizeMarkdown(remote),
        local: summarizeMarkdown(local),
        pendingRemote: false,
        shouldDefer: shouldDeferRemoteMerge(),
      });
      if (ignoreRemoteWhileFocused && focusedIndex != null) {
        updatePendingRemoteIndicator(remote, local);
        return;
      }
      if (shouldDeferRemoteMerge()) {
        pendingRemoteRef.current = remote;
        schedulePendingRemoteMerge();
        return;
      }
      debugSyncLog("syncstring:apply", {
        remote: summarizeMarkdown(remote),
        local: summarizeMarkdown(local),
      });
      lastRemoteMergeAtRef.current = Date.now();
      mergeHelperRef.current.handleRemote({
        remote,
        getLocal: getFullMarkdown,
        applyMerged: applyBlocksFromValue,
      });
    };
    actions._syncstring.on("change", change);
    return () => {
      actions._syncstring?.removeListener("change", change);
    };
  }, [
    actions,
    focusedIndex,
    ignoreRemoteWhileFocused,
    applyBlocksFromValue,
    updatePendingRemoteIndicator,
    getFullMarkdown,
  ]);

  useEffect(() => {
    if (!ignoreRemoteWhileFocused) return;
    if (focusedIndex == null) {
      flushPendingRemoteMerge(true);
    }
  }, [focusedIndex, ignoreRemoteWhileFocused]);

  const saveBlocksNow = useCallback(() => {
    if (actions?.set_value == null) return;
    const markdown = getFullMarkdown();
    if (markdown === valueRef.current) {
      debugSyncLog("save:skip-same-value", {
        focusedIndex,
        current: summarizeMarkdown(markdown),
      });
      return;
    }
    debugSyncLog("save:dispatch", {
      focusedIndex,
      current: summarizeMarkdown(markdown),
      previousValueRef: summarizeMarkdown(valueRef.current),
    });
    lastSetValueRef.current = markdown;
    valueRef.current = markdown;
    mergeHelperRef.current.noteSaved(markdown);
    actions.set_value(markdown);
    actions.syncstring_commit?.();
  }, [actions, getFullMarkdown, valueRef]);

  const saveBlocksDebounced = useMemo(
    () => debounce(saveBlocksNow, saveDebounceMs ?? DEFAULT_SAVE_DEBOUNCE_MS),
    [saveBlocksNow, saveDebounceMs],
  );

  useEffect(() => {
    return () => {
      saveBlocksDebounced.flush();
      saveBlocksDebounced.cancel();
    };
  }, [saveBlocksDebounced]);

  const markLocalEdit = useCallback(() => {
    lastLocalEditAtRef.current = Date.now();
    debugSyncLog("local-edit", {
      focusedIndex,
      current: summarizeMarkdown(getFullMarkdown()),
      pendingRemote: pendingRemoteRef.current != null,
    });
    if (
      ignoreRemoteWhileFocused &&
      focusedIndex != null &&
      pendingRemoteRef.current != null
    ) {
      updatePendingRemoteIndicator(pendingRemoteRef.current, getFullMarkdown());
    }
  }, [
    focusedIndex,
    ignoreRemoteWhileFocused,
    updatePendingRemoteIndicator,
    getFullMarkdown,
  ]);

  const allowNextValueUpdateWhileFocused = useCallback(() => {
    allowFocusedValueUpdateRef.current = true;
  }, []);

  return {
    applyBlocksFromValue,
    allowNextValueUpdateWhileFocused,
    flushPendingRemoteMerge,
    markLocalEdit,
    pendingRemoteIndicator,
    saveBlocksDebounced,
    saveBlocksNow,
    lastLocalEditAtRef,
    lastRemoteMergeAtRef,
  };
}
