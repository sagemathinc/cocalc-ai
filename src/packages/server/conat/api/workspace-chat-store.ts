/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import {
  deleteChatStoreData,
  getChatStoreStats,
  listChatStoreSegments,
  readChatStoreArchived,
  readChatStoreArchivedHit,
  rotateChatStore,
  searchChatStore,
  vacuumChatStore,
  type ChatStoreScope,
} from "@cocalc/backend/chat-store/sqlite-offload";
import { isWorkspaceProjectRuntime } from "@cocalc/server/launchpad/project-runtime";

const HOSTED_CHAT_STORE_ERROR =
  "chat store maintenance is not implemented on central hub; call a project-host endpoint via project routing";

type WorkspaceChatStorePaths = {
  project_id: string;
  chat_path: string;
  db_path?: string;
};

export async function resolveWorkspaceChatStorePaths({
  project_id,
  chat_path,
  db_path,
}: WorkspaceChatStorePaths): Promise<{
  chat_path: string;
  db_path?: string;
}> {
  if (!isWorkspaceProjectRuntime()) {
    throw Error(HOSTED_CHAT_STORE_ERROR);
  }
  const { workspaceProjectFilesystem } =
    await import("@cocalc/server/conat/project/workspace-filesystem");
  const fs = workspaceProjectFilesystem({ project_id });
  return {
    chat_path: await fs.safeAbsPath(chat_path),
    ...(db_path ? { db_path: await fs.safeAbsPath(db_path) } : {}),
  };
}

export async function workspaceChatStoreStats(opts: WorkspaceChatStorePaths) {
  return await getChatStoreStats(await resolveWorkspaceChatStorePaths(opts));
}

export async function workspaceChatStoreRotate(
  opts: WorkspaceChatStorePaths & {
    keep_recent_messages?: number;
    max_head_bytes?: number;
    max_head_messages?: number;
    require_idle?: boolean;
    force?: boolean;
    dry_run?: boolean;
  },
) {
  const { project_id, chat_path, db_path, ...rotate } = opts;
  return await rotateChatStore({
    ...(await resolveWorkspaceChatStorePaths({
      project_id,
      chat_path,
      db_path,
    })),
    ...rotate,
  });
}

export async function workspaceChatStoreListSegments(
  opts: WorkspaceChatStorePaths & { limit?: number; offset?: number },
) {
  const { project_id, chat_path, db_path, ...page } = opts;
  return await listChatStoreSegments({
    ...(await resolveWorkspaceChatStorePaths({
      project_id,
      chat_path,
      db_path,
    })),
    ...page,
  });
}

export async function workspaceChatStoreReadArchived(
  opts: WorkspaceChatStorePaths & {
    before_date_ms?: number;
    thread_id?: string;
    limit?: number;
    offset?: number;
  },
) {
  const { project_id, chat_path, db_path, ...read } = opts;
  return await readChatStoreArchived({
    ...(await resolveWorkspaceChatStorePaths({
      project_id,
      chat_path,
      db_path,
    })),
    ...read,
  });
}

export async function workspaceChatStoreReadArchivedHit(
  opts: WorkspaceChatStorePaths & {
    row_id?: number;
    message_id?: string;
    thread_id?: string;
  },
) {
  const { project_id, chat_path, db_path, ...hit } = opts;
  return await readChatStoreArchivedHit({
    ...(await resolveWorkspaceChatStorePaths({
      project_id,
      chat_path,
      db_path,
    })),
    ...hit,
  });
}

export async function workspaceChatStoreSearch(
  opts: WorkspaceChatStorePaths & {
    artifacts?: boolean;
    include_head?: boolean;
    query: string;
    thread_id?: string;
    exclude_thread_ids?: string[];
    limit?: number;
    offset?: number;
  },
  account_id: string,
) {
  const { project_id, chat_path, db_path, ...search } = opts;
  return await searchChatStore(
    {
      ...(await resolveWorkspaceChatStorePaths({
        project_id,
        chat_path,
        db_path,
      })),
      ...search,
    },
    account_id,
  );
}

export async function workspaceChatStoreDelete(
  opts: WorkspaceChatStorePaths & {
    scope: ChatStoreScope;
    before_date_ms?: number;
    thread_id?: string;
    message_ids?: string[];
  },
) {
  const { project_id, chat_path, db_path, ...remove } = opts;
  return await deleteChatStoreData({
    ...(await resolveWorkspaceChatStorePaths({
      project_id,
      chat_path,
      db_path,
    })),
    ...remove,
  });
}

export async function workspaceChatStoreVacuum(opts: WorkspaceChatStorePaths) {
  return await vacuumChatStore(await resolveWorkspaceChatStorePaths(opts));
}
