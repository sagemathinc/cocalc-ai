import { USERNAME_CHANGED_EVENT } from "@cocalc/frontend/account/username-events";
import type { UsernameChangedDetail } from "@cocalc/frontend/account/username-events";

/** Qualified labels are separate from canonical resource selections. */
export const closedPersonalUrlState = {
  personal_url: undefined,
  personal_url_status: undefined,
  personal_url_error: undefined,
  personal_url_viewer: undefined,
  personal_url_owner_account_id: undefined,
  personal_url_project_id: undefined,
};

let revision = 0;
let stopWatching: (() => void) | undefined;

export function cancelPersonalUrlNavigation(): number {
  stopWatching?.();
  stopWatching = undefined;
  return ++revision;
}

export function personalUrlNavigationIsCurrent(value: number): boolean {
  return value === revision;
}

export function watchPersonalUrlNavigation(stop: () => void) {
  stopWatching?.();
  stopWatching = stop;
}

const ownerListeners = new Set<(accountId: string) => void>();

export function refreshPersonalUrlOwner(accountId: string): void {
  for (const listener of [...ownerListeners]) listener(accountId);
}

export function onPersonalUrlOwnerChange(
  listener: (accountId: string) => void,
): () => void {
  ownerListeners.add(listener);
  const changed = (event: Event) => {
    const accountId = (event as CustomEvent<UsernameChangedDetail>).detail
      ?.account_id;
    if (accountId) listener(accountId);
  };
  if (typeof window !== "undefined")
    window.addEventListener(USERNAME_CHANGED_EVENT, changed);
  return () => {
    ownerListeners.delete(listener);
    if (typeof window !== "undefined")
      window.removeEventListener(USERNAME_CHANGED_EVENT, changed);
  };
}
