/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { DraftWriter } from "./draft-writer";

import AsyncStorage from "@react-native-async-storage/async-storage";

export interface ChatAttachment {
  name: string;
  kind: "image" | "file";
  markdown: string;
}

export interface ChatDraft {
  text: string;
  attachments: ChatAttachment[];
}

const DRAFT_FORMAT = "cocalc-mobile-chat-draft-v2";

function decodeDraft(value: string | null): ChatDraft {
  if (!value) return { text: "", attachments: [] };
  try {
    const parsed = JSON.parse(value);
    if (
      parsed?.format === DRAFT_FORMAT &&
      typeof parsed.text === "string" &&
      Array.isArray(parsed.attachments) &&
      parsed.attachments.every(
        (item: unknown) =>
          !!item &&
          typeof item === "object" &&
          typeof (item as ChatAttachment).name === "string" &&
          ((item as ChatAttachment).kind === "image" ||
            (item as ChatAttachment).kind === "file") &&
          typeof (item as ChatAttachment).markdown === "string",
      )
    ) {
      return { text: parsed.text, attachments: parsed.attachments };
    }
  } catch {
    // Existing drafts were stored as plain text.
  }
  return { text: value, attachments: [] };
}

function encodeDraft(value: ChatDraft): string {
  if (!value.text && !value.attachments.length) return "";
  return JSON.stringify({ format: DRAFT_FORMAT, ...value });
}

export function composeChatDraft(value: ChatDraft): string {
  return [
    value.text.trim(),
    ...value.attachments.map(({ markdown }) => markdown),
  ]
    .filter(Boolean)
    .join("\n\n");
}

function key(parts: {
  profileId: string;
  projectId: string;
  path: string;
  threadId: string;
}): string {
  return `@cocalc/mobile/chat-draft/v1/${encodeURIComponent(parts.profileId)}/${encodeURIComponent(parts.projectId)}/${encodeURIComponent(parts.path)}/${encodeURIComponent(parts.threadId)}`;
}

export async function loadChatDraft(parts: Parameters<typeof key>[0]) {
  return decodeDraft(await AsyncStorage.getItem(key(parts)));
}

const writer = new DraftWriter(async (storageKey, value) => {
  if (value) await AsyncStorage.setItem(storageKey, value);
  else await AsyncStorage.removeItem(storageKey);
});

export async function saveChatDraft(
  parts: Parameters<typeof key>[0],
  value: ChatDraft,
): Promise<void> {
  await writer.save(key(parts), encodeDraft(value));
}

export async function clearChatDraftIfUnchanged(
  parts: Parameters<typeof key>[0],
  expected: ChatDraft,
): Promise<void> {
  await writer.clearIfUnchanged(
    key(parts),
    encodeDraft(expected),
    async () => (await AsyncStorage.getItem(key(parts))) ?? "",
  );
}
