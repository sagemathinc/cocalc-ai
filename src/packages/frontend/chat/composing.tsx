import { useEffect, useMemo, useState } from "react";
import { useRedux } from "@cocalc/frontend/app-framework";
import { lite } from "@cocalc/frontend/lite";
import { Avatar } from "@cocalc/frontend/account/avatar/avatar";
import ProgressEstimate from "@cocalc/frontend/components/progress-estimate";
import type { ChatActions } from "./actions";
import { getUserName } from "./chat-log";
import { deriveThreadLabel } from "./threads";

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

export default function Composing({
  actions,
  projectId,
  path,
  accountId,
  userMap,
}: Props) {
  const drafts = useRedux(["drafts"], projectId, path);
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
    const syncdb = actions?.syncdb;
    if (!syncdb || !syncdb.isReady()) return [] as React.JSX.Element[];
    const threadLabels = new Map<string, string>();
    for (const entry of actions?.getThreadIndex?.()?.values?.() ?? []) {
      const key = `${entry.key}`;
      if (!key) continue;
      threadLabels.set(key, deriveThreadLabel(entry.rootMessage, key));
    }
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
      const threadKey = getCursorThreadKey(value);
      const threadLabel =
        threadKey == null || threadKey === "null"
          ? null
          : threadLabels.get(threadKey) ?? null;
      items.push(
        <div
          key={`cursor-${senderId}`}
          style={{ margin: "5px", color: "#666", textAlign: "center" }}
        >
          <Avatar size={20} account_id={senderId} />
          <span style={{ marginLeft: "15px" }}>
            {getUserName(userMap, senderId)} is writing a message
            {threadLabel ? ` in "${threadLabel}"` : ""}
            ...
          </span>
          {senderId?.startsWith("chatgpt") && (
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

  // Backward-compat fallback for older clients still writing draft presence.
  if (!drafts || drafts.size == 0) {
    return null;
  }

  const v: React.JSX.Element[] = [];
  const cutoff = Date.now() - 1000 * 30; // 30s
  for (const [key] of drafts) {
    const record = drafts.get(key);
    const senderId: string =
      record?.get?.("sender_id") ?? `${key}`.split(":")[0] ?? "";
    if (!senderId || accountId === senderId) continue;
    if (record?.get?.("date") != 0) continue;
    const active = record?.get?.("active") ?? 0;
    const composing = record?.get?.("composing");
    const input = record?.get?.("input") ?? "";
    const hasContent = typeof input === "string" && input.trim().length > 0;
    const isComposing = composing === true || hasContent;
    if (active < cutoff || !isComposing) continue;
    v.push(
      <div
        key={`draft-${key}`}
        style={{ margin: "5px", color: "#666", textAlign: "center" }}
      >
        <Avatar size={20} account_id={senderId} />
        <span style={{ marginLeft: "15px" }}>
          {getUserName(userMap, senderId)} is writing a message...
        </span>
        {senderId?.startsWith("chatgpt") && (
          <ProgressEstimate
            style={{ marginLeft: "15px", maxWidth: "600px" }}
            seconds={5}
          />
        )}
      </div>,
    );
  }
  if (v.length == 0) return null;
  return <div>{v}</div>;
}
