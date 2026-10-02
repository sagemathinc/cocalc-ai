/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect } from "react";
import { useTypedRedux } from "@cocalc/frontend/app-framework";
import {
  USERNAME_CHANGED_EVENT,
  type UsernameChangedDetail,
} from "@cocalc/frontend/account/username-events";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { setPersonalUrlIdentity } from "./personal-url-identity";

// Keep the personal URL identity current: the account, then its username.
export function usePersonalUrlIdentity(): void {
  const account_id = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  useEffect(() => {
    setPersonalUrlIdentity({ account_id });
    if (!account_id) return;
    let canceled = false;
    webapp_client.conat_client.hub.personalUrls
      ?.getUsername?.({})
      .then((r) => {
        if (!canceled)
          setPersonalUrlIdentity({ account_id, username: r.username });
      })
      .catch(() => {
        // the account id still works as the owner
      });
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<UsernameChangedDetail>).detail;
      if (detail?.account_id === account_id)
        setPersonalUrlIdentity({ account_id, username: detail.username });
    };
    window.addEventListener(USERNAME_CHANGED_EVENT, changed);
    return () => {
      canceled = true;
      window.removeEventListener(USERNAME_CHANGED_EVENT, changed);
    };
  }, [account_id]);
}
