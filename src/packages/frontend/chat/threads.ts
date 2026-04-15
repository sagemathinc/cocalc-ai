/*
Utility helpers for deriving thread metadata from the chat message list.
*/

import { React } from "@cocalc/frontend/app-framework";
import type { Map as ImmutableMap } from "immutable";

import type { ChatMessageTyped, ChatMessages } from "./types";
import type { ThreadIndexEntry } from "./message-cache";
import { hasAutomationConfigContent } from "./automation-form";
import { getMessageByLookup, newest_content } from "./utils";
import { field } from "./access";
import type { ChatActions } from "./actions";

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
  | "automations"
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
  threadAccentColor?: string;
  threadIcon?: string;
  threadImage?: string;
  hasCustomAppearance: boolean;
  readCount: number;
  unreadCount: number;
  isAI: boolean;
  isAutomation: boolean;
  isPinned: boolean;
  isArchived: boolean;
  lastActivityAt?: number;
};

export interface ThreadSectionWithUnread extends ThreadSection<ThreadMeta> {
  unreadCount: number;
}

export function useThreadList(
  messages?: ChatMessages,
  threadIndex?: Map<string, ThreadIndexEntry>,
  version?: number,
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
  }, [threadIndex, messages, version]);
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
  { key: "automations", title: "Automations" },
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

function parseEpochMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const num = Number(value);
    if (Number.isFinite(num)) return Math.floor(num);
    const date = new Date(value).valueOf();
    if (Number.isFinite(date)) return Math.floor(date);
  }
  return undefined;
}

export function groupThreadsByRecency<
  T extends ThreadListItem & { isPinned?: boolean; isAutomation?: boolean },
>(threads: T[], options: GroupOptions = {}): ThreadSection<T>[] {
  if (!threads || threads.length === 0) {
    return [];
  }
  const now = options.now ?? Date.now();
  const sections: ThreadSection<T>[] = [];
  const pinned = threads.filter(
    (thread) => !!thread.isPinned && !thread.isAutomation,
  );
  const automations = threads.filter((thread) => !!thread.isAutomation);
  const remainder = threads.filter(
    (thread) => !thread.isPinned && !thread.isAutomation,
  );
  if (pinned.length > 0) {
    sections.push({ key: "pinned", title: "Pinned", threads: pinned });
  }
  const buckets: Record<RecencyKey, T[]> = {
    today: [],
    automations: [],
    yesterday: [],
    last7days: [],
    older: [],
  };
  for (const thread of remainder) {
    const delta = now - thread.newestTime;
    const key = recencyKeyForDelta(delta);
    buckets[key].push(thread);
  }
  buckets.automations = automations;
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
  version?: number;
}

export function useThreadSections({
  messages,
  threadIndex,
  activity,
  accountId,
  actions,
  version,
}: ThreadDerivationOptions): {
  threads: ThreadMeta[];
  archivedThreads: ThreadMeta[];
  threadSections: ThreadSectionWithUnread[];
} {
  const rawThreads = useThreadList(messages, threadIndex, version);
  const configThreads = React.useMemo<ThreadListItem[]>(() => {
    const rows = actions?.listThreadConfigRows?.() ?? [];
    if (!rows.length) return [];
    const keysInUse = new Set(rawThreads.map((x) => x.key));
    const threadIdsInUse = new Set<string>();
    for (const thread of rawThreads) {
      const id =
        `${field<string>(thread.rootMessage, "thread_id") ?? ""}`.trim();
      if (id) threadIdsInUse.add(id);
    }
    const extra: ThreadListItem[] = [];
    for (const row0 of rows) {
      const row = row0 && typeof row0.toJS === "function" ? row0.toJS() : row0;
      const threadId = `${field<string>(row, "thread_id") ?? ""}`.trim();
      if (
        !threadId ||
        threadIdsInUse.has(threadId) ||
        keysInUse.has(threadId)
      ) {
        continue;
      }
      const latestChatDateMs = parseEpochMs(
        field<any>(row, "latest_chat_date_ms"),
      );
      const archivedRows = Number(field<any>(row, "archived_chat_rows"));
      const dateMs =
        latestChatDateMs ??
        (Number.isFinite(archivedRows) && archivedRows > 0
          ? 0
          : (parseEpochMs(field<any>(row, "updated_at")) ??
            parseEpochMs(field<any>(row, "date")) ??
            0));
      const name = `${field<string>(row, "name") ?? ""}`.trim();
      extra.push({
        key: threadId,
        label:
          name ||
          (dateMs ? new Date(dateMs).toLocaleString() : "Untitled Chat"),
        newestTime: dateMs,
        messageCount: 0,
        rootMessage: undefined,
      });
    }
    return extra;
  }, [actions, rawThreads, version]);
  const allThreads = React.useMemo<ThreadListItem[]>(() => {
    if (configThreads.length === 0) return rawThreads;
    const merged = [...rawThreads, ...configThreads];
    merged.sort((a, b) => b.newestTime - a.newestTime);
    return merged;
  }, [rawThreads, configThreads]);

  const threads = React.useMemo<ThreadMeta[]>(() => {
    const readStateReady = accountId
      ? (actions?.isProjectReadStateReady?.() ?? false)
      : false;
    return allThreads.map((thread) => {
      const rootMessage = thread.rootMessage;
      const threadMeta = actions?.getThreadMetadata?.(thread.key);
      const storedName = threadMeta?.name;
      const hasCustomName = !!storedName;
      const threadColor = threadMeta?.thread_color;
      const threadAccentColor = threadMeta?.thread_accent_color;
      const threadIcon = threadMeta?.thread_icon;
      const threadImage = threadMeta?.thread_image;
      const hasCustomAppearance = Boolean(
        threadColor || threadAccentColor || threadIcon || threadImage,
      );
      const automationConfig = threadMeta?.automation_config;
      const isAutomation = hasAutomationConfigContent(automationConfig);
      const displayLabel = storedName || thread.label;
      const isPinned = threadMeta?.pin ?? false;
      const isArchived = threadMeta?.archived ?? false;
      const readCount =
        accountId && readStateReady
          ? Math.max(
              0,
              actions?.getThreadReadCount?.(thread.key, accountId) ?? 0,
            )
          : 0;
      const unreadCount = readStateReady
        ? Math.max(thread.messageCount - readCount, 0)
        : 0;
      const metadataIsAI =
        threadMeta?.agent_kind === "acp" ||
        threadMeta?.agent_kind === "llm" ||
        threadMeta?.acp_config != null;
      let isAI = metadataIsAI;
      if (!isAI && actions?.isLanguageModelThread) {
        const fallbackDate =
          rootMessage?.date != null
            ? new Date(rootMessage.date as any)
            : undefined;
        const result =
          fallbackDate && !Number.isNaN(fallbackDate.valueOf())
            ? actions.isLanguageModelThread(
                fallbackDate,
                field<string>(rootMessage as any, "thread_id") ?? undefined,
              )
            : false;
        isAI = result !== false;
      }
      const lastActivityAt = activity?.get(thread.key);
      return {
        ...thread,
        displayLabel,
        hasCustomName,
        threadColor,
        threadAccentColor,
        threadIcon,
        threadImage,
        hasCustomAppearance,
        readCount,
        unreadCount,
        isAI: !!isAI,
        isAutomation,
        isPinned,
        isArchived,
        lastActivityAt,
      };
    });
  }, [allThreads, accountId, actions, activity, version]);

  const visibleThreads = React.useMemo(
    () => threads.filter((thread) => !thread.isArchived),
    [threads],
  );
  const archivedThreads = React.useMemo(
    () => threads.filter((thread) => thread.isArchived),
    [threads],
  );

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

  return {
    threads: visibleThreads,
    archivedThreads,
    threadSections,
  };
}
