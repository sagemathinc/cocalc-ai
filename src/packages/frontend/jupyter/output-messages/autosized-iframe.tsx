/*
 *  This file is part of CoCalc: Copyright © 2026 Sagemath, Inc.
 *  License: MS-RSL – see LICENSE.md for details
 */

import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { CSSProperties, SyntheticEvent } from "react";

const RESIZE_MESSAGE_TYPE = "cocalc-jupyter-iframe-height";
const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 20;
const HEIGHT_SLACK = 8;

interface Props {
  src?: string;
  srcDoc?: string;
  sandbox?: string;
  style?: CSSProperties;
  title?: string;
  onError?: (event: SyntheticEvent<HTMLIFrameElement>) => void;
}

export default function AutosizedIframe({
  src,
  srcDoc,
  sandbox,
  style,
  title,
  onError,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  const resizeId = `cocalc-jupyter-iframe-${useId()}`;
  const sizedSrcDoc = useMemo(() => {
    return srcDoc == null ? undefined : injectResizeBridge(srcDoc, resizeId);
  }, [resizeId, srcDoc]);

  useEffect(() => {
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
      setHeight(normalizeHeight(data.height));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
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
      src={src}
      srcDoc={sizedSrcDoc}
      sandbox={sandbox}
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

function normalizeHeight(height: number): number {
  if (!Number.isFinite(height)) return DEFAULT_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.ceil(height) + HEIGHT_SLACK);
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
  if (typeof ResizeObserver !== "undefined") {
    var observer = new ResizeObserver(send);
    if (document.documentElement) observer.observe(document.documentElement);
    if (document.body) observer.observe(document.body);
  }
  window.addEventListener("load", send);
  setTimeout(send, 0);
  setTimeout(send, 100);
  setTimeout(send, 500);
  setTimeout(send, 1000);
  setTimeout(send, 2500);
})();
</script>`;
  if (/<\/body\s*>/i.test(srcDoc)) {
    return srcDoc.replace(/<\/body\s*>/i, `${script}</body>`);
  }
  if (/<\/html\s*>/i.test(srcDoc)) {
    return srcDoc.replace(/<\/html\s*>/i, `${script}</html>`);
  }
  return `${srcDoc}${script}`;
}
