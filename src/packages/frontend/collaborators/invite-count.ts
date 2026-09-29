/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "@cocalc/frontend/app-framework";

let unreadIncomingInviteAccountId: string | undefined;
let unreadIncomingInviteCount = 0;
let unreadIncomingInviteRefresh = 0;
const listeners = new Set<(count: number) => void>();

export function getUnreadIncomingInviteCount(account_id?: string): number {
  return account_id != null && account_id === unreadIncomingInviteAccountId
    ? unreadIncomingInviteCount
    : 0;
}

function publishUnreadIncomingInviteCount(
  account_id: string | undefined,
  count: number,
): void {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  if (
    account_id === unreadIncomingInviteAccountId &&
    normalized === unreadIncomingInviteCount
  ) {
    return;
  }
  unreadIncomingInviteAccountId = account_id;
  unreadIncomingInviteCount = normalized;
  for (const listener of listeners) {
    listener(normalized);
  }
}

export function beginUnreadIncomingInviteCountRefresh(
  account_id: string,
): number {
  unreadIncomingInviteRefresh += 1;
  if (account_id !== unreadIncomingInviteAccountId) {
    publishUnreadIncomingInviteCount(account_id, 0);
  }
  return unreadIncomingInviteRefresh;
}

export function setUnreadIncomingInviteCount(
  account_id: string | undefined,
  count: number,
  refresh?: number,
): void {
  if (
    refresh != null &&
    (refresh !== unreadIncomingInviteRefresh ||
      account_id !== unreadIncomingInviteAccountId)
  ) {
    return;
  }
  if (refresh == null) {
    unreadIncomingInviteRefresh += 1;
  }
  publishUnreadIncomingInviteCount(account_id, count);
}

export function subscribeUnreadIncomingInviteCount(
  cb: (count: number) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useUnreadIncomingInviteCount(account_id?: string): number {
  const [count, setCount] = useState<number>(() =>
    getUnreadIncomingInviteCount(account_id),
  );

  useEffect(() => {
    const update = () => setCount(getUnreadIncomingInviteCount(account_id));
    update();
    return subscribeUnreadIncomingInviteCount(update);
  }, [account_id]);

  return count;
}
