import { useEffect, useMemo, useState } from "react";
import { isChatBot } from "@cocalc/frontend/account/chatbot";
import { lite } from "@cocalc/frontend/lite";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import ProgressEstimate from "@cocalc/frontend/components/progress-estimate";
import type { ChatActions } from "./actions";
import { field } from "./access";
import { getUserName } from "./chat-log";
import { deriveThreadLabel } from "./threads";
import type { ChatMessageTyped } from "./types";

interface Props {
  actions: ChatActions;
  projectId: string;
  path: string;
  accountId?: string;
  userMap?: any;
}

function getLoc0(locs: any): any {
  if (!locs) return undefined;
  if (typeof locs.get === "function") return locs.get(0);
  if (Array.isArray(locs)) return locs[0];
  return undefined;
}

function isCursorComposing(cursor: any): boolean {
  const loc0 = getLoc0(cursor?.get?.("locs") ?? cursor?.locs);
  if (!loc0) return false;
  const immutableValue = loc0?.get?.("chat_composing");
  if (immutableValue != null) return immutableValue === true;
  return loc0?.chat_composing === true;
}

function getCursorThreadKey(cursor: any): string | null {
  const loc0 = getLoc0(cursor?.get?.("locs") ?? cursor?.locs);
  if (!loc0) return null;
  const immutableValue = loc0?.get?.("chat_thread_key");
  if (immutableValue == null) {
    const raw = loc0?.chat_thread_key;
    return raw == null ? null : `${raw}`;
  }
  return `${immutableValue}`;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function getThreadId(message?: ChatMessageTyped): string | undefined {
  return normalizedString(field<string>(message, "thread_id"));
}

function getThreadConfigName(row: any): string | undefined {
  const raw =
    typeof row?.get === "function" ? row.get("name") : (row?.name ?? undefined);
  return normalizedString(raw);
}

function getThreadConfigId(row: any): string | undefined {
  const raw =
    typeof row?.get === "function"
      ? row.get("thread_id")
      : (row?.thread_id ?? undefined);
  return normalizedString(raw);
}

function getMetadataName(
  actions: ChatActions,
  threadKey: string,
  threadId?: string,
): string | undefined {
  try {
    return normalizedString(
      actions.getThreadMetadata(threadKey, { threadId })?.name,
    );
  } catch {
    return undefined;
  }
}

function buildThreadLabels(actions: ChatActions): Map<string, string> {
  const threadLabels = new Map<string, string>();

  for (const entry of actions?.getThreadIndex?.()?.values?.() ?? []) {
    const key = normalizedString(`${entry.key}`);
    if (!key) continue;
    const rootMessage = entry.rootMessage as ChatMessageTyped | undefined;
    const threadId = getThreadId(rootMessage) ?? key;
    const label =
      getMetadataName(actions, key, threadId) ??
      deriveThreadLabel(rootMessage, key);

    threadLabels.set(key, label);
    if (threadId !== key) {
      threadLabels.set(threadId, label);
    }
  }

  // Thread names live in chat-thread-config rows. Prefer these over labels
  // derived from root content so typing indicators track renamed threads.
  for (const row of actions?.listThreadConfigRows?.() ?? []) {
    const threadId = getThreadConfigId(row);
    const name = getThreadConfigName(row);
    if (!threadId || !name) continue;
    threadLabels.set(threadId, name);
  }

  return threadLabels;
}

export default function Composing({ actions, accountId, userMap }: Props) {
  const [cursorTick, setCursorTick] = useState(0);

  useEffect(() => {
    if (lite) return;
    const syncdb = actions?.syncdb;
    if (!syncdb) return;
    const refresh = () => setCursorTick((n) => n + 1);
    syncdb.on("cursor_activity", refresh);
    const timer = window.setInterval(refresh, 5000);
    refresh();
    return () => {
      window.clearInterval(timer);
      syncdb.removeListener("cursor_activity", refresh);
    };
  }, [actions?.syncdb]);

  const cursorElements = useMemo(() => {
    if (lite) return [] as React.JSX.Element[];
    if (!accountId || userMap == null) return [] as React.JSX.Element[];
    const syncdb = actions?.syncdb;
    if (!syncdb || !syncdb.isReady()) return [] as React.JSX.Element[];
    const threadLabels = buildThreadLabels(actions);
    let cursors: any;
    try {
      cursors = syncdb.get_cursors({
        maxAge: 30 * 1000,
        excludeSelf: "always",
      });
    } catch {
      return [] as React.JSX.Element[];
    }
    if (!cursors || cursors.size === 0) return [] as React.JSX.Element[];
    const items: React.JSX.Element[] = [];
    for (const [key, value] of cursors as any) {
      const senderId = `${key}`;
      if (!senderId || senderId === accountId) continue;
      if (!isCursorComposing(value)) continue;
      const senderName = getUserName(userMap, senderId).trim();
      if (!senderName || senderName === "Unknown") continue;
      const threadKey = getCursorThreadKey(value);
      const threadLabel =
        threadKey == null || threadKey === "null"
          ? null
          : (threadLabels.get(threadKey) ?? null);
      items.push(
        <div
          key={`cursor-${senderId}`}
          style={{ margin: "5px", color: "#666", textAlign: "center" }}
        >
          <Avatar size={20} account_id={senderId} />
          <span style={{ marginLeft: "15px" }}>
            {senderName} is writing a message
            {threadLabel ? ` in "${threadLabel}"` : ""}
            ...
          </span>
          {isChatBot(senderId) && (
            <ProgressEstimate
              style={{ marginLeft: "15px", maxWidth: "600px" }}
              seconds={5}
            />
          )}
        </div>,
      );
    }
    return items;
  }, [accountId, actions?.syncdb, cursorTick, userMap]);

  if (cursorElements.length > 0) {
    return <div>{cursorElements}</div>;
  }
  return null;
}
