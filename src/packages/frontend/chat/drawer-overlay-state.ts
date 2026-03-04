/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "@cocalc/frontend/app-framework";

const openOverlayIds = new Set<string>();
const listeners = new Set<(open: boolean) => void>();

function notify() {
  const open = openOverlayIds.size > 0;
  for (const listener of listeners) {
    listener(open);
  }
}

export function setChatOverlayOpen(id: string, open: boolean): void {
  const key = `${id ?? ""}`.trim();
  if (!key) return;
  const had = openOverlayIds.has(key);
  if (open && !had) {
    openOverlayIds.add(key);
    notify();
    return;
  }
  if (!open && had) {
    openOverlayIds.delete(key);
    notify();
  }
}

export function isAnyChatOverlayOpen(): boolean {
  return openOverlayIds.size > 0;
}

export function subscribeAnyChatOverlayOpen(
  listener: (open: boolean) => void,
): () => void {
  listeners.add(listener);
  listener(isAnyChatOverlayOpen());
  return () => {
    listeners.delete(listener);
  };
}

export function useAnyChatOverlayOpen(): boolean {
  const [open, setOpen] = useState<boolean>(isAnyChatOverlayOpen());
  useEffect(() => subscribeAnyChatOverlayOpen(setOpen), []);
  return open;
}
