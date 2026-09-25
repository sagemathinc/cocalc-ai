import { useEffect, useRef } from "react";

/** Explicit UI choices increment this token; history navigation cancels too. */
export function useNavigationIntent(active: boolean, accountId?: string) {
  const token = useRef(0);
  useEffect(() => {
    const cancel = () => {
      token.current++;
    };
    window.addEventListener("popstate", cancel);
    return () => {
      window.removeEventListener("popstate", cancel);
      cancel();
    };
  }, [active, accountId]);
  return token;
}
