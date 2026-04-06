/*
 *  This file is part of CoCalc: Copyright © 2020 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { throttle } from "lodash";
import { redux } from "@cocalc/frontend/app-framework";
import type {
  ChatMessageTyped,
  MentionList,
  ChatMessages,
  ChatMessage,
} from "./types";
import { is_date as isDate } from "@cocalc/util/misc";
import {
  firstHistory,
  senderId,
  editingArray,
  dateValue,
  parentMessageId as parentMessageIdField,
} from "./access";
import { ensureSideChatActions, listUnreadChatThreads } from "./unread";

export const INPUT_HEIGHT = "auto";

export function stableDraftKeyFromThreadKey(threadKey: string): number {
  let hash = 0;
  for (let i = 0; i < threadKey.length; i++) {
    hash = (hash * 33 + threadKey.charCodeAt(i)) | 0;
  }
  // Keep reply/thread draft keys negative and non-zero so they never collide
  // with the global composer bucket `0`.
  const positive = Math.abs(hash) || 1;
  return -positive;
}

export const USER_MENTION_MARKUP =
  '<span class="user-mention" account-id=__id__ >@__display__</span>';

const USER_MENTION_MARKUP_WITHOUT_PLACEHOLDERS =
  '<span class="user-mention" account-id= ></span>';

const SINGLE_MENTION_OFFSET = USER_MENTION_MARKUP_WITHOUT_PLACEHOLDERS.length;

/*
  Given plain text which looks like
  ```
    @person name you need to do this.
  ```
  `cursor_plain_text_index` in that text,
  and `mentions` from react-mentions,

  return the cursor position in the backing text which looks like
  ```
    <span class-name="user-mention" account-id= 72583e2b-3ea3-431c-892f-2b9616e6754e >@person name</span> you need to do this.
  ```
*/
export function compute_cursor_offset_position(
  cursor_plain_text_index: number,
  mentions: MentionList,
) {
  let index_offset = 0;
  let usable_cursor_index = cursor_plain_text_index;
  const mention_array = Array.isArray(mentions)
    ? mentions
    : typeof (mentions as any)?.toJS === "function"
      ? (mentions as any).toJS()
      : [];

  for (let i = 0; i < mention_array.length; i++) {
    const current_mention = mention_array[i];
    const { id, display, index, plainTextIndex } = current_mention;
    const mention_offset = index - plainTextIndex;

    if (cursor_plain_text_index <= plainTextIndex) {
      // Cursor is in front of this mention. ie. " asdfas |@jim" where | is the cursor
      index_offset = mention_offset;
      break;
    } else if (cursor_plain_text_index >= plainTextIndex + display.length) {
      if (i == mention_array.length - 1) {
        // Cursor is after last mention.
        index_offset = mention_offset + id.length + SINGLE_MENTION_OFFSET;
      }
    } else if (cursor_plain_text_index > plainTextIndex + display.length / 2) {
      usable_cursor_index = plainTextIndex + display.length;
      if (i == mention_array.length - 1) {
        // Cursor is inside the second half of the last mention.
        index_offset = mention_offset + id.length + SINGLE_MENTION_OFFSET;
      }
    } else if (cursor_plain_text_index <= plainTextIndex + display.length / 2) {
      // Cursor is inside the first half of this mention
      usable_cursor_index = plainTextIndex;
      index_offset = mention_offset;
      break;
    }
  }
  return index_offset + usable_cursor_index;
}

export function newest_content(message: ChatMessageTyped): string {
  const first = firstHistory(message);
  return first?.content ?? "";
}

export function sender_is_viewer(
  account_id: string,
  message: ChatMessageTyped,
): boolean {
  return account_id == senderId(message);
}

export function message_colors(
  account_id: string,
  message: ChatMessageTyped,
): {
  background?: string;
  color?: string;
  message_class: string;
  lighten?: { color: string };
} {
  if (sender_is_viewer(account_id, message)) {
    return {
      background: "#f4f4f4",
      message_class: "smc-message-from-viewer",
    };
  } else {
    return {
      lighten: { color: "#888" },
      message_class: "smc-message-from-other",
    };
  }
}

export function is_editing(
  message: ChatMessageTyped,
  account_id: string,
): boolean {
  return editingArray(message).includes(account_id);
}

export const markChatAsReadIfUnseen: (
  project_id: string,
  path: string,
) => void = throttle((project_id: string, path: string) => {
  const account_id = redux?.getStore("account")?.get_account_id?.();
  const chatActions = ensureSideChatActions(project_id, path);
  const unreadThreads = listUnreadChatThreads({
    actions: chatActions,
    account_id,
  });
  if (unreadThreads.length > 0) {
    // Keep the legacy file_use write path for now so the old recent-activity
    // panel stays in sync until that surface is replaced.
    const actions = redux?.getActions("file_use");
    if (actions == null) return;
    actions.mark_file(project_id, path, "read");
    actions.mark_file(project_id, path, "chatseen");
  }
}, 3000);

export function getRootMessage({
  message,
  messages,
}: {
  message: ChatMessage;
  messages: ChatMessages;
}): ChatMessageTyped | undefined {
  const directParentMessageId = parentMessageIdField(message);
  const date = dateValue(message);
  const threadId =
    typeof (message as any)?.thread_id === "string"
      ? `${(message as any).thread_id}`.trim()
      : "";
  const fallbackRootByThreadId = (): ChatMessageTyped | undefined => {
    if (!threadId) return undefined;
    let root: ChatMessageTyped | undefined;
    let earliest: ChatMessageTyped | undefined;
    for (const candidate of messages.values?.() ?? []) {
      if (`${(candidate as any)?.thread_id ?? ""}`.trim() !== threadId)
        continue;
      if (!earliest) {
        earliest = candidate as ChatMessageTyped;
      } else {
        const currentMs =
          dateValue(candidate as any)?.valueOf() ?? Number.POSITIVE_INFINITY;
        const earliestMs =
          dateValue(earliest as any)?.valueOf() ?? Number.POSITIVE_INFINITY;
        if (currentMs < earliestMs) {
          earliest = candidate as ChatMessageTyped;
        }
      }
      if (!parentMessageIdField(candidate as any)) {
        root = candidate as ChatMessageTyped;
        break;
      }
    }
    return root ?? earliest;
  };
  const fallbackRootByParentChain = (): ChatMessageTyped | undefined => {
    if (!directParentMessageId) return undefined;
    const byId = new Map<string, ChatMessageTyped>();
    for (const candidate of messages.values?.() ?? []) {
      const id = `${(candidate as any)?.message_id ?? ""}`.trim();
      if (!id) continue;
      byId.set(id, candidate as ChatMessageTyped);
    }
    let current = byId.get(directParentMessageId);
    let guard = 0;
    while (current && guard < 1000) {
      const nextParentId = parentMessageIdField(current);
      if (!nextParentId) return current;
      const next = byId.get(nextParentId);
      if (!next) return current;
      current = next;
      guard += 1;
    }
    return current;
  };
  const byParentChain = fallbackRootByParentChain();
  if (byParentChain) return byParentChain;
  const ms = new Date(date ?? Date.now()).valueOf();
  return getMessageAtDate({ messages, date: ms }) ?? fallbackRootByThreadId();
}

function stableMessageOrder(a: ChatMessageTyped, b: ChatMessageTyped): number {
  const aMs = dateValue(a)?.valueOf() ?? Number.POSITIVE_INFINITY;
  const bMs = dateValue(b)?.valueOf() ?? Number.POSITIVE_INFINITY;
  if (aMs !== bMs) return aMs - bMs;
  const aId = `${(a as any)?.message_id ?? ""}`.trim();
  const bId = `${(b as any)?.message_id ?? ""}`.trim();
  if (aId && bId) return aId.localeCompare(bId);
  return `${senderId(a) ?? ""}`.localeCompare(`${senderId(b) ?? ""}`);
}

export function orderLinearThreadMessages(
  messages: ChatMessageTyped[],
): ChatMessageTyped[] {
  if (!Array.isArray(messages) || messages.length <= 1) {
    return Array.isArray(messages) ? messages.slice() : [];
  }
  const sorted = messages.slice().sort(stableMessageOrder);
  const byId = new Map<string, ChatMessageTyped>();
  for (const message of sorted) {
    const id = `${(message as any)?.message_id ?? ""}`.trim();
    if (id) byId.set(id, message);
  }

  const children = new Map<string, ChatMessageTyped[]>();
  const anchors: ChatMessageTyped[] = [];
  for (const message of sorted) {
    const parentId = parentMessageIdField(message);
    if (
      parentId &&
      byId.has(parentId) &&
      parentId !== `${(message as any)?.message_id ?? ""}`.trim()
    ) {
      const bucket = children.get(parentId) ?? [];
      bucket.push(message);
      children.set(parentId, bucket);
    } else {
      anchors.push(message);
    }
  }
  for (const bucket of children.values()) {
    bucket.sort(stableMessageOrder);
  }
  anchors.sort(stableMessageOrder);

  const ordered: ChatMessageTyped[] = [];
  const visited = new Set<string>();
  const visit = (message: ChatMessageTyped) => {
    const id = `${(message as any)?.message_id ?? ""}`.trim();
    const key =
      id ||
      `${dateValue(message)?.valueOf() ?? "no-date"}:${senderId(message) ?? ""}`;
    if (visited.has(key)) return;
    visited.add(key);
    ordered.push(message);
    if (!id) return;
    for (const child of children.get(id) ?? []) {
      visit(child);
    }
  };

  for (const anchor of anchors) {
    visit(anchor);
  }
  for (const message of sorted) {
    visit(message);
  }
  return ordered;
}

export function getReplyToRoot({
  message,
  messages,
}: {
  message: ChatMessage;
  messages: ChatMessages;
}): Date | undefined {
  const root = getRootMessage({ message, messages });
  const date = dateValue(root);
  return date ? new Date(date) : undefined;
}

export function getThreadRootDate({
  date,
  messages,
}: {
  date: number;
  messages?: ChatMessages;
}): number {
  if (messages == null) {
    return 0;
  }
  const raw = getMessageAtDate({ messages, date });
  const message =
    raw && typeof (raw as any)?.toJS === "function"
      ? (raw as any).toJS()
      : (raw as any);
  if (message == null) {
    return 0;
  }
  const d = getReplyToRoot({ message, messages });
  return d?.valueOf() ?? 0;
}

export function getMessageByLookup({
  messages,
  key,
}: {
  messages?: ChatMessages;
  key?: string;
}): ChatMessageTyped | undefined {
  if (!messages || !key) return undefined;
  const direct = messages.get?.(key) as ChatMessageTyped | undefined;
  if (direct != null) return direct;
  const ms = Number(key);
  if (!Number.isFinite(ms)) return undefined;
  for (const candidate of messages.values?.() ?? []) {
    const d = dateValue(candidate as any);
    if (d?.valueOf() === ms) {
      return candidate as ChatMessageTyped;
    }
  }
  return undefined;
}

export function getMessageAtDate({
  messages,
  date,
}: {
  messages?: ChatMessages;
  date: number;
}): ChatMessageTyped | undefined {
  if (!Number.isFinite(date)) return undefined;
  return getMessageByLookup({ messages, key: `${date}` });
}

// Use heuristics to try to turn "date", whatever it might be,
// into a string representation of the number of ms since the
// epoch.
const floatRegex = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
export function toMsString(date): string {
  if (isDate(date)) {
    return `${date.valueOf()}`;
  }

  switch (typeof date) {
    case "number":
      return `${date}`;
    case "string":
      if (floatRegex.test(date)) {
        return `${parseInt(date)}`;
      }
    default:
      return `${new Date(date).valueOf()}`;
  }
}

export function toISOString(date?: Date | string | number): string | undefined {
  if (typeof date == "number") {
    return new Date(date).toISOString();
  }
  if (typeof date == "string") {
    return date;
  }
  try {
    return date?.toISOString();
  } catch {
    //console.warn("invalid date", date);
    //return;
  }
}
