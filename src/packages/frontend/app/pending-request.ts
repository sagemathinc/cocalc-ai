/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// Ask a page to do something (open a dialog, focus a search box) when it
// may not be mounted yet: the request is kept until a handler takes it.
export function pendingRequest(name: string) {
  const event = `cocalc:request:${name}`;
  let requested = false;
  return {
    request(): void {
      requested = true;
      window.dispatchEvent(new Event(event));
    },
    // Runs `handle` now if a request is pending, and for later requests.
    // Returns the unsubscribe function (a useEffect cleanup).
    on(handle: () => void): () => void {
      const take = () => {
        if (!requested) return;
        requested = false;
        handle();
      };
      take();
      window.addEventListener(event, take);
      return () => window.removeEventListener(event, take);
    },
  };
}
