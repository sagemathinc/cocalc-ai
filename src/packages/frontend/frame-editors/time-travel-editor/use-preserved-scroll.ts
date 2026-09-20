/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useLayoutEffect, useRef, type UIEvent } from "react";

/** Preserve a scroll container's offset while asynchronously replacing its body. */
export function usePreservedScroll<T>(selection: T, ready: boolean) {
  const elementRef = useRef<HTMLDivElement>(null);
  const scrollTopRef = useRef(0);

  useLayoutEffect(() => {
    if (ready && elementRef.current != null) {
      elementRef.current.scrollTop = scrollTopRef.current;
    }
  }, [ready, selection]);

  const onScroll = (event: UIEvent<HTMLDivElement>) => {
    // Rendering the short loading view may clamp scrollTop to zero. Ignore it.
    if (ready) {
      scrollTopRef.current = event.currentTarget.scrollTop;
    }
  };

  return { elementRef, onScroll };
}
