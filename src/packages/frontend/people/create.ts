/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import type { ChatActions } from "@cocalc/frontend/chat/actions";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import {
  type Conversation,
  newConversationPath,
  normalizeConversationTitle,
} from "@cocalc/util/conversations";
import { uuid } from "@cocalc/util/misc";
import { conversationsApi, conversationsChanged } from "./api";

export async function waitForChatReady(chat: ChatActions): Promise<void> {
  const syncdb: any = chat.syncdb;
  if (syncdb?.get_state?.() === "ready") return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out opening the conversation"));
    }, 30_000);
    const ready = () => {
      cleanup();
      resolve();
    };
    const failed = (err: unknown) => {
      cleanup();
      reject(err);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      syncdb?.removeListener?.("ready", ready);
      syncdb?.removeListener?.("error", failed);
    };
    syncdb?.once?.("ready", ready);
    syncdb?.once?.("error", failed);
  });
}

// A new conversation is a new .chat file with one human-only thread, then a
// record pointing at it. If recording fails, the file is harmless.
export async function createConversation({
  project_id,
  title,
}: {
  project_id: string;
  title: string;
}): Promise<Conversation> {
  title = normalizeConversationTitle(title);
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const path = newConversationPath(home, uuid());
  await project.ensureContainingDirectoryExists(path);
  await project.fs().writeFile(path, "");
  const instanceKey = `people-create-${uuid()}`;
  const chat = initChat(project_id, path, { instanceKey });
  try {
    await waitForChatReady(chat);
    chat.createEmptyThread({ name: title, threadAgent: { mode: "human" } });
    await chat.syncdb?.save();
    await chat.save_to_disk();
  } finally {
    removeWithInstance(path, redux, project_id, { instanceKey });
  }
  const conversation = await conversationsApi().addExisting({
    project_id,
    path,
    title,
  });
  conversationsChanged();
  return conversation;
}
