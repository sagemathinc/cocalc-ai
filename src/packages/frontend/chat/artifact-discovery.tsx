import { lazy, Suspense, useRef, useState } from "react";
import type { ComponentRef } from "react";
import { Button } from "antd";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import type { ChatActions } from "./actions";
const Browser = lazy(() => import("./artifact-browser"));
const Results = lazy(() =>
  import("./artifact-browser").then((m) => ({ default: m.ArtifactResults })),
);

export function ArtifactBrowserButton({
  actions,
  threadId,
  compact = false,
}: {
  actions?: ChatActions;
  threadId?: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<ComponentRef<typeof Button>>(null);
  if (!actions?.syncdb) return null;
  return (
    <>
      <Tooltip title="Browse artifacts">
        <Button
          ref={triggerRef}
          aria-label="Browse artifacts"
          aria-haspopup="dialog"
          size={compact ? "small" : undefined}
          type={compact ? "text" : "default"}
          icon={compact ? <Icon name="files" /> : undefined}
          style={
            compact ? { minWidth: 24, height: 22, padding: "0 4px" } : undefined
          }
          onClick={() => setOpen(true)}
        >
          {compact ? null : "Artifacts"}
        </Button>
      </Tooltip>
      {open && (
        <Suspense fallback={<span role="status">Loading artifacts...</span>}>
          <Browser
            actions={actions}
            threadId={threadId}
            onClose={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          />
        </Suspense>
      )}
    </>
  );
}

export function ArtifactSearchResults({
  actions,
  threadId,
  query,
}: {
  actions?: ChatActions;
  threadId?: string;
  query: string;
}) {
  if (!actions?.syncdb || !query.trim()) return null;
  return (
    <div style={{ maxHeight: "40vh", overflowY: "auto" }}>
      <Suspense fallback={<span role="status">Searching artifacts...</span>}>
        <Results actions={actions} threadId={threadId} query={query} />
      </Suspense>
    </div>
  );
}

export { Browser as ArtifactBrowserModal };
