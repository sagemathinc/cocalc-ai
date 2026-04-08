/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "@cocalc/frontend/app-framework";

let unreadIncomingInviteCount = 0;
const listeners = new Set<(count: number) => void>();

export function getUnreadIncomingInviteCount(): number {
  return unreadIncomingInviteCount;
}

export function setUnreadIncomingInviteCount(count: number): void {
  const normalized = Math.max(0, Math.floor(Number(count) || 0));
  if (normalized === unreadIncomingInviteCount) {
    return;
  }
  unreadIncomingInviteCount = normalized;
  for (const listener of listeners) {
    listener(normalized);
  }
}

export function subscribeUnreadIncomingInviteCount(
  cb: (count: number) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useUnreadIncomingInviteCount(): number {
  const [count, setCount] = useState<number>(() =>
    getUnreadIncomingInviteCount(),
  );

  useEffect(() => {
    setCount(getUnreadIncomingInviteCount());
    return subscribeUnreadIncomingInviteCount(setCount);
  }, []);

  return count;
}
