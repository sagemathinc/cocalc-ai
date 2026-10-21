/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  appOpenURL,
  getProjectAppFrameUrl,
  isProjectHostAppUrl,
  projectAppPathOfUrl,
} from "@cocalc/frontend/project/app-server-open";

// How a card frames apps: never the top window, and popups stay sandboxed
// (allow-same-origin keeps the app's own partitioned session working).
export const APP_CARD_FRAME_SANDBOX =
  "allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads";

// The frame's src: the app on its own origin through a fresh single-use
// frame link (requested here, never taken from the shared artifact record).
// Only on sites without app origins ("off") is the project-host URL framed,
// as before.  Anything else is a failure the card shows (with retry and
// "open in a new tab"), never a fallback to the host origin.  When the framed
// app says it has no session (expired, or the browser blocks partitioned
// cookies), ask once more; then offer the new tab.
export function useAppFrameSrc({
  projectId,
  appId,
  hostUrl,
}: {
  projectId: string;
  appId: string;
  hostUrl?: string;
}): {
  src?: string;
  blocked: boolean;
  failed?: string;
  openUrl?: string;
  retry: () => void;
} {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const path = hostUrl ? projectAppPathOfUrl(projectId, hostUrl) : undefined;
  useEffect(() => {
    if (!hostUrl) return;
    let canceled = false;
    setSrc(undefined);
    setFailed(undefined);
    void (async () => {
      if (!path) {
        setFailed("This app has no address in its project.");
        return;
      }
      const result = await getProjectAppFrameUrl({
        project_id: projectId,
        path,
        app_id: appId,
      });
      if (canceled) return;
      if ("url" in result) {
        setSrc(result.url);
      } else if (
        "unavailable" in result &&
        result.unavailable === "off" &&
        isProjectHostAppUrl(projectId, hostUrl)
      ) {
        setSrc(hostUrl);
      } else {
        setFailed(
          "unavailable" in result
            ? `The app can't be shown here right now (${result.unavailable}).`
            : `The app can't be shown here: ${result.error}`,
        );
      }
    })();
    return () => {
      canceled = true;
    };
  }, [projectId, appId, hostUrl, path, attempt]);
  useEffect(() => {
    if (!src) return;
    let frameOrigin: string;
    try {
      frameOrigin = new URL(src).origin;
    } catch {
      return;
    }
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== frameOrigin) return;
      if (
        event.data?.type !== "cocalc-app-frame" ||
        event.data?.status !== "no-session"
      ) {
        return;
      }
      if (attempt < 1) setAttempt((n) => n + 1);
      else setBlocked(true);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [src, attempt]);
  return {
    src,
    blocked,
    failed,
    openUrl: path ? appOpenURL(projectId, path, appId) : undefined,
    retry: () => {
      setBlocked(false);
      setAttempt((n) => n + 1);
    },
  };
}
