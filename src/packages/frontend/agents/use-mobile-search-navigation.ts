import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// Reveal results before handing focus off from the now-hidden mobile sidebar.
export function useMobileSearchNavigation({
  active,
  isNarrow,
  searchOpen,
  searchRun,
  mobileList,
  setMobileList,
  contentRef,
}: {
  active: boolean;
  isNarrow: boolean;
  searchOpen: boolean;
  searchRun: number;
  mobileList: boolean;
  setMobileList: (show: boolean) => void;
  contentRef: RefObject<HTMLElement | null>;
}) {
  const focusPending = useRef(false);
  useEffect(() => {
    focusPending.current = active && isNarrow && searchOpen;
    if (focusPending.current) setMobileList(false);
  }, [active, isNarrow, searchOpen, searchRun, setMobileList]);

  useEffect(() => {
    if (!focusPending.current || mobileList) return;
    focusPending.current = false;
    contentRef.current?.focus();
  }, [mobileList, active, isNarrow, searchOpen, searchRun, contentRef]);
}
