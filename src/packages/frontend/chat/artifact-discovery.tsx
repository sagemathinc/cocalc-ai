import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { ComponentRef } from "react";
import { Button } from "antd";
import { Icon, Tooltip } from "@cocalc/frontend/components";
import type { ChatActions } from "./actions";
import { useChatEmbeddingOptions } from "./embedding-options";
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
  const [opened, setOpened] = useState<{ threadId?: string } | null>(null);
  const { agentWorkspace = false, agentWorkspaceActive } =
    useChatEmbeddingOptions();
  const stale =
    agentWorkspace &&
    (agentWorkspaceActive === false || opened?.threadId !== threadId);
  const open = opened !== null && !stale;
  useEffect(() => {
    // Hidden workspaces stay mounted. Discard their portal without stealing focus.
    if (stale) setOpened(null);
  }, [stale]);
  const triggerRef = useRef<ComponentRef<typeof Button>>(null);
  if (!actions?.syncdb) return null;
  return (
    <>
      <Tooltip title="Browse artifacts">
        <Button
          ref={triggerRef}
          aria-label="Browse artifacts"
          aria-haspopup="dialog"
          aria-expanded={agentWorkspace ? open : undefined}
          size={compact ? "small" : undefined}
          type={compact ? "text" : "default"}
          icon={compact ? <Icon name="files" /> : undefined}
          style={
            compact ? { minWidth: 24, height: 22, padding: "0 4px" } : undefined
          }
          onClick={() =>
            setOpened(agentWorkspace && open ? null : { threadId })
          }
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
              setOpened(null);
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
