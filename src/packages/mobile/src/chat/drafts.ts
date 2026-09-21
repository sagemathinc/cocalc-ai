/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

import { DraftWriter } from "./draft-writer";

import AsyncStorage from "@react-native-async-storage/async-storage";

function key(parts: {
  profileId: string;
  projectId: string;
  path: string;
  threadId: string;
}): string {
  return `@cocalc/mobile/chat-draft/v1/${encodeURIComponent(parts.profileId)}/${encodeURIComponent(parts.projectId)}/${encodeURIComponent(parts.path)}/${encodeURIComponent(parts.threadId)}`;
}

export async function loadChatDraft(parts: Parameters<typeof key>[0]) {
  return (await AsyncStorage.getItem(key(parts))) ?? "";
}

const writer = new DraftWriter(async (storageKey, value) => {
  if (value) await AsyncStorage.setItem(storageKey, value);
  else await AsyncStorage.removeItem(storageKey);
});

export async function saveChatDraft(
  parts: Parameters<typeof key>[0],
  value: string,
): Promise<void> {
  await writer.save(key(parts), value);
}

export async function clearChatDraftIfUnchanged(
  parts: Parameters<typeof key>[0],
  expected: string,
): Promise<void> {
  await writer.clearIfUnchanged(
    key(parts),
    expected,
    async () => (await AsyncStorage.getItem(key(parts))) ?? "",
  );
}
