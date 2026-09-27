/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import type { CollaborationTarget } from "@cocalc/util/collaborators";
import { isValidUUID } from "@cocalc/util/misc";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import type { DirectoryApi } from "./workspace-api";

export async function createConversation({
  api,
  accountId,
  projectId,
  requestId,
  title,
  signal,
  onProgress,
}: {
  api: DirectoryApi;
  accountId: string;
  projectId: string;
  requestId: string;
  title: string;
  signal: AbortSignal;
  onProgress: (message: string) => void;
}): Promise<CollaborationTarget> {
  function check() {
    if (
      signal.aborted ||
      redux.getStore("account")?.get("account_id") !== accountId
    )
      throw Error("Conversation creation cancelled or account changed.");
  }
  check();
  onProgress("Registering the project's conversation room...");
  const room = await api.ensureRoom({
    project_id: projectId,
    request_id: requestId,
  });
  check();
  if (room.project_id !== projectId)
    throw Error("The room belongs to a different project.");
  onProgress("Opening the project chat service...");
  const client = await webapp_client.conat_client.projectConat({
    project_id: projectId,
    caller: "collaborators.createThread",
    requireRouting: true,
  });
  check();
  if (![accountId, projectId, requestId].every(isValidUUID))
    throw Error("Valid account, project, and request identities are required.");
  onProgress("Creating a human-only conversation...");
  // The host serializes initialization and checks its durable deleted-room
  // guard. A timeout has an unknown outcome; retry this same request_id.
  const response = await client.request(
    `services.account-${accountId}._.${projectId}._.collaborators`,
    ["createThread", [{ request_id: requestId, title }]],
    { timeout: 60_000, waitForInterest: true },
  );
  check();
  const created = response.data as { thread_id?: string };
  if (!isValidUUID(created?.thread_id))
    throw Error("The chat service did not confirm a conversation identity.");
  return {
    project_id: projectId,
    kind: "conversation",
    resource_id: created.thread_id!,
  };
}
