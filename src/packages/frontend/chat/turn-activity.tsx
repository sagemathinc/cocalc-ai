/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// The state of one agent turn's activity: its live or persisted log, the
// activity blocks derived from it, and the timeline rows shown for it.
//
// In the chat log a turn's rows are individual virtualized rows, and the
// turn's own message row may be scrolled far away and unmounted while its
// activity keeps streaming. So the log is owned by a headless
// `TurnActivityFeed` rendered outside the virtualized list, which publishes
// the turn's state to a `TurnActivityStore` read by the rows and the message.

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  deriveAcpLogRefs,
  getLiveResponseBlocks,
  getMountedIntermediateResponseBlocks,
} from "@cocalc/chat";
import type { ChatActions } from "./actions";
import type { AttachedSteerMessage } from "./agent-message-status";
import { dateValue, field, isAcpAssistantMessage } from "./access";
import { useMessageArtifactPublications } from "./artifacts";
import {
  canUseCompletedCachedCodexActivity,
  reconcileActivityGuidance,
  resolveEffectiveGenerating,
  resolveInlineCodexActivityMode,
  resolveLiveCodexActivityBlocks,
  shouldLoadCodexPreviewBody,
  trimCompletedCachedCodexActivityBlocks,
  type InlineCodexActivityBlock,
} from "./message-state";
import {
  buildTurnTimelineRows,
  type AgentSplitCache,
  type TurnTimelineRow,
} from "./turn-timeline";
import type { ChatMessageTyped } from "./types";
import { useCodexLog, type CodexLogResult } from "./use-codex-log";
import { newest_content } from "./utils";

export interface TurnActivity {
  log: CodexLogResult;
  logRefs: {
    store?: string;
    key?: string;
    subject?: string;
    liveStream?: string;
  };
  effectiveGenerating: boolean;
  inlineMode: "hidden" | "live" | "completed";
  // Completed activity available to show, for the activity toggle.
  completedBlocks?: InlineCodexActivityBlock[];
  // Rows shown for the turn; empty when its activity is hidden.
  rows: TurnTimelineRow[];
  rowIndex: Map<string, number>;
  // Artifacts are placed in `rows` rather than listed below the message.
  artifactsInline: boolean;
}

// The turn's artifact cards below its message. While it runs they appear in
// its activity, where they were published; once it is done they are also
// listed at the bottom, so they are found next to the final response rather
// than pages back in the activity.
export function showArtifactCardsBelowMessage(
  activity: Pick<TurnActivity, "artifactsInline" | "effectiveGenerating">,
): boolean {
  return !activity.artifactsInline || !activity.effectiveGenerating;
}

const NO_LOG: CodexLogResult = {
  events: undefined,
  hasLogRef: false,
  deleteLog: async () => {},
  liveStatus: "idle",
  loadState: "idle",
};

export const EMPTY_TURN_ACTIVITY: TurnActivity = {
  log: NO_LOG,
  logRefs: {},
  effectiveGenerating: false,
  inlineMode: "hidden",
  rows: [],
  rowIndex: new Map(),
  artifactsInline: false,
};

export interface TurnActivityOptions {
  message: ChatMessageTyped;
  actions?: ChatActions;
  project_id?: string;
  path?: string;
  isCodexThread: boolean;
  activitySteers?: AttachedSteerMessage[];
  expandedCodexActivity: boolean;
  allowAsyncCompletedCodexActivityLoad: boolean;
  cachedCodexActivityBlocks?: InlineCodexActivityBlock[];
  onCachedCodexActivityBlocksChange?: (
    blocks: InlineCodexActivityBlock[] | undefined,
  ) => void;
  // When false nothing is loaded or computed (another owner feeds the turn).
  enabled?: boolean;
}

export function useTurnActivity({
  message,
  actions,
  project_id,
  path,
  isCodexThread,
  activitySteers,
  expandedCodexActivity,
  allowAsyncCompletedCodexActivityLoad,
  cachedCodexActivityBlocks,
  onCachedCodexActivityBlocksChange,
  enabled = true,
}: TurnActivityOptions): TurnActivity {
  const messageThreadId =
    `${field<string>(message, "thread_id") ?? ""}`.trim() || undefined;
  const messageId = `${field<string>(message, "message_id") ?? ""}`.trim();
  const acpInterrupted = field<boolean>(message, "acp_interrupted") === true;
  const effectiveGenerating = resolveEffectiveGenerating({
    isCodexThread,
    generating: field<boolean>(message, "generating"),
    acpInterrupted,
  });
  const showCodexActivity = useMemo(
    () => isAcpAssistantMessage(message),
    [message],
  );
  const inlineMode = resolveInlineCodexActivityMode({
    showCodexActivity,
    generating: effectiveGenerating,
    expandedCompletedActivity: expandedCodexActivity,
  });

  // Resolve log identifiers deterministically (shared with backend) so we
  // never invent subjects/keys in multiple places.
  const logRefs = useMemo(() => {
    const derived =
      project_id && path && messageThreadId && messageId
        ? deriveAcpLogRefs({
            project_id,
            path,
            thread_id: messageThreadId,
            message_id: messageId,
          })
        : undefined;
    const previewStream =
      field<string>(message, "acp_live_preview_stream") ||
      field<string>(message, "acp_live_log_stream") ||
      derived?.previewStream;
    return {
      store: field<string>(message, "acp_log_store") ?? derived?.store,
      key: field<string>(message, "acp_log_key") ?? derived?.key,
      subject: field<string>(message, "acp_log_subject") ?? derived?.subject,
      liveStream:
        field<string>(message, "acp_live_log_stream") ?? derived?.liveStream,
      previewStream,
      // Older turns only stored the full stream and use it as a compatibility
      // fallback above. Derived preview refs are projections; explicit full
      // refs are not.
      previewIsProjection:
        !!field<string>(message, "acp_live_preview_stream") ||
        !field<string>(message, "acp_live_log_stream"),
    };
  }, [message, project_id, path, messageThreadId, messageId]);

  const rowMessageValue = useMemo(() => newest_content(message), [message]);
  const loadPreviewBody =
    enabled &&
    shouldLoadCodexPreviewBody({
      showCodexActivity,
      projectId: project_id,
      generating: effectiveGenerating,
      interrupted: acpInterrupted,
      allowAsyncCompletedCodexActivityLoad,
      rowMessageValue,
    });
  const log = useCodexLog({
    projectId: project_id,
    logStore: logRefs.store,
    logKey: logRefs.key,
    logSubject: logRefs.subject,
    liveLogStream: logRefs.previewStream,
    liveStreamIsProjection: logRefs.previewIsProjection,
    generating: effectiveGenerating,
    enabled: loadPreviewBody,
  });

  const steerItems = useMemo(
    () =>
      (activitySteers ?? [])
        .filter(
          (steer) =>
            typeof steer?.text === "string" && steer.text.trim().length > 0,
        )
        .map(({ date, text, state }) => ({ date, text, state })),
    [activitySteers],
  );
  const hasEvents = Array.isArray(log.events) && log.events.length > 0;

  const liveBlocks = useMemo(() => {
    if (!enabled || inlineMode !== "live") return undefined;
    if (!hasEvents && steerItems.length === 0) return undefined;
    const blocks = getLiveResponseBlocks(
      (log.events ?? []) as any,
      steerItems,
    ) as InlineCodexActivityBlock[];
    return blocks.length > 0 ? blocks : undefined;
  }, [enabled, inlineMode, hasEvents, log.events, steerItems]);
  const resolvedLiveBlocks = useMemo(
    () =>
      resolveLiveCodexActivityBlocks({
        previewBlocks: liveBlocks,
        cachedBlocks: cachedCodexActivityBlocks,
      }),
    [cachedCodexActivityBlocks, liveBlocks],
  );
  useEffect(() => {
    if (
      !enabled ||
      inlineMode !== "live" ||
      resolvedLiveBlocks == null ||
      !onCachedCodexActivityBlocksChange
    ) {
      return;
    }
    onCachedCodexActivityBlocksChange(resolvedLiveBlocks);
  }, [
    enabled,
    inlineMode,
    onCachedCodexActivityBlocksChange,
    resolvedLiveBlocks,
  ]);

  const completedBlocksFromEvents = useMemo(() => {
    if (!enabled) return undefined;
    if (!hasEvents && steerItems.length === 0) return undefined;
    const blocks = (
      getMountedIntermediateResponseBlocks(
        (log.events ?? []) as any,
        steerItems,
      ) as InlineCodexActivityBlock[]
    ).filter(
      (block) => typeof block.text === "string" && block.text.trim().length > 0,
    );
    return blocks.length > 0 ? blocks : undefined;
  }, [enabled, hasEvents, log.events, steerItems]);
  const completedBlocks = useMemo(() => {
    if (!enabled || inlineMode !== "completed") return undefined;
    const trimmedCachedBlocks = trimCompletedCachedCodexActivityBlocks(
      cachedCodexActivityBlocks,
      rowMessageValue,
    );
    const steerBlocks = (activitySteers ?? []).map(({ date, text, state }) => ({
      kind: "guidance" as const,
      time: date,
      text,
      state,
    }));
    if (
      canUseCompletedCachedCodexActivity({ liveStatus: log.liveStatus }) &&
      trimmedCachedBlocks != null
    ) {
      return reconcileActivityGuidance(trimmedCachedBlocks, steerBlocks);
    }
    if (
      allowAsyncCompletedCodexActivityLoad &&
      completedBlocksFromEvents != null
    ) {
      return completedBlocksFromEvents;
    }
    return steerBlocks.length > 0 ? steerBlocks : undefined;
  }, [
    enabled,
    inlineMode,
    activitySteers,
    allowAsyncCompletedCodexActivityLoad,
    cachedCodexActivityBlocks,
    log.liveStatus,
    completedBlocksFromEvents,
    rowMessageValue,
  ]);

  const timelineBlocks =
    inlineMode === "live"
      ? resolvedLiveBlocks
      : inlineMode === "completed"
        ? completedBlocks
        : undefined;
  const showsRows = Array.isArray(timelineBlocks) && timelineBlocks.length > 0;
  // Artifacts are shown where they were published while the activity is
  // visible; only subscribe to publications then.
  const artifacts = useMessageArtifactPublications({
    actions: showsRows ? actions : undefined,
    threadId: messageThreadId,
    messageId,
  });
  const splitCacheRef = useRef<AgentSplitCache>(new Map());
  const rows = useMemo(
    () =>
      showsRows
        ? buildTurnTimelineRows({
            blocks: timelineBlocks!,
            artifacts,
            splitCache: splitCacheRef.current,
          })
        : [],
    [showsRows, timelineBlocks, artifacts],
  );

  const rowIndex = useMemo(
    () => new Map(rows.map((row, index) => [row.id, index])),
    [rows],
  );

  return useMemo(
    () => ({
      log: enabled ? log : NO_LOG,
      logRefs,
      effectiveGenerating,
      inlineMode,
      completedBlocks,
      rows,
      rowIndex,
      artifactsInline: showsRows && artifacts != null,
    }),
    [
      enabled,
      log,
      logRefs,
      effectiveGenerating,
      inlineMode,
      completedBlocks,
      rows,
      rowIndex,
      showsRows,
      artifacts,
    ],
  );
}

export interface TurnActivityStore {
  get: (messageId: string) => TurnActivity | undefined;
  set: (messageId: string, activity: TurnActivity | undefined) => void;
  subscribe: (messageId: string, listener: () => void) => () => void;
  // Called when rows are added to or removed from any turn. A row whose
  // content changed is updated through `subscribe`, without touching the list.
  subscribeRows: (listener: () => void) => () => void;
  rowsVersion: () => number;
}

function sameRowIds(
  a: TurnTimelineRow[] | undefined,
  b: TurnTimelineRow[] | undefined,
): boolean {
  if (a === b) return true;
  if ((a?.length ?? 0) !== (b?.length ?? 0)) return false;
  for (let i = (a?.length ?? 0) - 1; i >= 0; i -= 1) {
    if (a![i].id !== b![i].id) return false;
  }
  return true;
}

export function createTurnActivityStore(): TurnActivityStore {
  const values = new Map<string, TurnActivity>();
  const listeners = new Map<string, Set<() => void>>();
  const rowListeners = new Set<() => void>();
  let version = 0;
  return {
    get: (messageId) => values.get(messageId),
    set: (messageId, activity) => {
      const previous = values.get(messageId);
      if (previous === activity) return;
      if (activity == null) values.delete(messageId);
      else values.set(messageId, activity);
      for (const listener of listeners.get(messageId) ?? []) listener();
      if (!sameRowIds(previous?.rows, activity?.rows)) {
        version += 1;
        for (const listener of rowListeners) listener();
      }
    },
    subscribe: (messageId, listener) => {
      const current = listeners.get(messageId) ?? new Set();
      current.add(listener);
      listeners.set(messageId, current);
      return () => {
        current.delete(listener);
        if (current.size === 0) listeners.delete(messageId);
      };
    },
    subscribeRows: (listener) => {
      rowListeners.add(listener);
      return () => rowListeners.delete(listener);
    },
    rowsVersion: () => version,
  };
}

export const TurnActivityStoreContext = createContext<
  TurnActivityStore | undefined
>(undefined);

export function useFedTurnActivity(
  messageId: string | undefined,
): TurnActivity | undefined {
  const store = useContext(TurnActivityStoreContext);
  const subscribe = useMemo(
    () => (listener: () => void) =>
      store && messageId ? store.subscribe(messageId, listener) : () => {},
    [store, messageId],
  );
  const get = () => (store && messageId ? store.get(messageId) : undefined);
  return useSyncExternalStore(subscribe, get, get);
}

// The current content of one row, which may be newer than the row the list
// last rendered with (e.g. the streaming tail of the turn).
export function useFedTurnRow(
  messageId: string,
  row: TurnTimelineRow,
): TurnTimelineRow {
  const activity = useFedTurnActivity(messageId);
  const index = activity?.rowIndex.get(row.id);
  return index == null ? row : activity!.rows[index];
}

export function isLanguageModelTurn(
  actions: ChatActions | undefined,
  message: ChatMessageTyped,
): boolean {
  return (
    typeof actions?.isLanguageModelThread?.(dateValue(message) ?? undefined) ===
    "string"
  );
}

// Owns one turn's activity log while the turn's rows can be shown, publishing
// its state for the message and activity rows, which may be unmounted.
export const TurnActivityFeed = memo(function TurnActivityFeed({
  store,
  ...options
}: Omit<TurnActivityOptions, "enabled" | "isCodexThread"> & {
  store: TurnActivityStore;
}) {
  const activity = useTurnActivity({
    ...options,
    isCodexThread: isLanguageModelTurn(options.actions, options.message),
  });
  const messageId = `${field<string>(options.message, "message_id") ?? ""}`;
  useEffect(() => {
    store.set(messageId, activity);
  }, [store, messageId, activity]);
  useEffect(() => () => store.set(messageId, undefined), [store, messageId]);
  return null;
});
