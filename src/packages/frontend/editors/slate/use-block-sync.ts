import { debounce } from "lodash";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SimpleInputMerge } from "../../../sync/editor/generic/simple-input-merge";
import { Actions } from "./types";
import { debugSyncLog, getBlockDeferChars, getBlockDeferMs } from "./block-sync-utils";

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
      if (markdown === valueRef.current && blocksRef.current.length > 0) {
        return;
      }
      const deferChars = getBlockDeferChars();
      if (focusedIndex == null && markdown.length >= deferChars) {
        schedulePendingValue(markdown);
        return;
      }
      flushPendingValue();
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
    const nextValue = value ?? "";
    debugSyncLog("value-prop", {
      focusedIndex,
      sameAsLastSet: nextValue === lastSetValueRef.current,
      sameAsValueRef: nextValue === valueRef.current,
      pendingRemote: pendingRemoteRef.current != null,
    });
    if (nextValue === lastSetValueRef.current) {
      lastSetValueRef.current = null;
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
    if (!force && shouldDeferRemoteMerge()) {
      debugSyncLog("pending-remote:defer", {
        idleMs: mergeIdleMsRef.current,
      });
      schedulePendingRemoteMerge();
      return;
    }
    debugSyncLog("pending-remote:flush", { force });
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
      debugSyncLog("syncstring:change", {
        focusedIndex,
        remoteLength: remote.length,
        shouldDefer: shouldDeferRemoteMerge(),
      });
      if (ignoreRemoteWhileFocused && focusedIndex != null) {
        updatePendingRemoteIndicator(remote, getFullMarkdown());
        return;
      }
      if (shouldDeferRemoteMerge()) {
        pendingRemoteRef.current = remote;
        schedulePendingRemoteMerge();
        return;
      }
      debugSyncLog("syncstring:apply", { remoteLength: remote.length });
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
    if (markdown === valueRef.current) return;
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

  const markLocalEdit = useCallback(() => {
    lastLocalEditAtRef.current = Date.now();
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
