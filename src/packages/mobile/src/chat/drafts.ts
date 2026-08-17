/*
 * This file is part of CoCalc: Copyright © 2026 SageMath, Inc.
 * License: MS-RSL – see LICENSE.md for details
 */

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

export async function saveChatDraft(
  parts: Parameters<typeof key>[0],
  value: string,
): Promise<void> {
  if (value) await AsyncStorage.setItem(key(parts), value);
  else await AsyncStorage.removeItem(key(parts));
}
