/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { writeChatComposerDraft } from "@cocalc/frontend/chat/use-chat-composer-draft";
import { stableDraftKeyFromThreadKey } from "@cocalc/frontend/chat/utils";
import {
  collaborationReference,
  serializeCollaborationReference,
} from "@cocalc/util/collaboration-references";
import type { CollaborationReference } from "@cocalc/util/collaboration-references";
import { collaborationTargetKey } from "@cocalc/util/collaborators";
import type { CollaborationResource } from "@cocalc/util/collaborators";
import type { DirectoryApi } from "./workspace-api";

export type ShareConversationApi = Pick<
  DirectoryApi,
  "listResources" | "getResource"
>;

export function shareSessionIsCurrent(accountId: string): () => boolean {
  const client = webapp_client.conat_client;
  return () =>
    !!accountId &&
    redux.getStore("account")?.get("account_id") === accountId &&
    webapp_client.conat_client === client;
}

export function isHumanDestination(resource: CollaborationResource): boolean {
  return (
    resource.kind === "conversation" &&
    !resource.archived &&
    !!resource.chat_path &&
    !!resource.thread_id
  );
}

/** Only account-private draft storage is written. Never initialize a chat,
 * send, name, enroll, collect, invoke, or change permissions here.
 */
export async function shareReferenceToConversation({
  accountId,
  api,
  reference,
  destination,
  isCurrent,
}: {
  accountId: string;
  api: ShareConversationApi;
  reference: CollaborationReference;
  destination: CollaborationResource;
  isCurrent: () => boolean;
}): Promise<CollaborationResource> {
  const sessionCurrent = shareSessionIsCurrent(accountId);
  const current = () => sessionCurrent() && isCurrent();
  const assertCurrent = () => {
    if (!current()) throw Error("The share selection or account changed.");
  };
  assertCurrent();
  const bound = collaborationReference(reference);
  if (!bound || !isHumanDestination(destination))
    throw Error("Select an available human conversation.");
  const [source, target] = await Promise.all([
    api.getResource({ ...bound.target, account_id: accountId }),
    api.getResource({
      project_id: destination.project_id,
      kind: "conversation",
      resource_id: destination.resource_id,
      account_id: accountId,
    }),
  ]);
  assertCurrent();
  if (
    !source ||
    source.archived ||
    collaborationTargetKey(source) !== collaborationTargetKey(bound.target) ||
    !target ||
    !isHumanDestination(target) ||
    collaborationTargetKey(target) !== collaborationTargetKey(destination)
  )
    throw Error("The reference or destination is no longer available.");
  await writeChatComposerDraft({
    account_id: accountId,
    project_id: target.project_id,
    path: target.chat_path,
    composerDraftKey: stableDraftKeyFromThreadKey(target.thread_id),
    text: serializeCollaborationReference(bound),
    append: true,
    isCurrent: current,
  });
  return target;
}
