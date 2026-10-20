/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, SyntheticEvent } from "react";

const RESIZE_MESSAGE_TYPE = "cocalc-jupyter-iframe-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 20;
// Content can ask for any height (and the resize id is not a secret from
// it), so heights are capped and resize messages are rate limited.
const MAX_HEIGHT = 25000;
const MIN_RESIZE_INTERVAL_MS = 50;
const HEIGHT_SLACK = 8;

/*
What a frame's content may do.  Every caller must choose; there is no
default.

- passive: no scripts at all (sandbox="").
- opaque-scripts: scripts in an opaque origin, nothing else.
- opaque-legacy: scripts, forms and presentation in an opaque origin.  This is
  what untrusted Jupyter output has always used; tighten it to
  opaque-scripts once measured.
- trusted-same-origin: no sandbox, so the content runs with this page's
  origin.  Only for content the user explicitly trusts.

No profile ever combines allow-scripts with allow-same-origin, which would let
the content remove its own sandbox.
*/
export type IframeProfile =
  | "passive"
  | "opaque-scripts"
  | "opaque-legacy"
  | "trusted-same-origin";

const SANDBOX: Record<IframeProfile, string | undefined> = {
  passive: "",
  "opaque-scripts": "allow-scripts",
  "opaque-legacy": "allow-forms allow-scripts allow-presentation",
  "trusted-same-origin": undefined,
};

export function iframeSandbox(profile: IframeProfile): string | undefined {
  return SANDBOX[profile];
}

interface Props {
  src?: string;
  srcDoc?: string;
  profile: IframeProfile;
  style?: CSSProperties;
  title?: string;
  onError?: (event: SyntheticEvent<HTMLIFrameElement>) => void;
  // Called with the iframe after each load of its document (e.g., to post
  // content to it).
  onLoad?: (iframe: HTMLIFrameElement) => void;
}

export default function AutosizedIframe({
  src,
  srcDoc,
  profile,
  style,
  title,
  onError,
  onLoad,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  const resizeId = `cocalc-jupyter-iframe-${useId()}`;
  const sandbox = iframeSandbox(profile);
  const lastResizeRef = useRef<number>(0);
  const sizedSrcDoc = useMemo(() => {
    return srcDoc == null ? undefined : injectResizeBridge(srcDoc, resizeId);
  }, [resizeId, srcDoc]);

  useEffect(() => {
    // At most one resize per interval; a request inside the interval is
    // applied at its end (only the latest one), never dropped, so the frame
    // ends at the content's final height.
    let pending: number | undefined = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined = undefined;
    const apply = () => {
      timer = undefined;
      if (pending == null) return;
      lastResizeRef.current = Date.now();
      setHeight(normalizeHeight(pending));
      pending = undefined;
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const data = event.data;
      if (
        data?.type !== RESIZE_MESSAGE_TYPE ||
        data?.id !== resizeId ||
        typeof data?.height !== "number"
      ) {
        return;
      }
      pending = data.height;
      if (timer != null) return;
      const wait = lastResizeRef.current + MIN_RESIZE_INTERVAL_MS - Date.now();
      if (wait <= 0) {
        apply();
      } else {
        timer = setTimeout(apply, wait);
      }
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (timer != null) clearTimeout(timer);
    };
  }, [resizeId]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe == null) return;

    setHeight(DEFAULT_HEIGHT);
    let observer: ResizeObserver | undefined = undefined;
    let mounted = true;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    const measure = () => {
      if (!mounted) return;
      try {
        const doc = iframe.contentWindow?.document;
        if (doc == null) return;
        setHeight(measureDocumentHeight(doc));
        if (observer == null && typeof ResizeObserver != "undefined") {
          observer = new ResizeObserver(() =>
            setHeight(measureDocumentHeight(doc)),
          );
          if (doc.documentElement != null)
            observer.observe(doc.documentElement);
          if (doc.body != null) observer.observe(doc.body);
        }
      } catch (_err) {
        // Sandboxed public output intentionally blocks parent-side inspection.
        // In that case injected srcDoc code reports height via postMessage.
      }
    };

    iframe.addEventListener("load", measure);
    measure();
    for (const delay of [25, 100, 500, 1000, 2500]) {
      timeouts.push(setTimeout(measure, delay));
    }

    return () => {
      mounted = false;
      iframe.removeEventListener("load", measure);
      observer?.disconnect();
      for (const timeout of timeouts) clearTimeout(timeout);
    };
  }, [src, srcDoc]);

  return (
    <iframe
      ref={iframeRef}
      onLoad={(event) => onLoad?.(event.currentTarget)}
      src={src}
      srcDoc={sizedSrcDoc}
      sandbox={sandbox}
      referrerPolicy={
        profile === "trusted-same-origin" ? undefined : "no-referrer"
      }
      title={title}
      onError={onError}
      style={{
        border: 0,
        width: "100%",
        display: "block",
        ...style,
        height,
      }}
    />
  );
}

function measureDocumentHeight(doc: Document, depth = 0): number {
  resizeAccessibleChildIframes(doc, depth);
  const body = doc.body;
  const bodyHeight = body == null ? 0 : measureElementHeight(body);
  if (bodyHeight > 0) {
    return normalizeHeight(bodyHeight);
  }
  const documentElement = doc.documentElement;
  return normalizeHeight(
    documentElement == null ? 0 : measureElementHeight(documentElement),
  );
}

function measureElementHeight(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  const viewportHeight = element.ownerDocument.defaultView?.innerHeight ?? 0;
  const boxHeight = Math.max(element.offsetHeight, rect.height);
  const scrollHeight = element.scrollHeight;
  const contentHeight =
    scrollHeight > boxHeight && Math.abs(scrollHeight - viewportHeight) > 1
      ? scrollHeight
      : boxHeight;
  const marginTop = parseFloat(style?.marginTop ?? "0") || 0;
  const marginBottom = parseFloat(style?.marginBottom ?? "0") || 0;
  return contentHeight + marginTop + marginBottom;
}

function resizeAccessibleChildIframes(doc: Document, depth: number): void {
  if (depth >= 3) return;
  for (const iframe of Array.from(doc.querySelectorAll("iframe"))) {
    try {
      const childDoc = iframe.contentWindow?.document;
      if (childDoc == null) continue;
      iframe.style.height = `${measureDocumentHeight(childDoc, depth + 1)}px`;
      if (!iframe.style.width && !iframe.getAttribute("width")) {
        iframe.style.width = "100%";
      }
    } catch (_err) {
      // Cross-origin child iframes keep their own dimensions.
    }
  }
}

// For a static document (notebook export), which has no React to listen for
// the bridge's height messages: sizes each frame from the messages its own
// window sends, with the same cap.  (Unlike the app, no rate limit is needed:
// the exported document is the user's to view.)
export const STATIC_RESIZE_LISTENER = `<script>
window.addEventListener("message", function (event) {
  var data = event.data;
  if (!data || data.type !== ${JSON.stringify(RESIZE_MESSAGE_TYPE)} || typeof data.height !== "number" || !isFinite(data.height)) return;
  var frames = document.getElementsByTagName("iframe");
  for (var i = 0; i < frames.length; i++) {
    if (frames[i].contentWindow === event.source) {
      frames[i].style.height = Math.min(${MAX_HEIGHT}, Math.max(${MIN_HEIGHT}, Math.ceil(data.height) + ${HEIGHT_SLACK})) + "px";
    }
  }
});
</script>`;

function normalizeHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_HEIGHT;
  return Math.min(
    MAX_HEIGHT,
    Math.max(MIN_HEIGHT, Math.ceil(height) + HEIGHT_SLACK),
  );
}

function injectResizeBridge(srcDoc: string, resizeId: string): string {
  const script = `<script>
(function () {
  var id = ${JSON.stringify(resizeId)};
  function height() {
    resizeChildIframes(document, 0);
    var body = document.body;
    var doc = document.documentElement;
    var bodyHeight = body ? elementHeight(body) : 0;
    return bodyHeight > 0 ? bodyHeight : (doc ? elementHeight(doc) : 0);
  }
  function elementHeight(element) {
    var rect = element.getBoundingClientRect();
    var win = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView : window;
    var style = win.getComputedStyle(element);
    var viewportHeight = win.innerHeight || 0;
    var boxHeight = Math.max(element.offsetHeight || 0, rect.height || 0);
    var scrollHeight = element.scrollHeight || 0;
    var contentHeight = scrollHeight > boxHeight && Math.abs(scrollHeight - viewportHeight) > 1 ? scrollHeight : boxHeight;
    var marginTop = parseFloat(style.marginTop || "0") || 0;
    var marginBottom = parseFloat(style.marginBottom || "0") || 0;
    return contentHeight + marginTop + marginBottom;
  }
  function resizeChildIframes(doc, depth) {
    if (depth >= 3) return;
    var iframes = doc.querySelectorAll("iframe");
    for (var i = 0; i < iframes.length; i++) {
      try {
        var iframe = iframes[i];
        var childDoc = iframe.contentWindow && iframe.contentWindow.document;
        if (!childDoc) continue;
        resizeChildIframes(childDoc, depth + 1);
        var childBody = childDoc.body;
        var childElement = childDoc.documentElement;
        var childBodyHeight = childBody ? elementHeight(childBody) : 0;
        iframe.style.height = (childBodyHeight > 0 ? childBodyHeight : (childElement ? elementHeight(childElement) : 0)) + "px";
        if (!iframe.style.width && !iframe.getAttribute("width")) {
          iframe.style.width = "100%";
        }
      } catch (err) {}
    }
  }
  function send() {
    parent.postMessage({ type: ${JSON.stringify(RESIZE_MESSAGE_TYPE)}, id: id, height: height() }, "*");
  }
  // This runs first, before the content (and its body) is parsed.
  var observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(send) : null;
  if (observer && document.documentElement) observer.observe(document.documentElement);
  document.addEventListener("DOMContentLoaded", function () {
    if (observer && document.body) observer.observe(document.body);
    send();
  });
  window.addEventListener("load", send);
  setTimeout(send, 0);
  setTimeout(send, 100);
  setTimeout(send, 500);
  setTimeout(send, 1000);
  setTimeout(send, 2500);
})();
</script>`;
  // Prepended, never inserted: finding a place inside the content would mean
  // parsing it like the browser does ("</body>" may be inside a script).  The
  // parser keeps this in the head and merges a later <html>'s attributes, and
  // an iframe srcdoc document is never in quirks mode, so a later doctype
  // changes nothing.
  return `${script}${srcDoc}`;
}
