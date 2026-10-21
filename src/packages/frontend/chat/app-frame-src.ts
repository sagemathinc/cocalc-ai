/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useState } from "react";
import {
  appOpenURL,
  getProjectAppFrameUrl,
  projectAppPathOfUrl,
} from "@cocalc/frontend/project/app-server-open";

// The frame's src: the app on its own origin through a fresh single-use
// frame link (requested here, never taken from the shared artifact record),
// or the host URL on sites without app origins.  When the framed app says it
// has no session (expired, or the browser blocks partitioned cookies), ask
// once more; then offer to open it in a new tab.
export function useAppFrameSrc({
  projectId,
  appId,
  hostUrl,
}: {
  projectId: string;
  appId: string;
  hostUrl?: string;
}): { src?: string; blocked: boolean; openUrl?: string } {
  const [src, setSrc] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [blocked, setBlocked] = useState(false);
  const path = hostUrl ? projectAppPathOfUrl(projectId, hostUrl) : undefined;
  useEffect(() => {
    if (!hostUrl) return;
    let canceled = false;
    setSrc(undefined);
    void (async () => {
      const url = path
        ? await getProjectAppFrameUrl({
            project_id: projectId,
            path,
            app_id: appId,
          })
        : undefined;
      if (!canceled) setSrc(url ?? hostUrl);
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
    openUrl: path ? appOpenURL(projectId, path, appId) : undefined,
  };
}
