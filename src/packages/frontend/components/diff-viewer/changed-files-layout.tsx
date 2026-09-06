import { lazy, Suspense, useId, useState } from "react";
import type { ReactNode, CSSProperties } from "react";
import type { ChangedFilesTreeProps } from "./changed-files-tree";
import "./changed-files-layout.css";

const ChangedFilesTree = lazy(() => import("./changed-files-tree"));

// Keep the renderer mounted when navigation is collapsed or the drawer narrows.
export function ChangedFilesLayout({
  children,
  ...tree
}: ChangedFilesTreeProps & { children: ReactNode }) {
  const [shown, setShown] = useState(true);
  const [width, setWidth] = useState(260);
  const id = useId();
  return (
    <div
      className="cocalc-changed-files-layout"
      style={{ "--review-tree-width": `${width}px` } as CSSProperties}
    >
      <div className="cocalc-changed-files-controls">
        <button
          type="button"
          aria-expanded={shown}
          aria-controls={id}
          onClick={() => setShown(!shown)}
        >
          {shown ? "Hide file tree" : "Show file tree"}
        </button>
        {shown && (
          <label>
            File tree width{" "}
            <input
              type="range"
              min={180}
              max={400}
              step={20}
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
        )}
      </div>
      <div className="cocalc-changed-files-columns" data-tree-visible={shown}>
        <aside id={id} aria-label="Changed-file navigation" hidden={!shown}>
          <Suspense fallback={<div role="status">Loading file tree...</div>}>
            <ChangedFilesTree {...tree} />
          </Suspense>
        </aside>
        <div className="cocalc-changed-files-content">{children}</div>
      </div>
    </div>
  );
}
