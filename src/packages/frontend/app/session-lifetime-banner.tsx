/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A sign-in session ends at the site's maximum lifetime however much it is
// used. Before that, ask the person to re-enter their password or second
// factor, which starts a new lifetime, so they are never signed out mid-use.

import { Alert, Button } from "antd";
import { useCallback, useEffect, useRef, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { postAuthApi } from "@cocalc/frontend/auth/api";
import { FreshAuthModal } from "@cocalc/frontend/auth/fresh-auth";
import { getControlPlaneOrigin } from "@cocalc/frontend/control-plane-origin";
import { TimeAgo } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const REFRESH_MS = 60 * 60_000;
// Browsers keep the sign-in cookie 400 days from when it was last set.
const COOKIE_REFRESH_MS = 24 * 60 * 60_000;

type SessionLifetime = {
  max_expire?: string;
  warn_before_ms: number;
  renewable: boolean;
};

export function sessionLifetimeWarningDue(
  lifetime: SessionLifetime | undefined,
  now = Date.now(),
): boolean {
  if (!lifetime?.renewable || !lifetime.max_expire) return false;
  const end = new Date(lifetime.max_expire).valueOf();
  return Number.isFinite(end) && now >= end - lifetime.warn_before_ms;
}

export function SessionLifetimeBanner() {
  const isLoggedIn = !!useTypedRedux("account", "is_logged_in");
  const accountId = useTypedRedux("account", "account_id") as
    | string
    | undefined;
  const [lifetime, setLifetime] = useState<SessionLifetime | undefined>();
  const [verifying, setVerifying] = useState(false);
  // Only the latest request's answer is shown: an earlier one (for an
  // earlier account, or an hourly refresh overtaken by the one after "Stay
  // signed in") is dropped.
  const latestRequest = useRef(0);
  const cookieRefreshedAt = useRef(0);
  const cookieRefreshing = useRef(false);

  const refreshCookie = useCallback(async (force = false) => {
    if (cookieRefreshing.current) return;
    if (!force && Date.now() - cookieRefreshedAt.current < COOKIE_REFRESH_MS)
      return;
    cookieRefreshing.current = true;
    try {
      // The auth origin of this account's home bay, as for fresh auth: only
      // it has this session.
      const result = await postAuthApi<{ refreshed?: boolean }>({
        endpoint: "auth/refresh-session-cookie",
        body: {},
        origin: getControlPlaneOrigin(),
      });
      // Not refreshed: try again at the next hourly refresh.
      cookieRefreshedAt.current = result?.refreshed === true ? Date.now() : 0;
    } catch {
      cookieRefreshedAt.current = 0;
    } finally {
      cookieRefreshing.current = false;
    }
  }, []);

  const refresh = useCallback(async () => {
    const request = ++latestRequest.current;
    let next: SessionLifetime | undefined;
    try {
      next = await webapp_client.conat_client.hub.system.getSessionLifetime({});
    } catch {
      // Only a reminder: show nothing rather than an old deadline, and try
      // again at the next refresh.
      next = undefined;
    }
    if (request !== latestRequest.current) return;
    setLifetime(next);
    // An active browser keeps its cookie as long as the server keeps the
    // session (impersonation sessions are not renewable and keep theirs).
    if (next?.renewable) void refreshCookie();
  }, [refreshCookie]);

  useEffect(() => {
    latestRequest.current += 1;
    setLifetime(undefined);
    setVerifying(false);
    cookieRefreshedAt.current = 0;
    if (!isLoggedIn) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [isLoggedIn, accountId, refresh]);

  if (!isLoggedIn || !sessionLifetimeWarningDue(lifetime)) {
    return null;
  }

  return (
    <>
      <Alert
        type="info"
        showIcon
        banner
        style={{ marginBottom: "10px", paddingBlock: "6px" }}
        title={
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: "12px",
              flexWrap: "wrap",
              width: "100%",
            }}
          >
            <span>
              Your sign-in on this browser ends{" "}
              <TimeAgo date={lifetime!.max_expire!} />. Confirm it's you to stay
              signed in.
            </span>
            <Button
              size="small"
              type="primary"
              onClick={() => setVerifying(true)}
            >
              Stay signed in
            </Button>
          </div>
        }
      />
      <FreshAuthModal
        open={verifying}
        onCancel={() => setVerifying(false)}
        onSuccess={async () => {
          setVerifying(false);
          // The session now lasts longer: so must the cookie.
          await refreshCookie(true);
          await refresh();
        }}
      />
    </>
  );
}
