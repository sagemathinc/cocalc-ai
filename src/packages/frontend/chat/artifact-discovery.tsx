import { lazy, Suspense, useState } from "react";
import { Button } from "antd";
import type { ChatActions } from "./actions";
const Browser = lazy(() => import("./artifact-browser"));
const Results = lazy(() =>
  import("./artifact-browser").then((m) => ({ default: m.ArtifactResults })),
);

export function ArtifactBrowserButton({
  actions,
  threadId,
}: {
  actions?: ChatActions;
  threadId?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!actions?.syncdb) return null;
  return (
    <>
      <Button onClick={() => setOpen(true)}>Artifacts</Button>
      {open && (
        <Suspense fallback={<span role="status">Loading artifacts...</span>}>
          <Browser
            actions={actions}
            threadId={threadId}
            onClose={() => setOpen(false)}
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
