// Keep the URL literal so Rspack emits a same-origin worker bundle and its
// dependencies. Do not download executable code from a runtime CDN.
export function createHighlightingWorker() {
  return new Worker(
    new URL("@pierre/diffs/worker/worker.js", import.meta.url),
    { type: "module", name: "cocalc-diff-highlighter" },
  );
}
