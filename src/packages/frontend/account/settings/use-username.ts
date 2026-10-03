/*
 * This file is part of CoCalc: Copyright (c) 2026 Sagemath, Inc.
 * License: MS-RSL - see LICENSE.md for details
 */

import { useEffect, useRef, useState } from "react";
import type { AccountUsername } from "@cocalc/conat/hub/api/personal-urls";

import { isCurrentUsernameSession } from "./username-session";
import type { UsernameSession } from "./username-session";

export function useUsername(session: UsernameSession, ownerAccountId?: string) {
  const [info, setInfo] = useState<AccountUsername>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function isCurrent() {
    return mounted.current && isCurrentUsernameSession(session);
  }

  useEffect(() => {
    let cancelled = false;
    if (!isCurrent()) {
      setLoading(false);
      setError("Sign in to manage personal URLs.");
      return;
    }
    setLoading(true);
    setError("");
    void (async () => {
      try {
        const next = await session.client.hub.personalUrls.getUsername(
          ownerAccountId == null ? {} : { owner_account_id: ownerAccountId },
        );
        if (cancelled || !isCurrent()) return;
        if (next.account_id !== (ownerAccountId ?? session.accountId)) {
          throw Error("Username response belongs to a different account.");
        }
        setInfo(next);
      } catch (err) {
        if (!cancelled && isCurrent()) setError(`${err}`);
      } finally {
        if (!cancelled && isCurrent()) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session, ownerAccountId, revision]);

  function reload() {
    if (!isCurrent()) return;
    setLoading(true);
    setRevision((value) => value + 1);
  }

  return { info, setInfo, loading, error, reload, isCurrent };
}
