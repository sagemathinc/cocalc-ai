/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// When an agent turn ended: the log and the reader both place messages that
// arrived during a turn with that turn.

import { isLanguageModelService } from "@cocalc/util/db-schema/ai-models";
import { field, historyArray } from "./access";
import type { ChatMessageTyped } from "./types";

/** The time of the assistant's last edit of its reply (0 if none). */
export function assistantFinishedAt(assistant: ChatMessageTyped): number {
  return Math.max(
    0,
    ...historyArray(assistant).map((entry) => {
      const author =
        (entry as any)?.author_id ?? (entry as any)?.get?.("author_id");
      if (
        typeof author !== "string" ||
        (author !== field(assistant, "sender_id") &&
          !isLanguageModelService(author))
      )
        return 0;
      const raw = (entry as any)?.date ?? (entry as any)?.get?.("date");
      const time = new Date(raw).valueOf();
      return Number.isFinite(time) ? time : 0;
    }),
  );
}
