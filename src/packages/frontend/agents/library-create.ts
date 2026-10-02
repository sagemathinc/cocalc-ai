/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Artifacts made by hand ("New Artifact") live in a per-project Library
// conversation: ~/.cocalc/library.chat, one "Library" thread. Each one is
// published like an agent's (same artifact rows), from a short message in
// that thread, so the project's catalog indexes it and collaborators see it.

import { publishArtifact } from "@cocalc/chat";
import type { NewArtifactContent } from "./library-artifact-content";
export {
  buildArtifactContent,
  fetchGitHubPR,
  type NewArtifactContent,
  type NewArtifactKind,
} from "./library-artifact-content";
import { redux } from "@cocalc/frontend/app-framework";
import { ensureProjectReduxRuntime } from "@cocalc/frontend/app-framework/project-runtime";
import { initChat, removeWithInstance } from "@cocalc/frontend/chat/register";
import { waitForChatReady } from "@cocalc/frontend/people/create";
import { resolveProjectHomeDirectory } from "@cocalc/frontend/project/home-directory";
import { uuid } from "@cocalc/util/misc";
import { LIBRARY_CHAT_SUFFIX } from "./library-chat";

export const LIBRARY_THREAD_NAME = "Library";

export function libraryChatPath(home: string): string {
  return `${home.replace(/\/+$/, "")}${LIBRARY_CHAT_SUFFIX}`;
}

const plain = (value: any) => value?.toJS?.() ?? value ?? [];

// The Library thread, created on first use.
export function libraryThread(chat: any): string {
  const configs: any[] = plain(
    chat.syncdb?.get({ event: "chat-thread-config" }),
  );
  const existing = configs.find((row) => row?.thread_id)?.thread_id;
  if (existing) return existing;
  const thread_id = chat.createEmptyThread({
    name: LIBRARY_THREAD_NAME,
    threadAgent: { mode: "human" },
    preserveSelectedThread: true,
  });
  if (!thread_id) throw Error("Could not create the Library conversation");
  return thread_id;
}

// The message the artifact belongs to (the latest one we just sent).
export function sentMessageId(
  chat: any,
  thread_id: string,
  input: string,
): string {
  const rows: any[] = plain(chat.syncdb?.get({ event: "chat", thread_id }));
  const mine = rows
    .filter((row) => row?.history?.[0]?.content === input)
    .sort((a, b) => `${a.date}`.localeCompare(`${b.date}`));
  const message_id = mine[mine.length - 1]?.message_id;
  if (!message_id) throw Error("Could not record the artifact message");
  return message_id;
}

export async function createLibraryArtifact({
  project_id,
  content,
}: {
  project_id: string;
  content: NewArtifactContent;
}): Promise<{ path: string; thread_id: string; artifact_id: string }> {
  await ensureProjectReduxRuntime();
  const project = redux.getProjectActions(project_id);
  if (project == null) throw Error("project is not available");
  const home = await resolveProjectHomeDirectory(project_id);
  const path = libraryChatPath(home);
  await project.ensureContainingDirectoryExists(path);
  const fs = project.fs();
  if (!(await fs.exists(path))) await fs.writeFile(path, "");
  const instanceKey = `library-create-${uuid()}`;
  const chat: any = initChat(project_id, path, { instanceKey });
  try {
    await waitForChatReady(chat);
    const thread_id = libraryThread(chat);
    const input = `Added **${content.title}** to the library.`;
    chat.sendChat({
      input,
      reply_thread_id: thread_id,
      skipModelDispatch: true,
      noNotification: true,
      preserveSelectedThread: true,
    });
    const message_id = sentMessageId(chat, thread_id, input);
    const artifact_id = uuid();
    const file =
      content.file && !content.file.path.startsWith("/")
        ? { path: `${home.replace(/\/+$/, "")}/${content.file.path}` }
        : content.file;
    publishArtifact(chat.syncdb, {
      ...content,
      ...(file ? { file } : {}),
      thread_id,
      artifact_id,
      operation_id: uuid(),
      message_id,
    });
    chat.syncdb.commit();
    await chat.syncdb.save();
    await chat.save_to_disk();
    return { path, thread_id, artifact_id };
  } finally {
    removeWithInstance(path, redux, project_id, { instanceKey });
  }
}
