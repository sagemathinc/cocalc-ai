/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useSyncExternalStore } from "react";
import { webapp_client } from "@cocalc/frontend/webapp-client";

export interface UsernameSession {
  key: number;
  accountId?: string;
  client: typeof webapp_client.conat_client;
}

let snapshot: UsernameSession | undefined;
let nextKey = 0;
const listeners = new Set<() => void>();
const events = ["signed_in", "connected"];
const invalidationEvents = ["signed_out", "remember_me_failed"];

function getSession(): UsernameSession {
  const client = webapp_client.conat_client;
  const accountId =
    client.is_signed_in() &&
    client.signedInMessage?.account_id === webapp_client.account_id
      ? webapp_client.account_id
      : undefined;
  if (
    snapshot == null ||
    snapshot.client !== client ||
    snapshot.accountId !== accountId
  ) {
    snapshot = {
      key: ++nextKey,
      accountId,
      client,
    };
  }
  return snapshot;
}

function authChanged() {
  // Read each transition synchronously, including switches batched by React.
  getSession();
  for (const listener of listeners) listener();
}

function authInvalidated() {
  // Even A -> signed out -> A invalidates work from the earlier session.
  snapshot = undefined;
  authChanged();
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) {
    for (const event of events) webapp_client.on(event, authChanged);
    for (const event of invalidationEvents)
      webapp_client.on(event, authInvalidated);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      for (const event of events)
        webapp_client.removeListener(event, authChanged);
      for (const event of invalidationEvents)
        webapp_client.removeListener(event, authInvalidated);
    }
  };
}

export function useUsernameSession(): UsernameSession {
  return useSyncExternalStore(subscribe, getSession, getSession);
}

export function isCurrentUsernameSession(session: UsernameSession): boolean {
  return !!session.accountId && getSession() === session;
}
