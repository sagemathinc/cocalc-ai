/*
Utility helpers for deriving thread metadata from the chat message list.
*/

import { React } from "@cocalc/frontend/app-framework";
import type { Map as ImmutableMap } from "immutable";

import type { ChatMessageTyped, ChatMessages } from "./types";
import type { ThreadIndexEntry } from "./message-cache";
import { getMessageByLookup, newest_content } from "./utils";
import { field } from "./access";
import type { ChatActions } from "./actions";

export const COMBINED_FEED_KEY = "__COMBINED_FEED__";

export interface ThreadListItem {
  key: string;
  label: string;
  newestTime: number;
  messageCount: number;
  rootMessage?: ChatMessageTyped;
}

export type ThreadSectionKey =
  | "pinned"
  | "today"
  | "yesterday"
  | "last7days"
  | "older";

export interface ThreadSection<T extends ThreadListItem = ThreadListItem> {
  key: ThreadSectionKey;
  title: string;
  threads: T[];
}

export type ThreadMeta = ThreadListItem & {
  displayLabel: string;
  hasCustomName: boolean;
  threadColor?: string;
  threadIcon?: string;
  threadImage?: string;
  hasCustomAppearance: boolean;
  readCount: number;
  unreadCount: number;
  isAI: boolean;
  isPinned: boolean;
  isArchived: boolean;
  lastActivityAt?: number;
};

export interface ThreadSectionWithUnread extends ThreadSection<ThreadMeta> {
  unreadCount: number;
}

const COMBINED_FEED_LABEL = "Combined feed";

export function useThreadList(
  messages?: ChatMessages,
  threadIndex?: Map<string, ThreadIndexEntry>,
): ThreadListItem[] {
  return React.useMemo(() => {
    if (threadIndex == null) {
      return [];
    }

    const items: ThreadListItem[] = [];
    for (const entry of threadIndex.values()) {
      let rootMessage = entry.rootMessage;
      if (!rootMessage && messages) {
        rootMessage = getMessageByLookup({ messages, key: entry.key });
      }
      items.push({
        key: entry.key,
        label: deriveThreadLabel(rootMessage, entry.key),
        newestTime: entry.newestTime,
        messageCount: entry.messageCount,
        rootMessage,
      });
    }

    items.sort((a, b) => b.newestTime - a.newestTime);
    return items;
  }, [threadIndex, messages]);
}

export function deriveThreadLabel(
  rootMessage: ChatMessageTyped | undefined,
  fallbackKey: string,
): string {
  const explicitName = field<string>(rootMessage, "name");
  if (typeof explicitName === "string") {
    const trimmed = explicitName.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  const content = rootMessage ? newest_content(rootMessage) : "";
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized) {
    const words = normalized.split(" ");
    const short = words.slice(0, 8).join(" ");
    return words.length > 8 ? `${short}…` : short;
  }
  const timestamp = parseInt(fallbackKey);
  if (!isNaN(timestamp)) {
    return new Date(timestamp).toLocaleString();
  }
  return "Untitled Thread";
}

const DAY_MS = 24 * 60 * 60 * 1000;

interface GroupOptions {
  now?: number;
}

type RecencyKey = Exclude<ThreadSectionKey, "pinned">;

const RECENCY_SECTIONS: { key: RecencyKey; title: string }[] = [
  { key: "today", title: "Today" },
  { key: "yesterday", title: "Yesterday" },
  { key: "last7days", title: "Last 7 Days" },
  { key: "older", title: "Older" },
];

function recencyKeyForDelta(delta: number): RecencyKey {
  if (delta < DAY_MS) {
    return "today";
  }
  if (delta < 2 * DAY_MS) {
    return "yesterday";
  }
  if (delta < 7 * DAY_MS) {
    return "last7days";
  }
  return "older";
}

export function groupThreadsByRecency<
  T extends ThreadListItem & { isPinned?: boolean },
>(threads: T[], options: GroupOptions = {}): ThreadSection<T>[] {
  if (!threads || threads.length === 0) {
    return [];
  }
  const now = options.now ?? Date.now();
  const sections: ThreadSection<T>[] = [];
  const pinned = threads.filter((thread) => !!thread.isPinned);
  const remainder = threads.filter((thread) => !thread.isPinned);
  if (pinned.length > 0) {
    sections.push({ key: "pinned", title: "Pinned", threads: pinned });
  }
  const buckets: Record<RecencyKey, T[]> = {
    today: [],
    yesterday: [],
    last7days: [],
    older: [],
  };
  for (const thread of remainder) {
    const delta = now - thread.newestTime;
    const key = recencyKeyForDelta(delta);
    buckets[key].push(thread);
  }
  for (const def of RECENCY_SECTIONS) {
    const list = buckets[def.key];
    if (list.length > 0) {
      sections.push({ key: def.key, title: def.title, threads: list });
    }
  }
  return sections;
}

interface ThreadDerivationOptions {
  messages?: ChatMessages;
  threadIndex?: Map<string, ThreadIndexEntry>;
  activity?: ImmutableMap<string, number>;
  accountId?: string;
  actions?: ChatActions;
}

export function useThreadSections({
  messages,
  threadIndex,
  activity,
  accountId,
  actions,
}: ThreadDerivationOptions): {
  threads: ThreadMeta[];
  archivedThreads: ThreadMeta[];
  combinedThread?: ThreadMeta;
  threadSections: ThreadSectionWithUnread[];
} {
  const rawThreads = useThreadList(messages, threadIndex);
  const llmCacheRef = React.useRef<Map<string, boolean>>(new Map());

  const threads = React.useMemo<ThreadMeta[]>(() => {
    return rawThreads.map((thread) => {
      const rootMessage = thread.rootMessage;
      const threadMeta = actions?.getThreadMetadata?.(thread.key);
      const storedName = threadMeta?.name;
      const hasCustomName = !!storedName;
      const threadColor = threadMeta?.thread_color;
      const threadIcon = threadMeta?.thread_icon;
      const threadImage = threadMeta?.thread_image;
      const hasCustomAppearance = Boolean(threadColor || threadIcon || threadImage);
      const displayLabel = storedName || thread.label;
      const isPinned = threadMeta?.pin ?? false;
      const isArchived = threadMeta?.archived ?? false;
      const readField =
        accountId && rootMessage
          ? field<any>(rootMessage, `read-${accountId}`)
          : null;
      const readValue =
        typeof readField === "number"
          ? readField
          : typeof readField === "string"
            ? parseInt(readField, 10)
            : 0;
      const readCount =
        Number.isFinite(readValue) && readValue > 0 ? readValue : 0;
      const unreadCount = Math.max(thread.messageCount - readCount, 0);
      let isAI = llmCacheRef.current.get(thread.key);
      if (isAI == null) {
        if (actions?.isLanguageModelThread) {
          const result = actions.isLanguageModelThread(
            new Date(parseInt(thread.key, 10)),
          );
          isAI = result !== false;
        } else {
          isAI = false;
        }
        llmCacheRef.current.set(thread.key, isAI);
      }
      const lastActivityAt = activity?.get(thread.key);
      return {
        ...thread,
        displayLabel,
        hasCustomName,
        threadColor,
        threadIcon,
        threadImage,
        hasCustomAppearance,
        readCount,
        unreadCount,
        isAI: !!isAI,
        isPinned,
        isArchived,
        lastActivityAt,
      };
    });
  }, [rawThreads, accountId, actions, activity]);

  const visibleThreads = React.useMemo(
    () => threads.filter((thread) => !thread.isArchived),
    [threads],
  );
  const archivedThreads = React.useMemo(
    () => threads.filter((thread) => thread.isArchived),
    [threads],
  );

  const combinedThread = React.useMemo<ThreadMeta | undefined>(() => {
    if (visibleThreads.length === 0) return undefined;
    const newestTime = Math.max(
      ...visibleThreads.map((thread) => thread.newestTime),
    );
    const messageCount = visibleThreads.reduce(
      (sum, thread) => sum + thread.messageCount,
      0,
    );
    const readCount = visibleThreads.reduce(
      (sum, thread) => sum + thread.readCount,
      0,
    );
    const unreadCount = visibleThreads.reduce(
      (sum, thread) => sum + thread.unreadCount,
      0,
    );
    const lastActivityAt = visibleThreads.reduce<number | undefined>(
      (latest, thread) => {
        if (thread.lastActivityAt == null) return latest;
        return latest == null
          ? thread.lastActivityAt
          : Math.max(latest, thread.lastActivityAt);
      },
      undefined,
    );
    return {
      key: COMBINED_FEED_KEY,
      label: COMBINED_FEED_LABEL,
      displayLabel: COMBINED_FEED_LABEL,
      newestTime,
      messageCount,
      rootMessage: undefined,
      hasCustomName: false,
      threadColor: undefined,
      threadIcon: undefined,
      threadImage: undefined,
      hasCustomAppearance: false,
      readCount,
      unreadCount,
      isAI: false,
      isPinned: false,
      isArchived: false,
      lastActivityAt,
    };
  }, [visibleThreads]);

  const threadSections = React.useMemo<ThreadSectionWithUnread[]>(() => {
    const grouped = groupThreadsByRecency(visibleThreads);
    return grouped.map((section) => ({
      ...section,
      unreadCount: section.threads.reduce(
        (sum, thread) => sum + thread.unreadCount,
        0,
      ),
    }));
  }, [visibleThreads]);

  return { threads: visibleThreads, archivedThreads, combinedThread, threadSections };
}
