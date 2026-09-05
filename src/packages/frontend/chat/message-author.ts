/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { isLanguageModelService } from "@cocalc/util/db-schema/ai-models";

export function isCodexAgentMessageAuthor({
  threadModel,
  senderId,
  historyAuthorId,
  hasAcpAssistantMetadata = false,
}: {
  threadModel?: unknown;
  senderId?: unknown;
  historyAuthorId?: unknown;
  hasAcpAssistantMetadata?: boolean;
}): boolean {
  if (typeof threadModel !== "string" || !threadModel.trim()) return false;
  return (
    hasAcpAssistantMetadata ||
    senderId === threadModel ||
    historyAuthorId === threadModel ||
    (typeof senderId === "string" && isLanguageModelService(senderId)) ||
    (typeof historyAuthorId === "string" &&
      isLanguageModelService(historyAuthorId))
  );
}
