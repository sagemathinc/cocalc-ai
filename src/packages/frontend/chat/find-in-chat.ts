import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { ChatActions } from "./actions";
import { dateValue, field } from "./access";
import { newest_content } from "./utils";
import { COMBINED_FEED_KEY } from "./threads";

const ALL_MESSAGES_KEY = "__all_messages__";

interface FindInChatOptions {
  actions: ChatActions;
  project_id?: string;
  path?: string;
  query: string;
}

interface BestHit {
  dateMs: number;
  threadId?: string;
  rowId?: number;
  messageId?: string;
}

export async function findInChatAndOpenFirstResult({
  actions,
  project_id,
  path,
  query,
}: FindInChatOptions): Promise<boolean> {
  const normalized = `${query ?? ""}`.trim().toLowerCase();
  if (!normalized || !project_id || !path) return false;
  const searchTerm = /^[0-9a-f]{7,40}$/i.test(normalized)
    ? normalized.slice(0, 10)
    : normalized;
  const searchTermLower = searchTerm.toLowerCase();

  const frameActions = actions.frameTreeActions as any;
  let searchFrameId =
    frameActions?.show_focused_frame_of_type?.("search", "col", false, 0.8) ??
    undefined;
  if (!searchFrameId) {
    await frameActions?.show_search?.();
    searchFrameId =
      frameActions?.show_focused_frame_of_type?.("search", "col", false, 0.8) ??
      undefined;
  }
  if (searchFrameId) {
    frameActions?.set_frame_data?.({
      id: searchFrameId,
      search: searchTerm,
      searchThread: ALL_MESSAGES_KEY,
    });
  }

  let localBest: BestHit | undefined;
  const allMessages = actions.getAllMessages?.();
  for (const msg of allMessages?.values?.() ?? []) {
    const dateMs = dateValue(msg)?.valueOf?.();
    if (!Number.isFinite(dateMs)) continue;
    const text = newest_content(msg).replace(/<[^>]*>/g, " ").toLowerCase();
    if (!text.includes(searchTermLower)) continue;
    if (!localBest || (dateMs as number) > localBest.dateMs) {
      localBest = {
        dateMs: dateMs as number,
        threadId: field<string>(msg, "thread_id"),
      };
    }
  }

  const hubProjects = webapp_client.conat_client?.hub?.projects;
  let archivedBest: BestHit | undefined;
  if (hubProjects) {
    try {
      const archived = await hubProjects.chatStoreSearch({
        project_id,
        chat_path: path,
        query: searchTerm,
        limit: 50,
        offset: 0,
      });
      for (const hit of archived?.hits ?? []) {
        const dateMs = Number(hit?.date_ms);
        if (!Number.isFinite(dateMs)) continue;
        if (!archivedBest || dateMs > archivedBest.dateMs) {
          archivedBest = {
            dateMs,
            rowId: hit?.row_id,
            messageId: hit?.message_id,
            threadId: hit?.thread_id,
          };
        }
      }
    } catch {
      // ignore backend search errors; local hits may still exist
    }
  }

  const best =
    !localBest
      ? archivedBest
      : !archivedBest
        ? localBest
        : localBest.dateMs >= archivedBest.dateMs
          ? localBest
          : archivedBest;

  if (!best || !Number.isFinite(best.dateMs)) {
    return false;
  }

  if (archivedBest && best === archivedBest && hubProjects) {
    try {
      const rowResp = await hubProjects.chatStoreReadArchivedHit({
        project_id,
        chat_path: path,
        row_id: archivedBest.rowId,
        message_id: archivedBest.messageId,
        thread_id: archivedBest.threadId,
      });
      const row = rowResp?.row?.row;
      if (row != null) {
        actions.hydrateArchivedRows?.([row]);
      }
      const hydratedDateMs = Number(rowResp?.row?.date_ms);
      if (Number.isFinite(hydratedDateMs)) {
        best.dateMs = hydratedDateMs;
      }
    } catch {
      // ignore hydration errors and still navigate by date
    }
  }

  const threadId = `${best.threadId ?? ""}`.trim();
  if (threadId && threadId !== COMBINED_FEED_KEY && threadId !== ALL_MESSAGES_KEY) {
    actions.clearAllFilters?.();
    actions.setSelectedThread?.(threadId);
  }
  const jump = () => actions.setFragment?.(new Date(best.dateMs));
  if (threadId) {
    setTimeout(jump, 0);
  } else {
    jump();
  }
  return true;
}

