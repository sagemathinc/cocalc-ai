/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

// A sign-in session ends at the site's maximum lifetime however much it is
// used. Before that, ask the person to re-enter their password or second
// factor, which starts a new lifetime, so they are never signed out mid-use.

import { Alert, Button } from "antd";
import { useCallback, useEffect, useState } from "react";

import { useTypedRedux } from "@cocalc/frontend/app-framework";
import { FreshAuthModal } from "@cocalc/frontend/auth/fresh-auth";
import { TimeAgo } from "@cocalc/frontend/components";
import { webapp_client } from "@cocalc/frontend/webapp-client";

const REFRESH_MS = 60 * 60_000;

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
  const [lifetime, setLifetime] = useState<SessionLifetime | undefined>();
  const [verifying, setVerifying] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setLifetime(
        await webapp_client.conat_client.hub.system.getSessionLifetime({}),
      );
    } catch {
      // Only a reminder: try again at the next refresh.
    }
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    void refresh();
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [isLoggedIn, refresh]);

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
          await refresh();
        }}
      />
    </>
  );
}
