import { useLayoutEffect, useState } from "react";
import type { ReactNode } from "react";
import { WorkerPoolContextProvider, useWorkerPool } from "@pierre/diffs/react";
import type {
  WorkerInitializationRenderOptions,
  WorkerPoolOptions,
} from "@pierre/diffs/react";
import { createHighlightingWorker } from "./highlighting-worker";

const poolOptions: WorkerPoolOptions = {
  workerFactory: () => {
    const worker = createHighlightingWorker();
    // The pool handles this event and reports fallback through WorkerHealth.
    // Suppress only the browser's additional uncaught worker-error report;
    // do not stop propagation to the pool's own failure/cleanup listener.
    worker.addEventListener("error", (event) => event.preventDefault());
    return worker;
  },
  poolSize: 2,
  workerInitializationTimeout: 5000,
  // This is an entry limit per file/diff cache, not a byte limit. Keep the
  // existing bounded review input limits; measure retained AST memory too.
  totalASTLRUCacheSize: 16,
};
const highlighterOptions: WorkerInitializationRenderOptions = {
  theme: { light: "github-light", dark: "github-dark" },
  preferredHighlighter: "shiki-js",
  lineDiffType: "word",
  tokenizeMaxLineLength: 1000,
  maxLineDiffLength: 1000,
};

function WorkerHealth() {
  const pool = useWorkerPool();
  const [failed, setFailed] = useState(false);
  useLayoutEffect(() => {
    setFailed(pool?.getStats().workersFailed ?? false);
    // In 1.4.1 the constructor starts initialization without returning its
    // inner promise. Observe that pending promise before workers can fail.
    void pool?.initialize().catch(() => {});
    return pool?.subscribeToStatChanges((stats) =>
      setFailed(stats.workersFailed),
    );
  }, [pool]);
  return failed ? (
    <div role="status">
      Background diff highlighting is unavailable; using the renderer's
      fallback.
    </div>
  ) : null;
}

// Pierre shares one pool across all mounted providers and terminates it when
// the final consumer unmounts. Never allocate a pool per file or activity event.
export function DiffHighlightingProvider({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <WorkerPoolContextProvider
      poolOptions={poolOptions}
      highlighterOptions={highlighterOptions}
    >
      <WorkerHealth />
      {children}
    </WorkerPoolContextProvider>
  );
}
