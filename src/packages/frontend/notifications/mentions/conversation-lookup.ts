/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Notifications name the chat file they came from. For a People conversation
// that file is just an id, so look up the conversation it belongs to and show
// its title instead.

import { useEffect, useState } from "react";
import { redux } from "@cocalc/frontend/app-framework";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import {
  isConversationStoragePath,
  normalizeConversationPath,
  type ListedConversation,
} from "@cocalc/util/people";

const TTL_MS = 60_000;
let cached: { at: number; list: Promise<ListedConversation[]> } | undefined;

// One request shared by every notification row, refreshed at most once a
// minute.
function listConversations(): Promise<ListedConversation[]> {
  if (cached == null || Date.now() - cached.at > TTL_MS) {
    const list = webapp_client.conat_client.hub.people
      .listConversations({})
      .then(({ conversations }) => conversations)
      .catch(() => {
        cached = undefined;
        return [];
      });
    cached = { at: Date.now(), list };
  }
  return cached.list;
}

export function resetConversationLookupForTests() {
  cached = undefined;
}

function canonical(path: string): string | undefined {
  try {
    return normalizeConversationPath(path);
  } catch {
    return undefined;
  }
}

export function findConversation(
  conversations: ListedConversation[],
  project_id: string,
  path: string,
): ListedConversation | undefined {
  const target = canonical(path);
  const name = path.split("/").pop();
  const inProject = conversations.filter((c) => c.project_id === project_id);
  return (
    inProject.find((c) => target != null && canonical(c.path) === target) ??
    // Notifications record the path relative to the project's home, which
    // need not be the default home; the file name is a unique id.
    inProject.find((c) => c.path.split("/").pop() === name)
  );
}

// The account's conversation list, from the shared cache; undefined while
// loading or when not wanted.
export function useConversationList(
  enabled: boolean,
): ListedConversation[] | undefined {
  const [list, setList] = useState<ListedConversation[]>();
  useEffect(() => {
    if (!enabled) return;
    let canceled = false;
    void listConversations().then((conversations) => {
      if (!canceled) setList(conversations);
    });
    return () => {
      canceled = true;
    };
  }, [enabled]);
  return enabled ? list : undefined;
}

// The People conversation a notification's file belongs to: undefined while
// unknown, null when the file is not a known conversation.
export function useNotificationConversation(
  project_id?: string,
  path?: string,
): ListedConversation | null | undefined {
  const relevant = !!project_id && !!path && isConversationStoragePath(path);
  const [conversation, setConversation] = useState<
    ListedConversation | null | undefined
  >(relevant ? undefined : null);
  useEffect(() => {
    if (!relevant) {
      setConversation(null);
      return;
    }
    let canceled = false;
    void listConversations().then((conversations) => {
      if (!canceled) {
        setConversation(
          findConversation(conversations, project_id!, path!) ?? null,
        );
      }
    });
    return () => {
      canceled = true;
    };
  }, [relevant, project_id, path]);
  return conversation;
}

export async function openConversation(
  conversation: Pick<ListedConversation, "project_id" | "conversation_id">,
): Promise<void> {
  const page = redux.getActions("page");
  page.setState({
    people_route: `conversations/${conversation.project_id}/${conversation.conversation_id}`,
  });
  await page.set_active_tab("people");
}
