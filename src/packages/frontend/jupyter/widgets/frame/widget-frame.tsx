/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

/*
One widget, rendered in its own opaque frame (see host.ts and relay.ts).

The frame is sandboxed with allow-scripts (and allow-popups, so links open,
as opaque popups), never allow-same-origin, and gets no permission features.
It loads /static/widget-host.html#<nonce>.  The host script there says ready
with the nonce; the first such message from this frame's window, from an
opaque origin, gets the MessagePort to the notebook's relay.  If the frame
ever says ready again or loads another document after that, the port is
closed and the frame is replaced by an error: whatever is in it now isn't the
host this page connected.

Frames exist only near the viewport, and at most MAX_LIVE_FRAMES of them at
once (each runs its own copy of the widget library and models).  A frame that
scrolls far away may be dropped and is recreated from the shared state when
it comes back.
*/

import { Alert } from "antd";
import { useEffect, useMemo, useRef, useState } from "react";
import { appBasePath } from "@cocalc/frontend/customize/app-base-path";
import {
  resolveShellTheme,
  useThemeChanges,
} from "@cocalc/frontend/jupyter/output-messages/frame-theme";
import { joinUrlPath } from "@cocalc/util/url-path";
import { uuid } from "@cocalc/util/misc";
import {
  clampHeight,
  WIDGET_HOST_INIT,
  WIDGET_HOST_PATH,
  WIDGET_HOST_READY,
} from "./protocol";
import type { RelayConnection, WidgetRelay } from "./relay";

export const WIDGET_FRAME_SANDBOX = "allow-scripts allow-popups";
const MAX_LIVE_FRAMES = 20;
const ROOT_MARGIN = "800px";
const DEFAULT_HEIGHT = 40;

export function widgetHostUrl(nonce: string): string {
  return `${joinUrlPath(appBasePath, "static", WIDGET_HOST_PATH)}#${nonce}`;
}

// Live frames, least recently near the viewport first.
interface LiveFrame {
  near: boolean;
  drop: () => void;
}
const liveFrames: LiveFrame[] = [];

function touch(frame: LiveFrame): void {
  const i = liveFrames.indexOf(frame);
  if (i !== -1) liveFrames.splice(i, 1);
  liveFrames.push(frame);
  // Drop the frames longest away from the viewport (never one near it).
  for (const other of [...liveFrames]) {
    if (liveFrames.length <= MAX_LIVE_FRAMES) break;
    if (!other.near && other !== frame) {
      liveFrames.splice(liveFrames.indexOf(other), 1);
      other.drop();
    }
  }
}

function release(frame: LiveFrame): void {
  const i = liveFrames.indexOf(frame);
  if (i !== -1) liveFrames.splice(i, 1);
}

export function WidgetFrame({
  relay,
  model_id,
}: {
  relay: WidgetRelay;
  model_id: string;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [live, setLive] = useState<boolean>(false);
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (wrapper == null) return;
    const frame: LiveFrame = { near: false, drop: () => setLive(false) };
    const observer = new IntersectionObserver(
      (entries) => {
        const near = entries.some((e) => e.isIntersecting);
        frame.near = near;
        if (near) {
          setLive(true);
          touch(frame);
        }
      },
      { rootMargin: ROOT_MARGIN },
    );
    observer.observe(wrapper);
    return () => {
      observer.disconnect();
      release(frame);
    };
  }, []);

  return (
    <div ref={wrapperRef} style={{ minHeight: live ? undefined : height }}>
      {live && (
        <ConnectedFrame
          relay={relay}
          model_id={model_id}
          height={height}
          setHeight={setHeight}
        />
      )}
    </div>
  );
}

function ConnectedFrame({
  relay,
  model_id,
  height,
  setHeight,
}: {
  relay: WidgetRelay;
  model_id: string;
  height: number;
  setHeight: (height: number) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const connectionRef = useRef<RelayConnection | null>(null);
  const loadsRef = useRef<number>(0);
  const [error, setError] = useState<string>("");
  const nonce = useMemo(() => uuid(), []);
  const src = useMemo(() => widgetHostUrl(nonce), [nonce]);

  useEffect(() => {
    const kill = (reason: string) => {
      connectionRef.current?.close();
      setError(reason);
    };
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (iframe == null || event.source !== iframe.contentWindow) return;
      const data = event.data;
      if (data?.type !== WIDGET_HOST_READY) return;
      if (event.origin !== "null" || data.nonce !== nonce) {
        kill("The widget frame isn't the widget host.");
        return;
      }
      if (connectionRef.current != null) {
        kill("The widget frame restarted.");
        return;
      }
      const channel = new MessageChannel();
      // At most one height update per animation frame.
      let pendingHeight: number | undefined = undefined;
      connectionRef.current = relay.connect(channel.port1, model_id, (h) => {
        const first = pendingHeight == null;
        pendingHeight = h;
        if (!first) return;
        requestAnimationFrame(() => {
          const clamped = clampHeight(pendingHeight);
          pendingHeight = undefined;
          if (clamped != null) setHeight(clamped);
        });
      });
      (event.source as Window).postMessage(
        {
          type: WIDGET_HOST_INIT,
          nonce,
          model_id,
          theme: resolveShellTheme(iframe),
        },
        "*",
        [channel.port2],
      );
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      connectionRef.current?.close();
      connectionRef.current = null;
    };
  }, [relay, model_id, nonce]);

  useThemeChanges(() => {
    const iframe = iframeRef.current;
    if (iframe != null)
      connectionRef.current?.setTheme(resolveShellTheme(iframe));
  });

  if (error) {
    return <Alert type="error" showIcon title={error} style={{ margin: 15 }} />;
  }
  return (
    <iframe
      ref={iframeRef}
      src={src}
      sandbox={WIDGET_FRAME_SANDBOX}
      referrerPolicy="no-referrer"
      title="Jupyter widget"
      onLoad={() => {
        // The frame loads one document, the host's (its src is set before
        // it is inserted, so there is no initial about:blank load); any later
        // load is another document, whether or not the host has said ready.
        loadsRef.current += 1;
        if (loadsRef.current > 1) {
          connectionRef.current?.close();
          setError("The widget frame navigated away.");
        }
      }}
      style={{ border: 0, width: "100%", display: "block", height }}
    />
  );
}
