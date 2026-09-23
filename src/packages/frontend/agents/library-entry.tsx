import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Alert, Button } from "antd";
import type { NamedAgent } from "@cocalc/conat/agents/personal";
import type { CatalogEntry } from "@cocalc/conat/hub/api/artifact-catalog";
import type { ForeignArtifactTarget } from "@cocalc/frontend/frame-editors/chat-editor/foreign-artifact-source";
import { webapp_client } from "@cocalc/frontend/webapp-client";
import { LibraryArtifactView } from "./library-artifact-view";

interface Props {
  accountId: string;
  projectId: string;
  entryId: string;
  agents: NamedAgent[];
  onBack: () => void;
  onShowConversation: (target: ForeignArtifactTarget) => Promise<void>;
  navigation?: ReactNode;
}

export function LibraryEntry(props: Props) {
  // A route/account change must discard old content before the next paint.
  return (
    <ResolvedLibraryEntry
      key={JSON.stringify([props.accountId, props.projectId, props.entryId])}
      {...props}
    />
  );
}

function ResolvedLibraryEntry({
  projectId,
  entryId,
  agents,
  onBack,
  onShowConversation,
  navigation,
}: Props) {
  const [entry, setEntry] = useState<CatalogEntry>();
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let disposed = false;
    setEntry(undefined);
    setError("");
    void webapp_client.conat_client.hub.artifactCatalog
      .getEntry({ project_id: projectId, entry_id: entryId })
      .then((value) => {
        if (disposed) return;
        if (!value) throw Error("This artifact is no longer in the catalog.");
        if (value.project_id !== projectId || value.entry_id !== entryId)
          throw Error("The catalog returned a different artifact.");
        setEntry(value);
      })
      .catch((err) => {
        if (!disposed) setError(String(err));
      });
    return () => {
      disposed = true;
    };
  }, [projectId, entryId, retry]);

  if (!entry) {
    return (
      <section aria-label="Library artifact" style={{ padding: 16 }}>
        <Button type="text" onClick={onBack}>
          Back to Library
        </Button>
        {error ? (
          <Alert
            role="alert"
            type="warning"
            title="Artifact unavailable"
            description={error}
            action={
              <Button onClick={() => setRetry((n) => n + 1)}>Retry</Button>
            }
          />
        ) : (
          <div role="status">Loading artifact...</div>
        )}
      </section>
    );
  }
  const agent = agents.find(
    (candidate) =>
      candidate.endpoint.project_id === entry.project_id &&
      candidate.path === entry.chat_path &&
      candidate.thread_id === entry.item.thread_id,
  );
  const target: ForeignArtifactTarget = {
    projectId: entry.project_id,
    path: entry.chat_path,
    threadId: entry.item.thread_id,
    artifactId: entry.item.artifact_id,
    agentId: agent?.endpoint.agent_id,
  };
  return (
    <LibraryArtifactView
      navigation={navigation}
      target={target}
      onBack={onBack}
      onShowConversation={() => onShowConversation(target)}
    />
  );
}
