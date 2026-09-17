import { useEffect, useRef } from "react";
import { redux, useTypedRedux } from "@cocalc/frontend/app-framework";

/** Fresh-auth can complete after a component unmounts or the browser changes account. */
export function useBoundAgentAccount() {
  const accountId = useTypedRedux("account", "account_id");
  const originalAccount = useRef(accountId);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return {
    current: accountId === originalAccount.current,
    assertCurrent() {
      if (
        !alive.current ||
        !originalAccount.current ||
        redux.getStore("account")?.get("account_id") !== originalAccount.current
      ) {
        throw new Error(
          "The account changed. Review this action in the current session.",
        );
      }
    },
  };
}
