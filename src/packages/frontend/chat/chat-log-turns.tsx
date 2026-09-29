/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Agent turns in the chat log: which turns get an activity feed, and the
// stable per-turn context their activity rows render with.

import { useCallback, useRef, useSyncExternalStore } from "react";
import type { ChatActions } from "./actions";
import type { AttachedSteerMessage } from "./agent-message-status";
import { dateValue, field, isAcpAssistantMessage } from "./access";
import { agentMessageDirectory } from "./activity-path-context";
import { linkifyCommitHashes } from "./git-commit-links";
import type { InlineCodexActivityBlock } from "./message-state";
import { TurnActivityFeed, type TurnActivity } from "./turn-activity";
import type { TurnActivityStore } from "./turn-activity";
import type { TurnListRowContext } from "./turn-activity-timeline";
import type { ChatMessageTyped } from "./types";
import { message_colors, newest_content } from "./utils";

interface ActivityBlocksCache {
  getSnapshot: (messageId: string) => InlineCodexActivityBlock[] | undefined;
  set: (
    messageId: string,
    blocks: InlineCodexActivityBlock[] | undefined,
  ) => void;
  subscribe: (messageId: string, listener: () => void) => () => void;
}

// A turn needs its log while it runs, while its completed activity is shown,
// and when it has no stored response yet. Other turns render from the chat
// document alone.
export function needsTurnActivityFeed(
  message: ChatMessageTyped,
  expanded: boolean,
): boolean {
  if (!isAcpAssistantMessage(message)) return false;
  return (
    expanded ||
    field<boolean>(message, "generating") === true ||
    field<boolean>(message, "acp_interrupted") === true ||
    !`${newest_content(message) ?? ""}`.trim()
  );
}

export function ChatTurnActivityFeed({
  store,
  blocksCache,
  messageId,
  message,
  actions,
  project_id,
  path,
  activitySteers,
  expanded,
  explicitlyExpanded,
  readOnly,
}: {
  store: TurnActivityStore;
  blocksCache: ActivityBlocksCache;
  messageId: string;
  message: ChatMessageTyped;
  actions?: ChatActions;
  project_id?: string;
  path?: string;
  activitySteers?: AttachedSteerMessage[];
  expanded: boolean;
  explicitlyExpanded: boolean;
  readOnly: boolean;
}) {
  const subscribe = useCallback(
    (listener: () => void) => blocksCache.subscribe(messageId, listener),
    [blocksCache, messageId],
  );
  const getSnapshot = useCallback(
    () => blocksCache.getSnapshot(messageId),
    [blocksCache, messageId],
  );
  const cached = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const onCachedChange = useCallback(
    (blocks: InlineCodexActivityBlock[] | undefined) =>
      blocksCache.set(messageId, blocks),
    [blocksCache, messageId],
  );
  const allowAsyncCompletedCodexActivityLoad =
    !readOnly &&
    expanded &&
    field<boolean>(message, "generating") !== true &&
    (explicitlyExpanded || cached == null);
  return (
    <TurnActivityFeed
      store={store}
      message={message}
      actions={actions}
      project_id={project_id}
      path={path}
      activitySteers={activitySteers}
      expandedCodexActivity={expanded}
      allowAsyncCompletedCodexActivityLoad={
        allowAsyncCompletedCodexActivityLoad
      }
      cachedCodexActivityBlocks={cached}
      onCachedCodexActivityBlocksChange={onCachedChange}
    />
  );
}

function threadWorkingDirectory(
  actions: ChatActions | undefined,
  threadId: string | undefined,
): string | undefined {
  if (!threadId) return undefined;
  const config: any = actions?.getThreadMetadata?.(threadId, {
    threadId,
  })?.acp_config;
  const directory =
    config?.get?.("workingDirectory") ?? config?.workingDirectory;
  return typeof directory === "string" ? directory : undefined;
}

// Row contexts are compared by identity to skip re-rendering finished rows,
// so reuse one per turn until something it depends on changes.
export function useTurnListRowContexts({
  store,
  actions,
  project_id,
  path,
  account_id,
  fontSize,
  editorTheme,
  searchQuery,
  readOnly,
  onOpenGitBrowser,
}: {
  store: TurnActivityStore;
  actions?: ChatActions;
  project_id?: string;
  path?: string;
  account_id: string;
  fontSize?: number;
  editorTheme?: string | null;
  searchQuery?: string;
  readOnly: boolean;
  onOpenGitBrowser?: TurnListRowContext["onOpenGitBrowser"];
}) {
  const cache = useRef(
    new Map<string, { deps: unknown[]; context: TurnListRowContext }>(),
  );
  return (
    message: ChatMessageTyped,
    activity: TurnActivity,
  ): TurnListRowContext => {
    const messageId = `${field<string>(message, "message_id") ?? ""}`;
    const threadId =
      `${field<string>(message, "thread_id") ?? ""}`.trim() || undefined;
    const inlineCodeLinks = field<any>(message, "inline_code_links");
    const basePath = agentMessageDirectory({
      workingDirectory: field<string>(message, "acp_working_directory"),
      events: activity.log.events as any,
      fallback: threadWorkingDirectory(actions, threadId),
    });
    const className = message_colors(account_id, message).message_class;
    const deps = [
      actions,
      project_id,
      path,
      threadId,
      readOnly,
      fontSize,
      editorTheme,
      searchQuery,
      inlineCodeLinks,
      basePath,
      className,
      onOpenGitBrowser,
    ];
    const cached = cache.current.get(messageId);
    if (cached && cached.deps.every((value, i) => value === deps[i])) {
      return cached.context;
    }
    const context: TurnListRowContext = {
      actions,
      projectId: project_id,
      path,
      threadId,
      messageId,
      messageDate: dateValue(message)?.valueOf() ?? 0,
      readOnly,
      fontSize,
      className,
      editorTheme,
      highlightQuery: searchQuery,
      inlineCodeLinks: Array.isArray(inlineCodeLinks)
        ? inlineCodeLinks
        : undefined,
      inlineCodeProjectRoot: basePath,
      formatAgentMarkdown: linkifyCommitHashes,
      getEvents: () => store.get(messageId)?.log.events,
      onOpenGitBrowser: readOnly ? undefined : onOpenGitBrowser,
    };
    cache.current.set(messageId, { deps, context });
    return context;
  };
}
